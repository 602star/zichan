use serde_json::{json, Value};

#[tauri::command]
pub fn client_update_check() -> Value {
    json!({
        "enabled": false,
        "mode": "ios",
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "reason": "iOS 版本请通过安装来源更新"
    })
}
