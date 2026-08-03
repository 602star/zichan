use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};
pub use models::{ShareRequest, ShareResponse};

#[cfg(desktop)]
use desktop::SystemShare;
#[cfg(mobile)]
use mobile::SystemShare;

pub trait SystemShareExt<R: Runtime> {
    fn system_share(&self) -> &SystemShare<R>;
}

impl<R: Runtime, T: Manager<R>> SystemShareExt<R> for T {
    fn system_share(&self) -> &SystemShare<R> {
        self.state::<SystemShare<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-share")
        .invoke_handler(tauri::generate_handler![commands::share])
        .setup(|app, api| {
            #[cfg(mobile)]
            let system_share = mobile::init(app, api)?;
            #[cfg(desktop)]
            let system_share = desktop::init(app, api)?;
            app.manage(system_share);
            Ok(())
        })
        .build()
}
