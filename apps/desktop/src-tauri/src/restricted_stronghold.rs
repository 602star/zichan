use crate::portable::PortablePaths;
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime, State,
};
use tauri_plugin_stronghold::{kdf::KeyDerivation, stronghold::Stronghold};
use zeroize::Zeroize;

type CommandResult<T> = Result<T, String>;

#[derive(Default)]
struct StrongholdCollection(Arc<Mutex<HashMap<PathBuf, Stronghold>>>);

#[derive(Deserialize)]
#[serde(untagged)]
enum BytesDto {
    Text(String),
    Raw(Vec<u8>),
}

impl AsRef<[u8]> for BytesDto {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Text(value) => value.as_bytes(),
            Self::Raw(value) => value,
        }
    }
}

fn expected_snapshot_path(security: &Path, snapshot_path: &Path) -> CommandResult<PathBuf> {
    let expected = security.join("sync-vault.hold");
    if snapshot_path.file_name().and_then(|name| name.to_str()) != Some("sync-vault.hold") {
        return Err("Stronghold 路径必须是便携安全目录中的 sync-vault.hold".into());
    }
    let expected_parent = expected
        .parent()
        .ok_or("Stronghold 安全目录无效")?
        .canonicalize()
        .map_err(|error| format!("无法解析 Stronghold 安全目录：{error}"))?;
    let supplied_parent = snapshot_path
        .parent()
        .ok_or("Stronghold 路径没有父目录")?
        .canonicalize()
        .map_err(|error| format!("无法解析 Stronghold 路径：{error}"))?;
    if supplied_parent != expected_parent {
        return Err("拒绝访问便携 data/security 之外的 Stronghold 路径".into());
    }
    let normalized = expected_parent.join("sync-vault.hold");
    if normalized.exists() {
        let metadata = std::fs::symlink_metadata(&normalized)
            .map_err(|error| format!("读取 Stronghold 文件元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err("Stronghold 文件不允许是链接或重解析点".into());
        }
        if !metadata.is_file() {
            return Err("Stronghold 路径不是普通文件".into());
        }
    }
    Ok(normalized)
}

fn checked_snapshot(paths: &PortablePaths, snapshot_path: PathBuf) -> CommandResult<PathBuf> {
    expected_snapshot_path(&paths.security, &snapshot_path)
}

fn checked_salt_path(paths: &PortablePaths) -> CommandResult<PathBuf> {
    expected_salt_path(&paths.security)
}

fn expected_salt_path(security: &Path) -> CommandResult<PathBuf> {
    let security = security
        .canonicalize()
        .map_err(|error| format!("无法解析 Stronghold 安全目录：{error}"))?;
    let salt = security.join("stronghold-salt.txt");
    match std::fs::symlink_metadata(&salt) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
                return Err("Stronghold salt 不允许是链接或重解析点".into());
            }
            if !metadata.is_file() || metadata.len() != 32 {
                return Err("Stronghold salt 文件必须是 32 字节普通文件".into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("读取 Stronghold salt 元数据失败：{error}"));
        }
    }
    Ok(salt)
}

fn with_stronghold<T>(
    collection: &StrongholdCollection,
    snapshot_path: &Path,
    callback: impl FnOnce(&Stronghold) -> CommandResult<T>,
) -> CommandResult<T> {
    let collection = collection.0.lock().map_err(|_| "Stronghold 状态锁已损坏")?;
    let stronghold = collection
        .get(snapshot_path)
        .ok_or("stronghold not initialized")?;
    callback(stronghold)
}

#[tauri::command]
async fn initialize(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    mut password: String,
) -> CommandResult<()> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    let salt_path = checked_salt_path(&paths)?;
    let hash_result = std::panic::catch_unwind(|| KeyDerivation::argon2(&password, &salt_path));
    password.zeroize();
    let hash =
        hash_result.map_err(|_| "Stronghold 密钥派生失败；请检查便携目录可写性和 salt 文件")?;
    let salt_metadata = std::fs::symlink_metadata(&salt_path)
        .map_err(|error| format!("Stronghold salt 创建后校验失败：{error}"))?;
    if salt_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&salt_metadata)
        || !salt_metadata.is_file()
        || salt_metadata.len() != 32
    {
        return Err("Stronghold salt 创建后不是安全的 32 字节普通文件".into());
    }
    let stronghold = Stronghold::new(&snapshot_path, hash).map_err(|error| error.to_string())?;
    collection
        .0
        .lock()
        .map_err(|_| "Stronghold 状态锁已损坏")?
        .insert(snapshot_path, stronghold);
    Ok(())
}

