use base64::Engine;
use ring::signature::{self, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_system_share::{ApkInstallRequest, SystemShareExt};

const PUBLIC_KEY: &str = include_str!("../installer/android-update-test.pub");
const MAX_APK_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
struct AndroidFeed {
    format: String,
    version: String,
    artifact: String,
    sha256: String,
    signature: String,
}

#[derive(Default)]
pub struct PendingAndroidUpdate(Mutex<Option<AndroidFeed>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateInfo {
    enabled: bool,
    mode: &'static str,
    current_version: String,
    target_version: Option<String>,
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

fn patch(version: &str) -> Result<u64, String> {
    let Some(value) = version.strip_prefix("0.3.") else {
        return Err("仅支持 0.3.x 补丁升级".into());
    };
    if value.is_empty()
        || value.len() > 6
        || value.starts_with('0') && value != "0"
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("版本号格式无效".into());
    }
    value.parse().map_err(|_| "版本号格式无效".into())
}

fn endpoint() -> Result<reqwest::Url, String> {
    let raw = std::env::var("ZICHAN_ANDROID_UPDATE_URL")
        .ok()
        .or_else(|| option_env!("ZICHAN_ANDROID_UPDATE_URL").map(str::to_string))
        .ok_or("此 Android 构建未配置签名 APK 更新源")?;
    let url = reqwest::Url::parse(&raw).map_err(|_| "Android 更新源地址无效")?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with("/android-latest.json")
    {
        return Err("Android 更新源必须是无凭据的 HTTPS android-latest.json".into());
    }
    Ok(url)
}

fn signed_text(feed: &AndroidFeed) -> String {
    format!(
        "{}\n{}\n{}\n{}\n",
        feed.format, feed.version, feed.artifact, feed.sha256
    )
}

fn verify_feed(feed: &AndroidFeed) -> Result<(), String> {
    patch(&feed.version)?;
    if feed.format != "zichan-android-feed-v1"
        || feed.artifact != format!("zichan-{}-android-arm64.apk", feed.version)
        || feed.sha256.len() != 64
        || !feed.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Android 更新清单无效".into());
    }
    let key = base64::engine::general_purpose::STANDARD
        .decode(PUBLIC_KEY.trim())
        .map_err(|_| "Android 更新公钥无效")?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(&feed.signature)
        .map_err(|_| "Android 更新签名无效")?;
    UnparsedPublicKey::new(&signature::ED25519, key)
        .verify(signed_text(feed).as_bytes(), &signature)
        .map_err(|_| "Android 更新清单签名无效".into())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn client_update_check(
    app: AppHandle,
    pending: State<'_, PendingAndroidUpdate>,
) -> Result<ClientUpdateInfo, String> {
    *pending.0.lock().map_err(|_| "Android 更新状态锁不可用")? = None;
    let current = app.package_info().version.to_string();
    let mut result = ClientUpdateInfo {
        enabled: false,
        mode: "android",
        current_version: current.clone(),
        target_version: None,
        reason: None,
    };
    let url = match endpoint() {
        Ok(url) => url,
        Err(reason) => {
            result.reason = Some(reason);
            return Ok(result);
        }
    };
    result.enabled = true;
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Android 更新源响应 {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > 4096)
    {
        return Err("Android 更新清单过大".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 4096 {
        return Err("Android 更新清单过大".into());
    }
    let feed: AndroidFeed =
        serde_json::from_slice(&bytes).map_err(|_| "Android 更新清单格式无效")?;
    verify_feed(&feed)?;
    if patch(&feed.version)? > patch(&current)? {
        result.target_version = Some(feed.version.clone());
        *pending.0.lock().map_err(|_| "Android 更新状态锁不可用")? = Some(feed);
    } else {
        *pending.0.lock().map_err(|_| "Android 更新状态锁不可用")? = None;
    }
    Ok(result)
}

#[tauri::command]
pub async fn client_update_install(
    app: AppHandle,
    pending: State<'_, PendingAndroidUpdate>,
    version: String,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let feed = pending
        .0
        .lock()
        .map_err(|_| "Android 更新状态锁不可用")?
        .take()
        .ok_or("请先检查 Android 更新")?;
    if feed.version != version {
        return Err("目标 APK 版本与已检查的清单不一致".into());
    }
    let url = endpoint()?
        .join(&feed.artifact)
        .map_err(|_| "APK 下载地址无效")?;
    let mut response = client()?
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("APK 下载响应 {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_APK_BYTES)
    {
        return Err("APK 超过大小限制".into());
    }
    let _ = on_event.send(DownloadEvent::Started {
        content_length: response.content_length(),
    });
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("zichan-updates");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let file = directory.join(format!("zichan-{version}-{nonce}.apk"));
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut received = 0u64;
    let download = async {
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            received += chunk.len() as u64;
            if received > MAX_APK_BYTES {
                return Err("APK 超过大小限制".to_string());
            }
            hash.update(&chunk);
            output
                .write_all(&chunk)
                .map_err(|error| error.to_string())?;
            let _ = on_event.send(DownloadEvent::Progress {
                chunk_length: chunk.len(),
            });
        }
        output.flush().map_err(|error| error.to_string())?;
        if format!("{:x}", hash.finalize()) != feed.sha256 {
            return Err("APK SHA256 校验失败".into());
        }
        Ok(())
    }
    .await;
    drop(output);
    if let Err(error) = download {
        let _ = fs::remove_file(&file);
        return Err(error);
    }
    let _ = on_event.send(DownloadEvent::Finished);
    let _ = on_event.send(DownloadEvent::Installing);
    app.system_share()
        .install_apk(ApkInstallRequest {
            path: file.to_string_lossy().into_owned(),
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}
