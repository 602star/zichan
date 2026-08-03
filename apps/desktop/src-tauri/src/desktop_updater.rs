use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt;

const STABLE_ENDPOINT: Option<&str> = option_env!("ZICHAN_UPDATE_STABLE_ENDPOINT");
const PREVIEW_ENDPOINT: Option<&str> = option_env!("ZICHAN_UPDATE_PREVIEW_ENDPOINT");
const ROLLBACK_ENDPOINT: Option<&str> = option_env!("ZICHAN_UPDATE_ROLLBACK_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("ZICHAN_UPDATE_PUBLIC_KEY");

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedUpdateState {
    channel: String,
    phase: String,
    previous_version: Option<String>,
    target_version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    last_checked_at: Option<String>,
    message: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateStatus {
    supported: bool,
    configured: bool,
    current_version: String,
    channel: String,
    phase: String,
    available_version: Option<String>,
    previous_version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    last_checked_at: Option<String>,
    rollback_configured: bool,
    message: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("update-state.json"))
        .map_err(|error| error.to_string())
}

fn read_state(app: &AppHandle) -> PersistedUpdateState {
    state_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_else(|| PersistedUpdateState {
            channel: "stable".into(),
            phase: "idle".into(),
            ..Default::default()
        })
}

fn write_state(app: &AppHandle, state: &PersistedUpdateState) -> Result<(), String> {
    let path = state_path(app)?;
    let parent = path.parent().ok_or("更新状态目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建更新状态目录失败：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| format!("写入更新状态失败：{error}"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("替换更新状态失败：{error}"))?;
    }
    fs::rename(temporary, path).map_err(|error| format!("提交更新状态失败：{error}"))
}

fn endpoint(channel: &str) -> Result<&'static str, String> {
    let value = match channel {
        "stable" => STABLE_ENDPOINT,
        "preview" => PREVIEW_ENDPOINT,
        "rollback" => ROLLBACK_ENDPOINT,
        _ => return Err("更新通道无效".into()),
    };
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("当前安装包未配置{channel}更新通道"))
}

fn public_key() -> Result<&'static str, String> {
    UPDATE_PUBLIC_KEY
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "当前安装包未配置更新签名公钥".into())
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    // The frontend only displays this diagnostic value; RFC 3339 is supplied by release manifests.
    seconds.to_string()
}

fn normalize_state(app: &AppHandle, mut state: PersistedUpdateState) -> PersistedUpdateState {
    let current = app.package_info().version.to_string();
    if state.phase == "installing" {
        if state.target_version.as_deref() == Some(current.as_str()) {
            state.phase = "awaiting_health".into();
            state.message = Some("新版本已启动，等待账本初始化确认".into());
            state.error = None;
        } else if state.previous_version.as_deref() == Some(current.as_str()) {
            state.phase = "failed".into();
            state.message = Some("更新未完成，当前版本保持不变".into());
            state.error.get_or_insert_with(|| "安装程序未完成更新".into());
        }
    }
    state
}

fn public_status(app: &AppHandle, state: PersistedUpdateState) -> DesktopUpdateStatus {
    let configured = UPDATE_PUBLIC_KEY.is_some() && STABLE_ENDPOINT.is_some();
    DesktopUpdateStatus {
        supported: cfg!(desktop),
        configured,
        current_version: app.package_info().version.to_string(),
        channel: if state.channel.is_empty() { "stable".into() } else { state.channel },
        phase: if state.phase.is_empty() { "idle".into() } else { state.phase },
        available_version: state.target_version,
        previous_version: state.previous_version,
        notes: state.notes,
        published_at: state.published_at,
        last_checked_at: state.last_checked_at,
        rollback_configured: UPDATE_PUBLIC_KEY.is_some() && ROLLBACK_ENDPOINT.is_some(),
        message: state.message.unwrap_or_else(|| {
            if configured {
                "可以检查已签名的桌面更新".into()
            } else {
                "开发构建未配置发布清单".into()
            }
        }),
        error: state.error,
    }
}

#[cfg(desktop)]
fn configured_updater(
    app: &AppHandle,
    channel: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let url = endpoint(channel)?
        .parse()
        .map_err(|error| format!("更新地址无效：{error}"))?;
    let builder = app
        .updater_builder()
        .pubkey(public_key()?)
        .endpoints(vec![url])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30));
    let builder = if channel == "rollback" {
        builder.version_comparator(|current, release| release.version < current)
    } else {
        builder
    };
    builder.build().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_update_status(app: AppHandle) -> Result<DesktopUpdateStatus, String> {
    let state = normalize_state(&app, read_state(&app));
    write_state(&app, &state)?;
    Ok(public_status(&app, state))
}

