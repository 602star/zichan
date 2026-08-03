use tauri::{command, AppHandle, Runtime};

use crate::{Result, ShareRequest, ShareResponse, SystemShareExt};

#[command]
pub(crate) async fn share<R: Runtime>(
    app: AppHandle<R>,
    payload: ShareRequest,
) -> Result<ShareResponse> {
    app.system_share().share(payload)
}
