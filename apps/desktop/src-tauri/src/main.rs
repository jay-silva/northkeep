// Northkeep desktop shell: spawns the local Node UI server, reads the
// tokened URL it announces on stdout, and opens a native window there.
// All product logic lives in the web/API layer — this stays a dumb window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Mutex<Option<Child>>);

fn server_js_path() -> std::path::PathBuf {
    // Dev-machine layout: this crate lives at apps/desktop/src-tauri.
    // NORTHKEEP_SERVER_JS overrides (used when we bundle a sidecar later).
    if let Ok(p) = std::env::var("NORTHKEEP_SERVER_JS") {
        return p.into();
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../web/dist/server.js")
        .canonicalize()
        .expect("apps/web is not built — run: pnpm build")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let mut child = Command::new("node")
                .arg(server_js_path())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("could not start the Northkeep server (is Node installed?)");

            let stdout = child.stdout.take().expect("no stdout from server");
            let mut url = None;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("NORTHKEEP_UI_URL=") {
                    url = Some(rest.to_string());
                    break;
                }
            }
            let url = url.expect("server never announced its URL");
            app.manage(ServerProcess(Mutex::new(Some(child))));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Northkeep")
                .inner_size(1020.0, 740.0)
                .min_inner_size(560.0, 480.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building Northkeep")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // The server holds the vault key in memory — take it down with us.
                if let Some(state) = app.try_state::<ServerProcess>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
