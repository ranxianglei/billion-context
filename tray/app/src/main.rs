#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use bili_tray_core::config::Config;
use bili_tray_core::format::{menu_model, tooltip};
use bili_tray_core::stats::poll_once;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};

const TRAY_ID: &str = "bili-main";

fn main() {
    let cfg = bili_tray_core::config::load();
    let dashboard_url = format!("http://127.0.0.1:{}/__bili/", cfg.port);

    tauri::Builder::default()
        .setup(move |app| {
            // bundle icons (tauri.conf.json) are embedded at compile time —
            // no runtime PNG decode needed (Image::from_bytes does not exist
            // on this tauri version; default_window_icon is already RGBA).
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("bundled tray icon must be embedded");
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .tooltip("")
                .show_menu_on_left_click(true)
                .on_menu_event(move |handle: &AppHandle, event| match event.id().as_ref() {
                    "open-dashboard" => {
                        let _ = bili_tray_core::platform::open_in_browser(&dashboard_url);
                    }
                    "quit" => handle.exit(0),
                    _ => {}
                })
                .build(app)?;

            let poller_cfg = cfg;
            let poller_tray = tray.clone();
            // `handle` is the on_menu_event parameter — out of scope here.
            // The setup-scoped AppHandle is what the poller thread needs.
            let poller_app = app.handle().clone();
            let mut ui_cache = UiCache::default();
            std::thread::Builder::new()
                .name("bili-tray-poller".into())
                .spawn(move || loop {
                    apply_state(&poller_app, &poller_tray, &poller_cfg, &mut ui_cache);
                    std::thread::sleep(Duration::from_millis(poller_cfg.poll_ms));
                })
                .expect("poller thread must start");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri runtime must run");
}

/// The menu is rebuilt whole each tick: Tauri v2 menu items cannot be hidden,
/// so a fixed slot pool would render dead blank rows when sessions drop.
/// Menu + tooltip are only pushed to the tray when their content actually
/// changed — Tauri v2 re-setting an identical menu makes the whole popup
/// flicker on every poll tick (visible on GTK at 5s cadence).
#[derive(Default)]
struct UiCache {
    menu_items: Option<Vec<String>>,
    tooltip: Option<String>,
}

fn apply_state(app: &AppHandle, tray: &tauri::tray::TrayIcon, cfg: &Config, cache: &mut UiCache) {
    let state = poll_once(cfg);
    let model = menu_model(&state, cfg.port);
    let items: Vec<String> = std::iter::once(model.header.text.clone())
        .chain(std::iter::once(model.port_info.text.clone()))
        .collect();
    if cache.menu_items.as_ref() != Some(&items) {
        if let Ok(menu) = build_menu(app, &model) {
            // set_menu wants the ContextMenu impl on Menu<R> itself, not &Menu<R>.
            let _ = tray.set_menu(Some(menu));
            cache.menu_items = Some(items);
        }
    }
    let tip = tooltip(&state, cfg.port);
    if cache.tooltip.as_ref() != Some(&tip) {
        let _ = tray.set_tooltip(Some(tip.clone()));
        cache.tooltip = Some(tip);
    }
}

fn build_menu(
    app: &AppHandle,
    model: &bili_tray_core::format::MenuModel,
) -> tauri::Result<Menu<tauri::Wry>> {
    let header = MenuItem::with_id(
        app,
        "header",
        model.header.text.clone(),
        false,
        None::<&str>,
    )?;
    let dashboard = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, None::<&str>)?;
    let port_info = MenuItem::with_id(
        app,
        "port-info",
        model.port_info.text.clone(),
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit BiliTray", true, None::<&str>)?;
    MenuBuilder::new(app)
        .item(&header)
        .separator()
        .item(&dashboard)
        .separator()
        .item(&port_info)
        .separator()
        .item(&quit)
        .build()
}