#[tauri::command]
async fn destroy(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
) -> CommandResult<()> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    let mut collection = collection.0.lock().map_err(|_| "Stronghold 状态锁已损坏")?;
    if let Some(stronghold) = collection.remove(&snapshot_path) {
        if let Err(error) = stronghold.save() {
            collection.insert(snapshot_path, stronghold);
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn save(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
) -> CommandResult<()> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        stronghold.save().map_err(|error| error.to_string())
    })
}

#[tauri::command]
async fn create_client(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    client: BytesDto,
) -> CommandResult<()> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        stronghold
            .create_client(client)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
async fn load_client(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    client: BytesDto,
) -> CommandResult<()> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        stronghold
            .load_client(client)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
async fn get_store_record(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    client: BytesDto,
    key: String,
) -> CommandResult<Option<Vec<u8>>> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        let client = stronghold
            .get_client(client)
            .map_err(|error| error.to_string())?;
        client
            .store()
            .get(key.as_bytes())
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
async fn save_store_record(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    client: BytesDto,
    key: String,
    value: Vec<u8>,
    lifetime: Option<Duration>,
) -> CommandResult<Option<Vec<u8>>> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        let client = stronghold
            .get_client(client)
            .map_err(|error| error.to_string())?;
        client
            .store()
            .insert(key.into_bytes(), value, lifetime)
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
async fn remove_store_record(
    paths: State<'_, PortablePaths>,
    collection: State<'_, StrongholdCollection>,
    snapshot_path: PathBuf,
    client: BytesDto,
    key: String,
) -> CommandResult<Option<Vec<u8>>> {
    let snapshot_path = checked_snapshot(&paths, snapshot_path)?;
    with_stronghold(&collection, &snapshot_path, |stronghold| {
        let client = stronghold
            .get_client(client)
            .map_err(|error| error.to_string())?;
        client
            .store()
            .delete(key.as_bytes())
            .map_err(|error| error.to_string())
    })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("stronghold")
        .setup(|app, _api| {
            app.manage(StrongholdCollection::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize,
            destroy,
            save,
            create_client,
            load_client,
            get_store_record,
            save_store_record,
            remove_store_record,
        ])
        .build()
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{expected_salt_path, expected_snapshot_path};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn only_the_managed_snapshot_path_is_accepted() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zichan-stronghold-path-{}-{nonce}",
            std::process::id()
        ));
        let security = root.join("data").join("security");
        let outside = root.join("outside");
        fs::create_dir_all(&security).expect("create security fixture");
        fs::create_dir_all(&outside).expect("create outside fixture");
        let expected = security.join("sync-vault.hold");
        assert_eq!(
            expected_snapshot_path(&security, &expected).unwrap(),
            security.canonicalize().unwrap().join("sync-vault.hold")
        );
        assert!(expected_snapshot_path(&security, &outside.join("sync-vault.hold")).is_err());
        assert!(expected_snapshot_path(&security, &security.join("other.hold")).is_err());

        let salt = security.join("stronghold-salt.txt");
        fs::write(&salt, [0_u8; 31]).expect("write invalid salt fixture");
        assert!(expected_salt_path(&security).is_err());
        fs::remove_file(&salt).expect("remove invalid salt fixture");
        fs::write(&salt, [0_u8; 32]).expect("write valid salt fixture");
        assert_eq!(
            expected_salt_path(&security).unwrap(),
            security.canonicalize().unwrap().join("stronghold-salt.txt")
        );
        fs::remove_file(&salt).expect("remove valid salt fixture");

        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            let external_snapshot = outside.join("external-snapshot");
            fs::write(&external_snapshot, b"snapshot").expect("write external snapshot fixture");
            if symlink_file(&external_snapshot, &expected).is_ok() {
                assert!(expected_snapshot_path(&security, &expected).is_err());
                fs::remove_file(&expected).expect("remove snapshot symlink fixture");
            }

            let external_salt = outside.join("external-salt");
            fs::write(&external_salt, [0_u8; 32]).expect("write external salt fixture");
            if symlink_file(&external_salt, &salt).is_ok() {
                assert!(expected_salt_path(&security).is_err());
                fs::remove_file(&salt).expect("remove salt symlink fixture");
            }
        }
        fs::remove_dir_all(root).expect("remove stronghold fixture");
    }
}
