// Keep Watch menu bar menu (ADR 0080), macOS only. Every rule lives in the
// local server; this menu reads /api/keep-watch and posts the same actions
// the Settings page does, over loopback with the session token the shell
// already holds. No new network access.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};

// 44x44 RGBA, black on clear, used as a template image so macOS tints it.
const ICON_OFF: &[u8] = include_bytes!("../icons/tray-keepwatch-off.rgba");
const ICON_ON: &[u8] = include_bytes!("../icons/tray-keepwatch-on.rgba");

fn icon(bytes: &'static [u8]) -> Image<'static> {
    Image::new(bytes, 44, 44)
}

struct Local {
    port: u16,
    token: String,
}

impl Local {
    /// Parses the announced `http://127.0.0.1:PORT/?token=T` URL.
    fn from_url(url: &str) -> Option<Self> {
        let rest = url.strip_prefix("http://127.0.0.1:")?;
        let (port, query) = rest.split_once("/?token=")?;
        Some(Local { port: port.parse().ok()?, token: query.to_string() })
    }

    fn request(&self, method: &str, body: &str, timeout: Duration) -> Option<serde_json::Value> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream.set_read_timeout(Some(timeout)).ok()?;
        stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
        let req = format!(
            "{method} /api/keep-watch HTTP/1.1\r\nHost: 127.0.0.1\r\nX-NorthKeep-Token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.token,
            body.len()
        );
        stream.write_all(req.as_bytes()).ok()?;
        let mut raw = String::new();
        stream.read_to_string(&mut raw).ok()?;
        let (_, json) = raw.split_once("\r\n\r\n")?;
        serde_json::from_str(json).ok()
    }

    fn status(&self) -> Option<serde_json::Value> {
        self.request("GET", "", Duration::from_secs(10))
    }

    /// Turning on waits for the user at the macOS password prompt.
    fn post(&self, body: &str) -> Option<serde_json::Value> {
        self.request("POST", body, Duration::from_secs(300))
    }
}

struct Items {
    tray: TrayIcon,
    status: MenuItem<tauri::Wry>,
    toggle: CheckMenuItem<tauri::Wry>,
    extend: MenuItem<tauri::Wry>,
}

fn minutes_left(ends_at: &str) -> Option<i64> {
    let ends = chrono_free_parse(ends_at)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some(((ends - now) / 60).max(0))
}

/// Seconds since the epoch for an ISO string like 2026-10-21T16:00:00.000Z.
fn chrono_free_parse(iso: &str) -> Option<i64> {
    let (date, time) = iso.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.trim_end_matches('Z').split(':');
    let (hh, mm) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let ss = t.next()?.split('.').next()?.parse::<i64>().ok()?;
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

fn render(items: &Items, s: &serde_json::Value) {
    let state = s["state"].as_str().unwrap_or("off");
    let on = state == "on";
    let line = match state {
        "on" => match s["ends_at"].as_str().and_then(minutes_left) {
            Some(m) if m >= 60 => format!("Awake with the lid closed · {} h {} m left", m / 60, m % 60),
            Some(m) => format!("Awake with the lid closed · {m} m left"),
            None => "Awake with the lid closed".to_string(),
        },
        "turning_off" => "Keep Watch is turning off…".to_string(),
        _ => "Keep Watch is off".to_string(),
    };
    let _ = items.status.set_text(line);
    let _ = items.toggle.set_checked(on || state == "turning_off");
    let _ = items.toggle.set_enabled(state != "turning_off");
    let _ = items.extend.set_enabled(on);
    let _ = items.tray.set_icon(Some(icon(if on { ICON_ON } else { ICON_OFF })));
    let _ = items.tray.set_icon_as_template(true);
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval(
            "document.querySelector('#mainNav button[data-view=settings]')?.click();document.querySelector('#keepWatchNav')?.click();",
        );
    }
}

/// Builds the menu when the server says Keep Watch is supported here, then
/// refreshes it every 15 seconds and after each action.
pub fn install(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let Some(local) = Local::from_url(url) else { return Ok(()) };
    let local = Arc::new(local);
    match local.status() {
        Some(s) if s["supported"].as_bool() == Some(true) => {}
        _ => return Ok(()),
    }
    let status = MenuItem::with_id(app, "kw-status", "Keep Watch is off", false, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(app, "kw-toggle", "Run with the lid closed", true, false, None::<&str>)?;
    let extend = MenuItem::with_id(app, "kw-extend", "Add 1 hour", false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "kw-settings", "Keep Watch settings…", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "kw-open", "Open NorthKeep", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &extend,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &open,
        ],
    )?;
    let action_local = local.clone();
    let tray = TrayIconBuilder::with_id("keep-watch")
        .icon(icon(ICON_OFF))
        .icon_as_template(true)
        .tooltip("NorthKeep Keep Watch")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let local = action_local.clone();
            match event.id().as_ref() {
                "kw-toggle" => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let current = local.status();
                        let on = current.as_ref().and_then(|s| s["state"].as_str()) == Some("on");
                        let body = if on {
                            r#"{"action":"off"}"#.to_string()
                        } else {
                            let s = current.unwrap_or_default();
                            format!(
                                r#"{{"action":"on","hours":{},"allow_battery":{}}}"#,
                                s["hours"].as_u64().unwrap_or(2),
                                s["allow_battery"].as_bool().unwrap_or(false)
                            )
                        };
                        // A refusal (unplugged, hot, helper disabled) is explained on the page.
                        if local.post(&body).map(|r| r.get("error").is_some()).unwrap_or(true) && !on {
                            open_settings(&app);
                        }
                        refresh(&app, &local);
                    });
                }
                "kw-extend" => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        local.post(r#"{"action":"extend"}"#);
                        refresh(&app, &local);
                    });
                }
                "kw-settings" => open_settings(app),
                "kw-open" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        })
        .build(app)?;
    app.manage(Items { tray, status, toggle, extend });
    let app = app.clone();
    std::thread::spawn(move || loop {
        refresh(&app, &local);
        std::thread::sleep(Duration::from_secs(15));
    });
    Ok(())
}

fn refresh(app: &AppHandle, local: &Local) {
    if let (Some(items), Some(s)) = (app.try_state::<Items>(), local.status()) {
        render(&items, &s);
    }
}

#[cfg(test)]
mod tests {
    use super::{chrono_free_parse, Local};

    #[test]
    fn reads_the_announced_url() {
        let l = Local::from_url("http://127.0.0.1:47811/?token=abc123").unwrap();
        assert_eq!(l.port, 47811);
        assert_eq!(l.token, "abc123");
        assert!(Local::from_url("http://example.com:1/?token=x").is_none());
    }

    #[test]
    fn parses_iso_times() {
        assert_eq!(chrono_free_parse("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(chrono_free_parse("2026-10-21T16:00:00.000Z"), Some(1_792_598_400));
    }
}
