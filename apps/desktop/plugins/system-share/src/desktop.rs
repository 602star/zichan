use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, Result, ShareRequest, ShareResponse};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<SystemShare<R>> {
    Ok(SystemShare(app.clone()))
}

pub struct SystemShare<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> SystemShare<R> {
    pub fn share(&self, _payload: ShareRequest) -> Result<ShareResponse> {
        Err(Error::Unsupported)
    }
}
