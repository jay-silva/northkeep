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
/// The sidecar is a sibling of this executable because that is where
/// tauri's externalBin puts it (Contents/MacOS on macOS, usr/bin in the
/// Linux bundles). The server tree lives under the resource dir. No
/// `--jitless`: verified
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

/// Copied onto the sidecar when set on this process. The child inherits
/// the rest of the environment too; these are applied again so the vault
/// directory and the key-store switches cannot be dropped by a later edit
/// that clears the map. Launch writes none of them: vault.nkv,
/// device.secret, and master.key appear only when a vault is created or
/// the key is parked.
const SIDECAR_FORWARDED: &[&str] = &[
    "NORTHKEEP_HOME",
    "NORTHKEEP_PASSPHRASE",
    "NORTHKEEP_MASTER_KEY",
    "NORTHKEEP_NO_KEYCHAIN",
    "NORTHKEEP_SECRET_BACKEND",
];

fn sidecar_env(lookup: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut vars = vec![("NORTHKEEP_DESKTOP".to_string(), "1".to_string())];
    for key in SIDECAR_FORWARDED {
        if let Some(value) = lookup(key) {
            vars.push(((*key).to_string(), value));
        }
    }
    vars
}

fn apply_sidecar_env(cmd: &mut Command) {
    for (key, value) in sidecar_env(|key| std::env::var(key).ok()) {
        cmd.env(key, value);
    }
}

#[cfg(any(target_os = "linux", test))]
/// Environment for an AppImage, before GTK or GLib starts.
///
/// The bundled GLib still searches the host GIO module directory, so the
/// WebKit network process loads the host's libgiolibproxy and libdconfsettings.
/// Those are built against the host libcurl and fail with an nghttp2 symbol
/// error when the AppImage's libnghttp2 is already loaded. `GIO_MODULE_DIR`
/// replaces that search path.
///
/// The same bundle cannot use the host ibus module. With `GTK_IM_MODULE=ibus`
/// the input method commits one character and drops the rest. `xim` is the
/// module shipped inside the AppImage. `NORTHKEEP_GTK_IM_MODULE` overrides it
/// for someone who needs a different input method.
fn linux_appimage_env(
    appdir: Option<&str>,
    im_override: Option<&str>,
    dir_exists: impl Fn(&str) -> bool,
) -> Vec<(&'static str, String)> {
    let Some(appdir) = appdir.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };
    let multiarch = format!("{appdir}/usr/lib/x86_64-linux-gnu/gio/modules");
    let plain = format!("{appdir}/usr/lib/gio/modules");
    let modules = if dir_exists(&multiarch) {
        multiarch
    } else if dir_exists(&plain) {
        plain
    } else {
        // Still replace the host search path when the bundle has no modules.
        multiarch
    };
    let im = im_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("xim");
    vec![
        ("GIO_MODULE_DIR", modules),
        ("GTK_IM_MODULE", im.to_string()),
    ]
}

fn apply_linux_bundle_env() {
    #[cfg(target_os = "linux")]
    {
        let appdir = std::env::var("APPDIR").ok();
        let im_override = std::env::var("NORTHKEEP_GTK_IM_MODULE").ok();
        for (key, value) in linux_appimage_env(appdir.as_deref(), im_override.as_deref(), |path| {
            std::path::Path::new(path).is_dir()
        }) {
            std::env::set_var(key, value);
        }
    }
}

