//! Desktop presence and window controls; run ownership stays in the shared core.
use crate::core::Core;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Manager,
};

const TRAY_ID: &str = "lz-status";

struct TrayStatus {
    status: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn status_text(active: usize) -> String {
    match active {
        0 => "lz está activo".into(),
        1 => "lz está activo · 1 ejecución en curso".into(),
        count => format!("lz está activo · {count} ejecuciones en curso"),
    }
}

pub fn refresh_status(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Read at display time so simultaneous starts/exits cannot leave stale counts.
        let active = handle.state::<Core>().runs.active_count();
        let text = status_text(active);
        if let Some(tray) = handle.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(&text));
        }
        if let Some(items) = handle.try_state::<TrayStatus>() {
            let _ = items.status.set_text(&text);
            let _ = items.quit.set_text(if active == 0 {
                "Salir de lz"
            } else {
                "Salir e interrumpir las ejecuciones"
            });
        }
    });
}

pub fn install(app: &mut App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "tray-status", status_text(0), false, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", "Abrir lz", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", "Ocultar ventana", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Salir de lz", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &show, &hide, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?
        .clone();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(status_text(0))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayStatus { status, quit });
    Ok(())
}
