use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

const REGISTRY_FILE: &str = "desktop-ledger-profiles.json";
pub const LEGACY_PROFILE_ID: &str = "legacy";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerProfileBinding {
    pub server_id: String,
    pub server_public_key: String,
    pub account_id: String,
    pub replica_id: String,
    pub ledger_id: String,
    pub stream_epoch: String,
    pub server_url: String,
    pub username: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerProfile {
    pub id: String,
    pub binding: LedgerProfileBinding,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    active_profile_id: String,
    profiles: Vec<LedgerProfile>,
}

fn valid_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_binding(binding: &LedgerProfileBinding) -> Result<(), String> {
    if !valid_id(&binding.server_id)
        || !valid_id(&binding.account_id)
        || !valid_id(&binding.replica_id)
        || !valid_id(&binding.ledger_id)
        || !valid_id(&binding.stream_epoch)
        || binding.server_public_key.len() < 16
        || binding.server_public_key.len() > 512
        || binding.username.trim().is_empty()
        || binding.username.len() > 128
        || binding.server_url.len() > 2048
        || !(binding.server_url.starts_with("https://")
            || binding.server_url.starts_with("http://"))
    {
        return Err("桌面账本 profile 身份或服务器地址无效".into());
    }
    Ok(())
}

fn profile_id(binding: &LedgerProfileBinding) -> String {
    let mut hash = Sha256::new();
    for value in [&binding.server_id, &binding.account_id, &binding.replica_id] {
        hash.update((value.len() as u32).to_be_bytes());
        hash.update(value.as_bytes());
    }
    let digest = hash.finalize();
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_registry(registry: &Registry) -> Result<(), String> {
    if registry.version != 1 || registry.profiles.is_empty() || registry.profiles.len() > 1000 {
        return Err("桌面账本 profile 目录版本或数量无效".into());
    }
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    for profile in &registry.profiles {
        validate_binding(&profile.binding)?;
        if profile.id != LEGACY_PROFILE_ID && profile.id != profile_id(&profile.binding) {
            return Err("桌面账本 profile 目录包含不匹配的路径标识".into());
        }
        if !ids.insert(profile.id.as_str())
            || !identities.insert((
                profile.binding.server_id.as_str(),
                profile.binding.account_id.as_str(),
                profile.binding.replica_id.as_str(),
            ))
        {
            return Err("桌面账本 profile 目录包含重复的副本".into());
        }
    }
    if !ids.contains(LEGACY_PROFILE_ID) || !ids.contains(registry.active_profile_id.as_str()) {
        return Err("桌面账本 profile 目录缺少当前或原始账本".into());
    }
    Ok(())
}

fn registry_path(data: &Path) -> PathBuf {
    data.join(REGISTRY_FILE)
}

fn read_registry(data: &Path) -> Result<Option<Registry>, String> {
    let path = registry_path(data);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取桌面账本 profile 目录失败：{error}")),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
        || metadata.len() > 256 * 1024
    {
        return Err("桌面账本 profile 目录不是有效普通文件".into());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("读取桌面账本 profile 目录失败：{error}"))?;
    let registry: Registry = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析桌面账本 profile 目录失败：{error}"))?;
    validate_registry(&registry)?;
    Ok(Some(registry))
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x0000_0400 != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let source = wide(temp);
    let destination = wide(target);
    let result = unsafe {
        if target.exists() {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if result == 0 {
        return Err(format!(
            "保存桌面账本 profile 目录失败：{}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| format!("保存桌面账本 profile 目录失败：{error}"))
}

fn write_registry(data: &Path, registry: &Registry) -> Result<(), String> {
    validate_registry(registry)?;
    let path = registry_path(data);
    read_registry(data)?;
    let temp = data.join(format!(".{REGISTRY_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let bytes = serde_json::to_vec(registry).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("创建桌面账本 profile 临时文件失败：{error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("写入桌面账本 profile 目录失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步桌面账本 profile 目录失败：{error}"))?;
        drop(file);
        replace_file(&temp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub fn active_profile(data: &Path) -> Result<Option<LedgerProfile>, String> {
    let Some(registry) = read_registry(data)? else {
        return Ok(None);
    };
    Ok(registry
        .profiles
        .into_iter()
        .find(|profile| profile.id == registry.active_profile_id))
}

pub fn list_profiles(data: &Path) -> Result<Vec<LedgerProfile>, String> {
    Ok(read_registry(data)?.map_or_else(Vec::new, |registry| registry.profiles))
}

pub fn bind_legacy(data: &Path, binding: LedgerProfileBinding) -> Result<LedgerProfile, String> {
    validate_binding(&binding)?;
    let mut registry = read_registry(data)?.unwrap_or(Registry {
        version: 1,
        active_profile_id: LEGACY_PROFILE_ID.into(),
        profiles: Vec::new(),
    });
    if let Some(existing) = registry
        .profiles
        .iter()
        .find(|profile| profile.id == LEGACY_PROFILE_ID)
    {
        if existing.binding.server_id != binding.server_id
            || existing.binding.server_public_key != binding.server_public_key
            || existing.binding.account_id != binding.account_id
            || existing.binding.replica_id != binding.replica_id
            || existing.binding.ledger_id != binding.ledger_id
            || existing.binding.stream_epoch != binding.stream_epoch
        {
            return Err("原始桌面账本已绑定另一账号或副本，拒绝改写 profile".into());
        }
        return Ok(existing.clone());
    }
    let legacy = LedgerProfile {
        id: LEGACY_PROFILE_ID.into(),
        binding,
    };
    registry.profiles.push(legacy.clone());
    write_registry(data, &registry)?;
    Ok(legacy)
}

pub fn select_profile(data: &Path, binding: LedgerProfileBinding) -> Result<LedgerProfile, String> {
    validate_binding(&binding)?;
    let mut registry = read_registry(data)?.ok_or("请先绑定现有桌面账本")?;
    let legacy = registry
        .profiles
        .iter()
        .find(|profile| profile.id == LEGACY_PROFILE_ID)
        .ok_or("原始桌面账本 profile 缺失")?;
    let id = if legacy.binding.server_id == binding.server_id
        && legacy.binding.account_id == binding.account_id
        && legacy.binding.replica_id == binding.replica_id
    {
        if legacy.binding.ledger_id != binding.ledger_id {
            return Err("原始桌面账本的账本 ID 已变化".into());
        }
        if legacy.binding.server_public_key != binding.server_public_key
            || legacy.binding.stream_epoch != binding.stream_epoch
        {
            return Err("原始桌面账本的节点身份或副本世代已变化".into());
        }
        LEGACY_PROFILE_ID.to_string()
    } else {
        profile_id(&binding)
    };
    if let Some(existing) = registry.profiles.iter().find(|profile| profile.id == id) {
        if existing.binding.server_id != binding.server_id
            || existing.binding.server_public_key != binding.server_public_key
            || existing.binding.account_id != binding.account_id
            || existing.binding.replica_id != binding.replica_id
            || existing.binding.ledger_id != binding.ledger_id
            || existing.binding.stream_epoch != binding.stream_epoch
        {
            return Err("桌面账本 profile 身份冲突".into());
        }
    } else {
        registry.profiles.push(LedgerProfile {
            id: id.clone(),
            binding,
        });
    }
    registry.active_profile_id = id.clone();
    write_registry(data, &registry)?;
    registry
        .profiles
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or("桌面账本 profile 选择失败".into())
}

pub fn profile_data_dir(data: &Path, profile: Option<&LedgerProfile>) -> PathBuf {
    match profile {
        Some(profile) if profile.id != LEGACY_PROFILE_ID => {
            data.join("ledger-profiles").join(&profile.id)
        }
        _ => data.to_path_buf(),
    }
}

#[tauri::command]
pub fn desktop_bind_legacy_profile(
    paths: tauri::State<'_, crate::portable::PortablePaths>,
    binding: LedgerProfileBinding,
) -> Result<LedgerProfile, String> {
    if paths.ledger_profile_id != LEGACY_PROFILE_ID {
        return Err("当前桌面窗口不在原始账本 profile".into());
    }
    bind_legacy(&paths.data, binding)
}

#[tauri::command]
pub fn desktop_list_ledger_profiles(
    paths: tauri::State<'_, crate::portable::PortablePaths>,
) -> Result<Vec<LedgerProfile>, String> {
    list_profiles(&paths.data)
}

#[tauri::command]
pub async fn desktop_switch_ledger_profile(
    app: tauri::AppHandle,
    paths: tauri::State<'_, crate::portable::PortablePaths>,
    sql: tauri::State<'_, crate::native_sql::NativeSqlState>,
    binding: LedgerProfileBinding,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app, paths, sql, binding);
        return Err("当前平台尚未提供按账本隔离的 WebView 数据目录".into());
    }
    #[cfg(windows)]
    {
        if sql.has_open_database().await {
            return Err("请先关闭当前桌面账本数据库，再切换账本".into());
        }
        let profile = select_profile(&paths.data, binding)?;
        if profile.id == paths.ledger_profile_id {
            return Err("此账本 profile 已经在当前窗口打开".into());
        }
        crate::stop_server_before_exit(&app);
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zichan-ledger-profile-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            if let (Ok(root), Ok(path)) =
                (std::env::temp_dir().canonicalize(), self.0.canonicalize())
            {
                if path.starts_with(root)
                    && path.file_name().is_some_and(|name| {
                        name.to_string_lossy().starts_with("zichan-ledger-profile-")
                    })
                {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }

    fn binding(replica_id: &str) -> LedgerProfileBinding {
        LedgerProfileBinding {
            server_id: "server-public-0001".into(),
            server_public_key: "public-key-example-0001".into(),
            account_id: "account-owner-0001".into(),
            replica_id: replica_id.into(),
            ledger_id: format!("ledger-{replica_id}"),
            stream_epoch: "stream-epoch-0001".into(),
            server_url: "https://example.com".into(),
            username: "owner".into(),
        }
    }

    #[test]
    fn preserves_legacy_path_and_selects_a_separate_path_for_another_replica() {
        let dir = TestDir::new();
        let data = dir.path();
        fs::File::create(data.join("ledger.sqlite")).unwrap();
        assert!(active_profile(data).unwrap().is_none());
        let legacy = bind_legacy(data, binding("replica-primary-0001")).unwrap();
        assert_eq!(legacy.id, LEGACY_PROFILE_ID);
        assert_eq!(profile_data_dir(data, Some(&legacy)), data);
        let second = select_profile(data, binding("replica-shared-0001")).unwrap();
        assert_ne!(second.id, LEGACY_PROFILE_ID);
        assert!(profile_data_dir(data, Some(&second)).starts_with(data.join("ledger-profiles")));
        assert_eq!(active_profile(data).unwrap().unwrap(), second);
        assert_eq!(list_profiles(data).unwrap().len(), 2);
        assert!(data.join("ledger.sqlite").is_file());
        assert_eq!(
            select_profile(data, binding("replica-primary-0001"))
                .unwrap()
                .id,
            LEGACY_PROFILE_ID
        );
        assert_eq!(active_profile(data).unwrap().unwrap().id, LEGACY_PROFILE_ID);
    }

    #[test]
    fn refuses_rebinding_or_a_corrupt_registry_instead_of_falling_back_to_legacy() {
        let dir = TestDir::new();
        let data = dir.path();
        bind_legacy(data, binding("replica-primary-0001")).unwrap();
        assert!(bind_legacy(data, binding("replica-other-0001")).is_err());
        let mut changed_key = binding("replica-primary-0001");
        changed_key.server_public_key = "different-public-key-0001".into();
        assert!(bind_legacy(data, changed_key).is_err());
        fs::write(data.join(REGISTRY_FILE), b"not json").unwrap();
        assert!(active_profile(data).is_err());
        assert!(select_profile(data, binding("replica-shared-0001")).is_err());
    }
}