#[tauri::command]
pub async fn desktop_check_for_update(
    app: AppHandle,
    channel: String,
) -> Result<DesktopUpdateStatus, String> {
    #[cfg(not(desktop))]
    {
        let _ = channel;
        return Err("移动端不使用桌面更新器".into());
    }
    #[cfg(desktop)]
    {
        let mut state = normalize_state(&app, read_state(&app));
        state.channel = channel.clone();
        state.phase = "checking".into();
        state.last_checked_at = Some(now_iso());
        state.error = None;
        state.message = Some("正在检查签名更新清单".into());
        write_state(&app, &state)?;

        let result = configured_updater(&app, &channel)?.check().await;
        match result {
            Ok(Some(update)) => {
                state.phase = "available".into();
                state.target_version = Some(update.version.clone());
                state.notes = update.body.clone();
                state.published_at = update.date.map(|date| date.to_string());
                state.message = Some(if channel == "rollback" {
                    format!("可回退到 {}", update.version)
                } else {
                    format!("发现新版本 {}", update.version)
                });
            }
            Ok(None) => {
                state.phase = "current".into();
                state.target_version = None;
                state.notes = None;
                state.published_at = None;
                state.message = Some(if channel == "rollback" {
                    "没有可用的已签名回退版本".into()
                } else {
                    "当前已经是该通道的最新版本".into()
                });
            }
            Err(error) => {
                state.phase = "failed".into();
                state.error = Some(error.to_string());
                state.message = Some("更新检查失败，当前版本未变更".into());
            }
        }
        write_state(&app, &state)?;
        Ok(public_status(&app, state))
    }
}

#[tauri::command]
pub async fn desktop_install_update(
    app: AppHandle,
    channel: String,
) -> Result<DesktopUpdateStatus, String> {
    #[cfg(not(desktop))]
    {
        let _ = channel;
        return Err("移动端不使用桌面更新器".into());
    }
    #[cfg(desktop)]
    {
        let updater = configured_updater(&app, &channel)?;
        let update = updater
            .check()
            .await
            .map_err(|error| format!("重新检查更新失败：{error}"))?
            .ok_or_else(|| "更新清单已变化，当前没有可安装版本".to_string())?;
        let mut state = normalize_state(&app, read_state(&app));
        state.channel = channel;
        state.phase = "installing".into();
        state.previous_version = Some(app.package_info().version.to_string());
        state.target_version = Some(update.version.clone());
        state.notes = update.body.clone();
        state.error = None;
        state.message = Some("正在下载、验签并安装；完成后应用会重新启动".into());
        write_state(&app, &state)?;

        let downloaded = Arc::new(AtomicU64::new(0));
        let progress_app = app.clone();
        let progress_downloaded = downloaded.clone();
        let install_result = update
            .download_and_install(
                move |chunk_size, total| {
                    let value = progress_downloaded.fetch_add(chunk_size as u64, Ordering::Relaxed)
                        + chunk_size as u64;
                    let _ = progress_app.emit(
                        "zichan:update-progress",
                        DesktopUpdateProgress {
                            downloaded_bytes: value,
                            total_bytes: total,
                        },
                    );
                },
                || {},
            )
            .await;
        if let Err(error) = install_result {
            state.phase = "failed".into();
            state.error = Some(error.to_string());
            state.message = Some("安装失败，已保留当前版本和安装前备份".into());
            write_state(&app, &state)?;
            return Ok(public_status(&app, state));
        }

        state.phase = "installing".into();
        state.message = Some("更新已安装，正在重新启动".into());
        write_state(&app, &state)?;
        app.restart();
    }
}

#[tauri::command]
pub fn desktop_confirm_update_healthy(app: AppHandle) -> Result<DesktopUpdateStatus, String> {
    let mut state = normalize_state(&app, read_state(&app));
    if state.phase == "awaiting_health" {
        state.phase = "healthy".into();
        state.message = Some(format!(
            "版本 {} 已通过账本启动检查",
            app.package_info().version
        ));
        state.error = None;
        write_state(&app, &state)?;
    }
    Ok(public_status(&app, state))
}