fn main() {
    apply_linux_bundle_env();
    tauri::Builder::default()
        .setup(|app| {
            let mut cmd = server_command(app);
            // Tell the server it is running inside the desktop shell, so the
            // web UI opens external links via /api/open (WKWebView won't open
            // target=_blank in a new browser) instead of a dead new-tab.
            // NORTHKEEP_HOME, when set, is the directory for vault.nkv,
            // device.secret, and master.key.
            apply_sidecar_env(&mut cmd);
            let mut child = cmd
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("could not start the NorthKeep server");

            // The tokened URL travels only over this private pipe (ADR 0004).
            // Read it on a helper thread and wait with a BOUND: the old blocking
            // read handled a server that DIED, but a server that stays alive and
            // never announces (hung opening the vault, say) hung setup() forever
            // with no window and no error. 30s is generous for binding a
            // loopback port and printing.
            let stdout = child.stdout.take().expect("no stdout from server");
            let (tx, rx) = std::sync::mpsc::channel::<String>();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(rest) = line.strip_prefix("NORTHKEEP_UI_URL=") {
                        let _ = tx.send(rest.to_string());
                        return;
                    }
                }
                // Reached only if stdout closed WITHOUT announcing. Dropping tx
                // here wakes the receiver below (recv_timeout returns Err), so
                // the "closed stdout before announcing" case is handled there.
            });

            let url = match rx.recv_timeout(std::time::Duration::from_secs(30)) {
                Ok(u) => u,
                Err(_) => {
                    // Timed out, OR stdout closed with no URL (sender dropped).
                    // The server may still be alive and silent, so do NOT block
                    // on wait() — terminate it (SIGTERM then SIGKILL backstop,
                    // safe whether alive or dead), tell the user, and exit
                    // instead of hanging with no window.
                    stop_server(&mut child);
                    let status = child.try_wait().ok().flatten().and_then(|s| s.code());
                    report_server_death(status);
                    std::process::exit(1);
                }
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

#[cfg(test)]
mod tests {
    use super::{linux_appimage_env, sidecar_env};

    #[test]
    fn sidecar_forwards_northkeep_home_when_set() {
        let vars = sidecar_env(|key| {
            if key == "NORTHKEEP_HOME" {
                Some("/var/tmp/nk-explicit".to_string())
            } else {
                None
            }
        });
        assert_eq!(
            vars.iter()
                .find(|(key, _)| key == "NORTHKEEP_HOME")
                .map(|(_, value)| value.as_str()),
            Some("/var/tmp/nk-explicit"),
        );
        assert!(vars
            .iter()
            .any(|(key, value)| key == "NORTHKEEP_DESKTOP" && value == "1"));
        assert!(!vars.iter().any(|(key, _)| key == "NORTHKEEP_PASSPHRASE"));
    }

    #[test]
    fn sidecar_does_not_invent_a_home() {
        let vars = sidecar_env(|_| None);
        assert!(!vars.iter().any(|(key, _)| key == "NORTHKEEP_HOME"));
        assert_eq!(vars, vec![("NORTHKEEP_DESKTOP".to_string(), "1".to_string())]);
    }

    #[test]
    fn appimage_isolates_gio_modules_and_input_method() {
        let absent = |_: &str| false;
        assert!(linux_appimage_env(None, None, absent).is_empty());
        assert!(linux_appimage_env(Some("  "), None, absent).is_empty());
        let vars = linux_appimage_env(Some("/app"), None, absent);
        assert_eq!(
            vars.iter().find(|(key, _)| *key == "GIO_MODULE_DIR").map(|(_, value)| value.as_str()),
            Some("/app/usr/lib/x86_64-linux-gnu/gio/modules"),
        );
        assert_eq!(
            vars.iter().find(|(key, _)| *key == "GTK_IM_MODULE").map(|(_, value)| value.as_str()),
            Some("xim"),
        );
        let bundled = |path: &str| path.ends_with("/usr/lib/gio/modules");
        let vars = linux_appimage_env(Some("/app"), Some("ibus"), bundled);
        assert_eq!(
            vars.iter().find(|(key, _)| *key == "GIO_MODULE_DIR").map(|(_, value)| value.as_str()),
            Some("/app/usr/lib/gio/modules"),
        );
        assert_eq!(
            vars.iter().find(|(key, _)| *key == "GTK_IM_MODULE").map(|(_, value)| value.as_str()),
            Some("ibus"),
        );
    }
}
