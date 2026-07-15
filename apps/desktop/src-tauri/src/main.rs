// NorthKeep desktop shell: spawns the local Node UI server, reads the
// tokened URL it announces on stdout, and opens a native window there.
// All product logic lives in the web/API layer — this stays a dumb window.
//
// Two spawn modes (ADR 0012):
//  - dev (debug_assertions): system `node` + the workspace build, with the
//    NORTHKEEP_SERVER_JS override for tests. Unchanged from before.
//  - release: the bundled Node sidecar (Contents/MacOS/northkeep-server,
//    placed by tauri's externalBin) running the staged server tree in
//    Contents/Resources. NORTHKEEP_SERVER_JS is compiled out — a signed app
//    must not execute arbitrary script paths handed to it via environment.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Arc<Mutex<Option<Child>>>);

/// Set when the app is quitting on purpose, so the child watcher doesn't
/// mistake our own shutdown for a server crash.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Dev: system `node` on the workspace build (or NORTHKEEP_SERVER_JS).
#[cfg(debug_assertions)]
fn server_command(_app: &tauri::App) -> Command {
    let server_js: std::path::PathBuf = match std::env::var("NORTHKEEP_SERVER_JS") {
        Ok(p) => p.into(),
        Err(_) => std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/dist/server.js")
            .canonicalize()
            .expect("apps/web is not built — run: pnpm build"),
    };
    let mut cmd = Command::new("node");
    cmd.arg(server_js);
    cmd
}

/// Release: the bundled sidecar on the bundled server tree.
///
/// The sidecar is a sibling of this executable (Contents/MacOS/) because
/// that is where tauri's externalBin puts it; the server tree lives under
/// the resource dir (Contents/Resources/server/). No `--jitless`: verified
/// 2026-07-11 that it disables WebAssembly and thereby Node's fetch()
/// (undici), silently breaking the Ollama probe — see ADR 0012.
#[cfg(not(debug_assertions))]
fn server_command(app: &tauri::App) -> Command {
    let sidecar = std::env::current_exe()
        .expect("cannot locate the NorthKeep executable")
        .parent()
        .expect("executable has no parent directory")
        .join("northkeep-server");
    let server_js = app
        .path()
        .resource_dir()
        .expect("app bundle has no resource directory")
        .join("server/dist/server.js");
    let mut cmd = Command::new(sidecar);
    cmd.arg(server_js);
    cmd
}

/// SIGTERM first so the server can run its lock/zeroization path, then
/// SIGKILL after ~2 s as the backstop (ADR 0012, shutdown semantics).
fn stop_server(child: &mut Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The server died under us: tell the user natively, then quit — never leave
/// a dead window up. (osascript keeps us dependency-free on macOS.)
fn report_server_death(code: Option<i32>) {
    let detail = match code {
        Some(c) => format!("exit code {c}"),
        None => "killed by a signal".to_string(),
    };
    eprintln!("northkeep-server exited unexpectedly ({detail})");
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!(
                "display alert \"NorthKeep stopped\" message \"The NorthKeep server exited unexpectedly ({detail}). Please reopen the app.\" as critical giving up after 30"
            ))
            .status();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let mut child = server_command(app)
                // Tell the server it is running inside the desktop shell, so the
                // web UI opens external links via /api/open (WKWebView won't open
                // target=_blank in a new browser) instead of a dead new-tab.
                .env("NORTHKEEP_DESKTOP", "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("could not start the NorthKeep server");

            // The tokened URL travels only over this private pipe (ADR 0004).
            let stdout = child.stdout.take().expect("no stdout from server");
            let mut url = None;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("NORTHKEEP_UI_URL=") {
                    url = Some(rest.to_string());
                    break;
                }
            }
            let Some(url) = url else {
                // Server died (or closed stdout) before announcing — tell
                // the user natively instead of vanishing without a trace.
                let status = child.wait().ok().and_then(|s| s.code());
                report_server_death(status);
                std::process::exit(1);
            };

            let slot = Arc::new(Mutex::new(Some(child)));
            app.manage(ServerProcess(slot.clone()));

            // Watch for the child dying while the app is still running.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if SHUTTING_DOWN.load(Ordering::SeqCst) {
                    break;
                }
                let mut guard = slot.lock().unwrap();
                let Some(child) = guard.as_mut() else { break };
                if let Ok(Some(status)) = child.try_wait() {
                    guard.take();
                    drop(guard);
                    if !SHUTTING_DOWN.load(Ordering::SeqCst) {
                        report_server_death(status.code());
                        handle.exit(1);
                    }
                    break;
                }
            });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("NorthKeep")
                .inner_size(1020.0, 740.0)
                .min_inner_size(560.0, 480.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building NorthKeep")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // The server holds the vault key in memory — take it down
                // with us, giving it a moment to lock first.
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                if let Some(state) = app.try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        stop_server(&mut child);
                    }
                }
            }
        });
}
