use crate::portable::PortablePaths;
use serde::Serialize;
#[cfg(windows)]
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
#[cfg(windows)]
use std::{
    io::{Cursor, Write},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "linux")]
use tauri::Manager;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
#[cfg(windows)]
use zip::ZipArchive;

const TEST_PUBLIC_KEY: &str = include_str!("../installer/update-test.pub");

#[derive(Default)]
pub struct PendingClientUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateInfo {
    enabled: bool,
    mode: &'static str,
    current_version: String,
    target_version: Option<String>,
    notes: Option<String>,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
    Installing,
}

fn target(paths: &PortablePaths) -> Result<&'static str, String> {
    #[cfg(windows)]
    {
        if paths.mode == "portable" {
            return Ok("windows-portable-x86_64");
        }
        if paths.mode != "installed" {
            return Err("当前 Windows 应用布局不支持升级".into());
        }
        let root = std::env::current_exe()
            .map_err(|error| error.to_string())?
            .parent()
            .ok_or("安装目录无效")?
            .to_path_buf();
        let channel = fs::read_to_string(root.join("installer-channel.txt"))
            .map_err(|_| "此安装包缺少 MSI/NSIS 通道标记，请手动安装新版".to_string())?;
        return match channel.trim() {
            "msi" => Ok("windows-msi-x86_64"),
            "nsis" => Ok("windows-nsis-x86_64"),
            _ => Err("安装包通道标记无效".into()),
        };
    }
    #[cfg(target_os = "linux")]
    {
        let _ = paths;
        if std::env::var_os("APPIMAGE").is_some() {
            Ok("linux-appimage-x86_64")
        } else {
            Ok("linux-deb-x86_64")
        }
    }
}

fn endpoint() -> Result<tauri::Url, String> {
    let raw = std::env::var("ZICHAN_CLIENT_UPDATE_URL")
        .ok()
        .or_else(|| option_env!("ZICHAN_CLIENT_UPDATE_URL").map(str::to_string))
        .ok_or("此构建未配置客户端签名更新源")?;
    let url = tauri::Url::parse(&raw).map_err(|_| "客户端更新源地址无效")?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("客户端更新源必须使用无凭据的 HTTPS 地址".into());
    }
    Ok(url)
}

fn info(app: &AppHandle, paths: &PortablePaths) -> ClientUpdateInfo {
    let mode = if cfg!(windows) {
        paths.mode
    } else {
        "platform"
    };
    let reason = target(paths).and_then(|_| endpoint().map(|_| ())).err();
    ClientUpdateInfo {
        enabled: reason.is_none(),
        mode,
        current_version: app.package_info().version.to_string(),
        target_version: None,
        notes: None,
        reason,
    }
}

#[tauri::command]
pub fn client_update_status(app: AppHandle, paths: State<'_, PortablePaths>) -> ClientUpdateInfo {
    info(&app, &paths)
}

#[tauri::command]
pub async fn client_update_check(
    app: AppHandle,
    paths: State<'_, PortablePaths>,
    pending: State<'_, PendingClientUpdate>,
) -> Result<ClientUpdateInfo, String> {
    *pending.0.lock().map_err(|_| "更新状态锁不可用")? = None;
    let mut result = info(&app, &paths);
    if !result.enabled {
        return Ok(result);
    }
    let update = app
        .updater_builder()
        .pubkey(TEST_PUBLIC_KEY.trim())
        .endpoints(vec![endpoint()?])
        .map_err(|error| error.to_string())?
        .target(target(&paths)?)
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    if let Some(ref available) = update {
        if !available.version.starts_with("0.3.") {
            return Err("客户端更新只允许 0.3.x 补丁版本".into());
        }
        result.target_version = Some(available.version.clone());
        result.notes = available.body.clone();
    }
    *pending.0.lock().map_err(|_| "更新状态锁不可用")? = update;
    Ok(result)
}

#[tauri::command]
pub async fn client_update_install(
    app: AppHandle,
    paths: State<'_, PortablePaths>,
    pending: State<'_, PendingClientUpdate>,
    version: String,
    on_event: Channel<DownloadEvent>,
) -> Result<String, String> {
    target(&paths)?;
    endpoint()?;
    let update = pending
        .0
        .lock()
        .map_err(|_| "更新状态锁不可用")?
        .take()
        .ok_or("请先检查客户端更新")?;
    if update.version != version {
        return Err("目标版本与已检查的发布不一致".into());
    }
    let mut started = false;
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    let _ = on_event.send(DownloadEvent::Installing);
    #[cfg(windows)]
    if paths.mode == "portable" {
        install_portable_update(&app, &paths, &version, bytes)?;
        return Ok("便携升级助手已启动".into());
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return install_deb_update(&app, &version, bytes);
    }
    update.install(bytes).map_err(|error| error.to_string())?;
    app.restart()
}

