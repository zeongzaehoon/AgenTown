#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use agentown_desktop::{Admission, Paths, STARTUP, Service};
use std::sync::{Arc, Mutex};
use tauri::Manager;

fn show_error(message: &str) {
    rfd::MessageDialog::new()
        .set_title("AgenTown could not continue")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}
fn main() {
    let state: Arc<Mutex<Option<(Service, Admission)>>> = Arc::new(Mutex::new(None));
    let setup_state = state.clone();
    let app = tauri::Builder::default().setup(move |app| {
        let start = || -> Result<(Service, Admission), Box<dyn std::error::Error>> {
            let paths = Paths::create(app.path().app_data_dir()?, app.path().app_config_dir()?, app.path().app_log_dir()?)?;
            let admission = Admission::acquire(&paths.data.join("desktop.lock"))?;
            let runtime = app.path().resource_dir()?.join("service");
            let mut service = Service::launch(&runtime, &paths, agentown_desktop::endpoint()?)?;
            service.wait_ready(STARTUP)?;
            let port = service.port;
            let url = format!("http://127.0.0.1:{port}/").parse()?;
            tauri::WebviewWindowBuilder::new(app, "workspace", tauri::WebviewUrl::External(url))
                .title("AgenTown").inner_size(1200.0, 820.0).min_inner_size(800.0, 600.0)
                .on_navigation(move |url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port))
                .build()?;
            Ok((service, admission))
        };
        match start() {
            Ok(owned) => *setup_state.lock().unwrap() = Some(owned),
            Err(error) => { show_error(&error.to_string()); app.handle().exit(1); return Ok(()); }
        }
        let monitor_state = setup_state.clone();
        let handle = app.handle().clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let mut guard = monitor_state.lock().unwrap();
            let Some((service, _)) = guard.as_mut() else { break; };
            if !service.alive() {
                drop(guard.take());
                drop(guard);
                show_error("The AgenTown service stopped unexpectedly. Reopen the app to recover saved work. If this repeats, rebuild or reinstall the app; your database is retained.");
                handle.exit(1);
                break;
            }
        });
        Ok(())
    }).build(tauri::generate_context!()).expect("Cannot initialize the native AgenTown shell");
    app.run(move |_, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            drop(state.lock().unwrap().take());
        }
    });
}
