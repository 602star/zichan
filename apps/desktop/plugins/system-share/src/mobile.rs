use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{Result, ShareRequest, ShareResponse};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_system_share);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<SystemShare<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("com.zichan.systemshare", "SystemSharePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_system_share)?;
    Ok(SystemShare(handle))
}

pub struct SystemShare<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SystemShare<R> {
    pub fn share(&self, payload: ShareRequest) -> Result<ShareResponse> {
        self.0
            .run_mobile_plugin("share", payload)
            .map_err(Into::into)
    }
}