#[cfg(target_os = "linux")]
fn install_deb_update(app: &AppHandle, version: &str, bytes: Vec<u8>) -> Result<String, String> {
    use std::{fs, process::Command};
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("Debian 更新包超过 512 MiB".into());
    }
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("updates");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(format!("zichan-{version}-x86_64.deb"));
    let temporary = directory.join(format!(".{version}-{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
    match Command::new("xdg-open").arg(&target).spawn() {
        Ok(_) => Ok(format!(
            "已验证 Debian 安装包并打开系统安装器：{}",
            target.display()
        )),
        Err(_) => Ok(format!(
            "已验证 Debian 安装包。请使用系统包管理器安装：{}",
            target.display()
        )),
    }
}

#[cfg(windows)]
fn install_portable_update(
    app: &AppHandle,
    paths: &PortablePaths,
    version: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.len() > 1024 * 1024 * 1024 {
        return Err("便携更新包超过 1 GiB".into());
    }
    let root = &paths.root;
    let parent = root.parent().ok_or("便携目录缺少父目录")?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("便携目录名称无效")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let suffix = format!("{}-{nonce}", std::process::id());
    let stage = parent.join(format!(".{name}-stage-{suffix}"));
    let backup = parent.join(format!(".{name}-previous-{suffix}"));
    let helper = parent.join(format!(".{name}-update-{suffix}.ps1"));
    fs::create_dir(&stage).map_err(|error| format!("创建升级暂存目录失败：{error}"))?;
    let extracted = (|| -> Result<(), String> {
        let mut archive = ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("便携 ZIP 无效：{error}"))?;
        let mut top: Option<String> = None;
        let mut total = 0u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let source = entry.name();
            if source.contains('\\')
                || entry.enclosed_name().is_none()
                || entry
                    .unix_mode()
                    .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("便携 ZIP 包含非法路径或链接".into());
            }
            let parts: Vec<&str> = source.trim_end_matches('/').split('/').collect();
            if parts.is_empty()
                || parts.iter().any(|part| {
                    part.is_empty()
                        || *part == "."
                        || *part == ".."
                        || part.ends_with('.')
                        || part.ends_with(' ')
                        || part.chars().any(|character| {
                            character.is_control() || "<>:\"|?*".contains(character)
                        })
                })
            {
                return Err("便携 ZIP 路径格式无效".into());
            }
            if let Some(ref expected) = top {
                if parts[0] != expected {
                    return Err("便携 ZIP 包含多个根目录".into());
                }
            } else {
                top = Some(parts[0].to_string());
            }
            if parts.len() == 1 {
                if !entry.is_dir() {
                    return Err("便携 ZIP 根目录无效".into());
                }
                continue;
            }
            let destination = parts[1..]
                .iter()
                .fold(stage.clone(), |path, part| path.join(part));
            if entry.is_dir() {
                fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
                continue;
            }
            total = total.checked_add(entry.size()).ok_or("便携 ZIP 体积无效")?;
            if total > 1024 * 1024 * 1024 {
                return Err("便携 ZIP 解压后超过 1 GiB".into());
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| format!("写入便携文件失败：{error}"))?;
            std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            output.flush().map_err(|error| error.to_string())?;
        }
        for required in [
            "zichan.exe",
            "portable-mode.json",
            "portable-files.json",
            "server/server.mjs",
            "runtime/webview2/msedgewebview2.exe",
        ] {
            if !stage.join(required).is_file() {
                return Err(format!("便携更新包缺少 {required}"));
            }
        }
        if stage.join("data").exists() {
            return Err("便携更新包不得包含用户 data 目录".into());
        }
        for marker in ["portable-mode.json", "portable-files.json"] {
            let value: serde_json::Value = serde_json::from_slice(
                &fs::read(stage.join(marker)).map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            if value["appVersion"] != version {
                return Err(format!("{marker} 与目标版本不一致"));
            }
        }
        Ok(())
    })();
    if let Err(error) = extracted {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let script = include_str!("../installer/portable-update-helper.ps1");
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&helper)
        .map_err(|error| format!("创建便携升级助手失败：{error}"))?;
    output
        .write_all(script.as_bytes())
        .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    let started = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&helper)
        .arg("-ParentPid")
        .arg(std::process::id().to_string())
        .arg("-Current")
        .arg(root)
        .arg("-Stage")
        .arg(&stage)
        .arg("-Backup")
        .arg(&backup)
        .creation_flags(0x08000000)
        .spawn();
    if let Err(error) = started {
        return Err(format!("启动便携升级助手失败：{error}"));
    }
    app.exit(0);
    Ok(())
}
