use crate::ledger_profile::{self, LedgerProfileBinding, LEGACY_PROFILE_ID};
use fs2::FileExt;
#[cfg(any(not(debug_assertions), test))]
use serde::Deserialize;
use serde::Serialize;
#[cfg(any(not(debug_assertions), test))]
use sha2::{Digest, Sha256};
#[cfg(any(not(debug_assertions), test))]
use std::{collections::HashSet, io::Read};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub const PORTABLE_FORMAT_VERSION: u32 = 1;
#[cfg(not(debug_assertions))]
const PORTABLE_MARKER_FILE: &str = "portable-mode.json";
#[cfg(not(debug_assertions))]
const INSTALLED_MARKER_FILE: &str = "installed-mode.json";
#[cfg(any(not(debug_assertions), test))]
const PORTABLE_FILES_MANIFEST: &str = "portable-files.json";
#[cfg(any(not(debug_assertions), test))]
const INSTALLED_FILES_MANIFEST: &str = "installed-files.json";
#[cfg(any(not(debug_assertions), test))]
const WEBVIEW2_RUNTIME_LOCK_JSON: &str =
    include_str!("../../../../scripts/release/webview2-runtime.lock.json");

#[derive(Clone, Debug)]
pub struct PortablePaths {
    pub mode: &'static str,
    pub root: PathBuf,
    pub data: PathBuf,
    pub ledger_profile_id: String,
    pub ledger_profile_binding: Option<LedgerProfileBinding>,
    pub ledger_database: PathBuf,
    pub attachments: PathBuf,
    pub backups: PathBuf,
    pub security: PathBuf,
    pub server: PathBuf,
    #[allow(dead_code)]
    pub server_resources: PathBuf,
    pub webview: PathBuf,
    pub logs: PathBuf,
    pub runtime: PathBuf,
    pub filesystem: String,
    pub webview_runtime: WebviewRuntime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebviewRuntime {
    Fixed,
    SystemEvergreen,
    SystemEvergreenFallback,
}

impl WebviewRuntime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::SystemEvergreen => "system-evergreen",
            Self::SystemEvergreenFallback => "system-evergreen-fallback",
        }
    }
}

#[derive(Debug)]
pub struct PortableInstanceLock {
    _file: File,
}

#[derive(Debug)]
pub struct PortableRuntime {
    pub paths: PortablePaths,
    pub lock: PortableInstanceLock,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStorageStatus {
    mode: &'static str,
    format_version: u32,
    root_directory: String,
    data_directory: String,
    ledger_profile_id: String,
    ledger_profile_binding: Option<LedgerProfileBinding>,
    ledger_profile_switch_supported: bool,
    filesystem: String,
    webview_runtime: &'static str,
    server_bind: &'static str,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableMarker {
    format_version: u32,
    app_version: String,
    architecture: String,
    data_directory: String,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledMarker {
    format_version: u32,
    app_version: String,
    architecture: String,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledFileManifest {
    format_version: u32,
    product: String,
    app_version: String,
    architecture: String,
    node_version: String,
    files: Vec<ResourceFileEntry>,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableFileManifest {
    format_version: u32,
    product: String,
    app_version: String,
    architecture: String,
    webview2_runtime_version: String,
    node_version: String,
    files: Vec<ResourceFileEntry>,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceFileEntry {
    path: String,
    bytes: u64,
    sha256: String,
}

#[cfg(any(not(debug_assertions), test))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebviewRuntimeLock {
    schema_version: u32,
    runtime_version: String,
    architecture: String,
}

impl PortablePaths {
    #[cfg(windows)]
    pub fn prepare() -> Result<PortableRuntime, String> {
        let (mut prepared, fixed_runtime, strict_resources) = prepare_layout()?;
        write_probe(&prepared.runtime)?;
        let lock = acquire_instance_lock(&prepared.runtime)?;
        reject_reparse_points_recursively(&prepared.data)?;
        let selected_runtime = select_runtime(
            &prepared.filesystem,
            fixed_runtime.as_deref(),
            strict_resources,
        )?;
        prepared.webview_runtime = if prepared.mode == "installed" {
            WebviewRuntime::SystemEvergreen
        } else {
            selected_runtime
        };
        create_managed_directories(&prepared)?;
        Ok(PortableRuntime {
            paths: prepared,
            lock,
        })
    }

    #[cfg(not(windows))]
    pub fn from_platform_app(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let local_data = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        let resources = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        #[cfg(all(target_os = "linux", not(debug_assertions)))]
        {
            if !cfg!(target_arch = "x86_64") {
                return Err("Linux 发行版只支持 x64".into());
            }
            validate_installed_resource_manifest(&resources)?;
            let node = resources.join("server").join("node");
            checked_regular_file(&node, "内置 Node.js")?;
            use std::os::unix::fs::PermissionsExt;
            if node
                .metadata()
                .map_err(|error| format!("读取内置 Node.js 权限失败：{error}"))?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err("内置 Node.js 缺少执行权限".into());
            }
        }
        let paths = Self {
            mode: "platform",
            root: data.clone(),
            ledger_profile_id: LEGACY_PROFILE_ID.into(),
            ledger_profile_binding: None,
            ledger_database: data.join("ledger.sqlite"),
            attachments: data.join("attachments"),
            backups: data.join("backups"),
            security: local_data.join("security"),
            server: data.join("server"),
            server_resources: resources.join("server"),
            webview: local_data.join("webview"),
            logs: data.join("logs"),
            runtime: data.join("runtime"),
            data,
            filesystem: "platform".into(),
            webview_runtime: WebviewRuntime::SystemEvergreenFallback,
        };
        create_managed_directories(&paths)?;
        Ok(paths)
    }

    pub fn storage_status(&self) -> DesktopStorageStatus {
        DesktopStorageStatus {
            mode: self.mode,
            format_version: PORTABLE_FORMAT_VERSION,
            root_directory: self.root.display().to_string(),
            data_directory: self.data.display().to_string(),
            ledger_profile_id: self.ledger_profile_id.clone(),
            ledger_profile_binding: self.ledger_profile_binding.clone(),
            ledger_profile_switch_supported: cfg!(windows),
            filesystem: self.filesystem.clone(),
            webview_runtime: self.webview_runtime.as_str(),
            server_bind: "0.0.0.0",
        }
    }
}

#[tauri::command]
pub fn desktop_storage_status(paths: tauri::State<'_, PortablePaths>) -> DesktopStorageStatus {
    paths.storage_status()
}

#[cfg(windows)]
fn prepare_layout() -> Result<(PortablePaths, Option<PathBuf>, bool), String> {
    #[cfg(debug_assertions)]
    let (mode, root, data, server_resources, fixed_runtime, strict_resources) = {
        let repo = find_repo_root()
            .ok_or_else(|| "无法定位项目根目录；请从项目目录运行桌面开发命令".to_string())?;
        let root = debug_runtime_root(
            &repo,
            std::env::var_os("ZICHAN_PORTABLE_TEST_ROOT").map(PathBuf::from),
        )?;
        let server_resources = repo.join("apps").join("desktop").join("resources");
        let data = root.join("data");
        ("portable", root, data, server_resources, None, false)
    };

    #[cfg(not(debug_assertions))]
    let (mode, root, data, server_resources, fixed_runtime, strict_resources) = {
        if !cfg!(target_arch = "x86_64") {
            return Err("Windows 发行版只支持 x64".into());
        }
        let executable =
            std::env::current_exe().map_err(|error| format!("无法读取程序路径：{error}"))?;
        let executable_root = executable
            .parent()
            .ok_or("程序路径没有父目录")?
            .to_path_buf();
        reject_reparse_point(&executable_root, "程序目录")?;
        let installation_root = canonicalize_directory(&executable_root, "程序目录")?;
        let portable = installation_root.join(PORTABLE_MARKER_FILE).exists();
        let installed = installation_root.join(INSTALLED_MARKER_FILE).exists();
        if portable == installed {
            return Err("程序目录必须且只能包含 portable-mode.json 或 installed-mode.json".into());
        }
        let server_resources = installation_root.join("server");
        if portable {
            validate_marker(&installation_root.join(PORTABLE_MARKER_FILE))?;
            let fixed_runtime = installation_root.join("runtime").join("webview2");
            validate_release_resources(&installation_root, &server_resources, &fixed_runtime)?;
            let data = installation_root.join("data");
            (
                "portable",
                installation_root,
                data,
                server_resources,
                Some(fixed_runtime),
                true,
            )
        } else {
            validate_installed_marker(&installation_root.join(INSTALLED_MARKER_FILE))?;
            validate_installed_resources(&installation_root, &server_resources)?;
            let data = installed_data_root(&installation_root)?;
            (
                "installed",
                data.clone(),
                data,
                server_resources,
                None,
                false,
            )
        }
    };

    #[cfg(debug_assertions)]
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建开发便携目录 {} 失败：{error}", root.display()))?;
    let root = canonicalize_directory(&root, "数据根目录")?;
    let filesystem = local_filesystem(&root)?;
    if data.exists() {
        ensure_existing_path_within(&root, &data, "数据目录")?;
    }
    fs::create_dir_all(data.join("runtime"))
        .map_err(|error| format!("创建运行目录失败：{error}"))?;
    ensure_existing_path_within(&root, &data, "数据目录")?;
    ensure_existing_path_within(&root, &data.join("runtime"), "运行目录")?;

    let active_profile = ledger_profile::active_profile(&data)?;
    let ledger_data = ledger_profile::profile_data_dir(&data, active_profile.as_ref());

    let paths = PortablePaths {
        mode,
        root: root.clone(),
        ledger_profile_id: active_profile
            .as_ref()
            .map_or(LEGACY_PROFILE_ID.to_string(), |profile| profile.id.clone()),
        ledger_profile_binding: active_profile
            .as_ref()
            .map(|profile| profile.binding.clone()),
        ledger_database: ledger_data.join("ledger").join("ledger.sqlite"),
        attachments: ledger_data.join("attachments"),
        backups: ledger_data.join("backups"),
        security: ledger_data.join("security"),
        server: data.join("server"),
        server_resources,
        webview: ledger_data.join("webview"),
        logs: data.join("logs"),
        runtime: data.join("runtime"),
        data,
        filesystem,
        webview_runtime: WebviewRuntime::SystemEvergreenFallback,
    };
    Ok((paths, fixed_runtime, strict_resources))
}

fn create_managed_directories(paths: &PortablePaths) -> Result<(), String> {
    let directories = vec![
        paths
            .ledger_database
            .parent()
            .ok_or("数据库目录无效")?
            .to_path_buf(),
        paths.attachments.clone(),
        paths.attachments.join("staging"),
        paths.attachments.join("objects"),
        paths.attachments.join("trash"),
        paths.attachments.join("quarantine"),
        paths.backups.clone(),
        paths.security.clone(),
        paths.server.clone(),
        paths.webview.clone(),
        paths.logs.clone(),
        paths.runtime.clone(),
    ];
    for directory in directories {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("创建桌面数据目录 {} 失败：{error}", directory.display()))?;
        #[cfg(windows)]
        ensure_existing_path_within(&paths.root, &directory, "桌面数据子目录")?;
    }
    Ok(())
}

fn canonicalize_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("无法解析{label} {}：{error}", path.display()))
}

fn ensure_existing_path_within(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let resolved = path
        .canonicalize()
        .map_err(|error| format!("无法解析{label} {}：{error}", path.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!(
            "{label}通过链接指向数据根目录之外：{}",
            path.display()
        ));
    }
    Ok(())
}

fn write_probe(runtime: &Path) -> Result<(), String> {
    let source = runtime.join(format!(".write-probe-{}", std::process::id()));
    let target = runtime.join(format!(".write-probe-{}-renamed", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&source)
            .map_err(|error| format!("数据目录不可写：{error}"))?;
        file.write_all(b"zichan-portable-write-probe")
            .map_err(|error| format!("数据目录写入失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("数据目录同步失败：{error}"))?;
        drop(file);
        fs::rename(&source, &target).map_err(|error| format!("数据目录原子重命名失败：{error}"))?;
        fs::remove_file(&target).map_err(|error| format!("数据目录清理失败：{error}"))?;
        Ok(())
    })();
    if source.exists() {
        let _ = fs::remove_file(&source);
    }
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    result
}

fn acquire_instance_lock(runtime: &Path) -> Result<PortableInstanceLock, String> {
    let path = runtime.join("app.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|error| format!("打开桌面实例锁失败：{error}"))?;
    file.try_lock_exclusive().map_err(|error| {
        let contended = fs2::lock_contended_error();
        if error.kind() == std::io::ErrorKind::WouldBlock
            || error.raw_os_error() == contended.raw_os_error()
        {
            "这个数据目录已经由另一个资产生命周期实例打开；请先关闭它".to_string()
        } else {
            format!("锁定数据目录失败：{error}")
        }
    })?;
    Ok(PortableInstanceLock { _file: file })
}

#[cfg(windows)]
fn reject_reparse_points_recursively(path: &Path) -> Result<(), String> {
    reject_reparse_points_recursively_inner(path, false)
}

#[cfg(windows)]
fn reject_reparse_points_recursively_inner(path: &Path, may_disappear: bool) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        // WebView2 and upload staging remove temporary children while this scan is running.
        // A vanished child cannot be followed as a reparse point; the data root must exist.
        Err(error) if may_disappear && error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "读取桌面数据元数据 {} 失败：{error}",
                path.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(format!(
            "桌面数据目录中不允许链接或重解析点：{}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if may_disappear && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(());
            }
            Err(error) => {
                return Err(format!("读取桌面数据目录 {} 失败：{error}", path.display()));
            }
        };
        for entry in entries {
            let child = entry
                .map_err(|error| format!("读取桌面数据项失败：{error}"))?
                .path();
            reject_reparse_points_recursively_inner(&child, true)?;
        }
    } else if !metadata.is_file() {
        return Err(format!(
            "桌面数据中包含不支持的文件类型：{}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(all(windows, any(not(debug_assertions), test)))]
fn reject_reparse_point(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取{label}元数据 {} 失败：{error}", path.display()))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(format!("{label}不允许是链接或重解析点：{}", path.display()));
    }
    if !metadata.is_dir() {
        return Err(format!("{label}不是目录：{}", path.display()));
    }
    Ok(())
}

#[cfg(all(windows, not(debug_assertions)))]
fn validate_marker(path: &Path) -> Result<(), String> {
    checked_regular_file(path, "portable-mode.json")?;
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "缺少或无法读取 {}；请完整解压官方便携 ZIP：{error}",
            path.display()
        )
    })?;
    let marker: PortableMarker =
        serde_json::from_slice(&bytes).map_err(|error| format!("便携标记格式无效：{error}"))?;
    validate_marker_value(
        &marker,
        env!("CARGO_PKG_VERSION"),
        if cfg!(target_arch = "x86_64") {
            "x64"
        } else {
            std::env::consts::ARCH
        },
    )
}

#[cfg(all(windows, not(debug_assertions)))]
fn validate_installed_marker(path: &Path) -> Result<(), String> {
    checked_regular_file(path, INSTALLED_MARKER_FILE)?;
    let bytes = fs::read(path).map_err(|error| format!("读取安装标记失败：{error}"))?;
    let marker: InstalledMarker =
        serde_json::from_slice(&bytes).map_err(|error| format!("安装标记格式无效：{error}"))?;
    validate_installed_marker_value(&marker)
}

#[cfg(any(not(debug_assertions), test))]
fn validate_installed_marker_value(marker: &InstalledMarker) -> Result<(), String> {
    if marker.format_version != 1
        || marker.app_version != env!("CARGO_PKG_VERSION")
        || marker.architecture != "x64"
    {
        return Err("安装标记的格式、版本或架构与程序不匹配".into());
    }
    Ok(())
}

#[cfg(all(windows, not(debug_assertions)))]
fn installed_data_root(installation_root: &Path) -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or("缺少 LOCALAPPDATA；无法确定安装版数据目录")?;
    let parent = PathBuf::from(local_app_data);
    validate_windows_disk_path(&parent)?;
    let parent = canonicalize_directory(&parent, "用户本地数据目录")?;
    let data = parent.join("com.zichan.ledger");
    if data.starts_with(installation_root) || installation_root.starts_with(&data) {
        return Err("安装目录与用户数据目录不能相互包含".into());
    }
    if data.exists() {
        reject_reparse_point(&data, "安装版数据目录")?;
    }
    fs::create_dir_all(&data).map_err(|error| format!("创建安装版数据目录失败：{error}"))?;
    reject_reparse_point(&data, "安装版数据目录")?;
    let resolved = canonicalize_directory(&data, "安装版数据目录")?;
    if resolved != data {
        return Err("安装版数据目录不能通过链接重定向".into());
    }
    Ok(data)
}

#[cfg(any(not(debug_assertions), test))]
fn validate_marker_value(
    marker: &PortableMarker,
    expected_version: &str,
    expected_architecture: &str,
) -> Result<(), String> {
    if marker.format_version != PORTABLE_FORMAT_VERSION {
        return Err(format!(
            "不支持的便携目录格式版本 {}",
            marker.format_version
        ));
    }
    if marker.app_version != expected_version {
        return Err(format!(
            "便携标记版本 {} 与程序版本 {expected_version} 不一致",
            marker.app_version
        ));
    }
    if marker.architecture != expected_architecture {
        return Err(format!(
            "便携标记架构 {} 与程序架构 {expected_architecture} 不一致",
            marker.architecture
        ));
    }
    if marker.data_directory != "data" {
        return Err("便携标记中的 dataDirectory 必须严格为 data".into());
    }
    Ok(())
}

#[cfg(all(windows, not(debug_assertions)))]
fn validate_release_resources(
    root: &Path,
    server: &Path,
    fixed_runtime: &Path,
) -> Result<(), String> {
    validate_resource_manifest(root)?;
    for (path, label) in [
        (server.join("node.exe"), "内置 Node.js"),
        (server.join("server.mjs"), "同步服务器入口"),
        (server.join("web").join("index.html"), "内置 Web 页面"),
        (fixed_runtime.join("msedgewebview2.exe"), "固定版 WebView2"),
    ] {
        if !path.is_file() {
            return Err(format!(
                "缺少{label}：{}；请完整解压便携 ZIP",
                path.display()
            ));
        }
        ensure_existing_path_within(root, &path, label)?;
    }
    ensure_existing_path_within(root, server, "服务器资源目录")?;
    ensure_existing_path_within(root, fixed_runtime, "WebView2 资源目录")?;
    Ok(())
}

#[cfg(all(windows, not(debug_assertions)))]
fn validate_installed_resources(root: &Path, server: &Path) -> Result<(), String> {
    validate_installed_resource_manifest(root)?;
    for (path, label) in [
        (server.join("node.exe"), "内置 Node.js"),
        (server.join("server.mjs"), "同步服务器入口"),
        (server.join("web").join("index.html"), "内置 Web 页面"),
    ] {
        checked_regular_file(&path, label)?;
        ensure_existing_path_within(root, &path, label)?;
    }
    ensure_existing_path_within(root, server, "服务器资源目录")?;
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn validate_installed_resource_manifest(root: &Path) -> Result<(), String> {
    let path = root.join(INSTALLED_FILES_MANIFEST);
    checked_regular_file(&path, INSTALLED_FILES_MANIFEST)?;
    let manifest: InstalledFileManifest = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("读取安装资源清单失败：{error}"))?,
    )
    .map_err(|error| format!("安装资源清单格式无效：{error}"))?;
    if manifest.format_version != 1
        || manifest.product != "资产生命周期"
        || manifest.app_version != env!("CARGO_PKG_VERSION")
        || manifest.architecture != "x64"
        || manifest.node_version != include_str!("../../../../.node-version").trim()
    {
        return Err("安装资源清单的产品、版本、架构或 Node.js 版本不匹配".into());
    }
    let mut expected = HashSet::new();
    for entry in &manifest.files {
        let relative = safe_manifest_path(&entry.path)?;
        if !entry.path.to_ascii_lowercase().starts_with("server/") {
            return Err(format!("安装资源清单包含非法范围：{}", entry.path));
        }
        let key = entry.path.to_lowercase();
        if !expected.insert(key) {
            return Err(format!("安装资源清单包含重复路径：{}", entry.path));
        }
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!("安装资源 SHA-256 无效：{}", entry.path));
        }
        let file = root.join(relative);
        let metadata = checked_regular_file(&file, &entry.path)?;
        if metadata.len() != entry.bytes || sha256_file(&file)? != entry.sha256 {
            return Err(format!("安装资源大小或哈希不匹配：{}", entry.path));
        }
    }
    let mut actual = HashSet::new();
    collect_protected_files(root, &root.join("server"), &mut actual)?;
    if actual != expected {
        return Err("安装资源清单与 server/ 文件内容不一致".into());
    }
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn validate_resource_manifest(root: &Path) -> Result<(), String> {
    let manifest_path = root.join(PORTABLE_FILES_MANIFEST);
    checked_regular_file(&manifest_path, PORTABLE_FILES_MANIFEST)?;
    let bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "缺少或无法读取便携文件清单 {}：{error}",
            manifest_path.display()
        )
    })?;
    let manifest: PortableFileManifest =
        serde_json::from_slice(&bytes).map_err(|error| format!("便携文件清单格式无效：{error}"))?;
    let runtime_lock: WebviewRuntimeLock = serde_json::from_str(WEBVIEW2_RUNTIME_LOCK_JSON)
        .map_err(|error| format!("编译内置的 WebView2 版本锁无效：{error}"))?;
    if runtime_lock.schema_version != 1
        || runtime_lock.architecture != "x64"
        || runtime_lock.runtime_version.trim().is_empty()
    {
        return Err("编译内置的 WebView2 版本锁元数据无效".into());
    }
    if manifest.format_version != PORTABLE_FORMAT_VERSION
        || manifest.product != "资产生命周期"
        || manifest.app_version != env!("CARGO_PKG_VERSION")
        || manifest.architecture != "x64"
        || manifest.webview2_runtime_version != runtime_lock.runtime_version
        || manifest.node_version != include_str!("../../../../.node-version").trim()
    {
        return Err("便携文件清单的产品、版本、架构或 WebView2 版本不匹配".into());
    }

    let mut all_paths = HashSet::new();
    let mut expected_resources = HashSet::new();
    for entry in &manifest.files {
        let relative = safe_manifest_path(&entry.path)?;
        let comparison_key = entry.path.to_lowercase();
        if !all_paths.insert(comparison_key) {
            return Err(format!("便携文件清单包含重复路径：{}", entry.path));
        }
        if entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!("便携文件清单 SHA-256 无效：{}", entry.path));
        }
        if is_protected_resource(&entry.path) {
            let absolute = root.join(&relative);
            let metadata = checked_regular_file(&absolute, &entry.path)?;
            if metadata.len() != entry.bytes {
                return Err(format!("便携资源大小不匹配：{}", entry.path));
            }
            if sha256_file(&absolute)? != entry.sha256 {
                return Err(format!("便携资源哈希不匹配：{}", entry.path));
            }
            expected_resources.insert(entry.path.to_lowercase());
        }
    }

    let mut actual_resources = HashSet::new();
    collect_protected_files(root, &root.join("server"), &mut actual_resources)?;
    collect_protected_files(
        root,
        &root.join("runtime").join("webview2"),
        &mut actual_resources,
    )?;
    if actual_resources != expected_resources {
        let missing = expected_resources
            .difference(&actual_resources)
            .next()
            .cloned();
        let extra = actual_resources
            .difference(&expected_resources)
            .next()
            .cloned();
        return Err(format!(
            "便携资源清单与磁盘内容不一致（缺失：{}；额外：{}）",
            missing.as_deref().unwrap_or("无"),
            extra.as_deref().unwrap_or("无")
        ));
    }
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn safe_manifest_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return Err(format!("便携文件清单路径不安全：{value}"));
    }
    let mut result = PathBuf::new();
    for component in value.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(':')
            || component.contains('\0')
        {
            return Err(format!("便携文件清单路径不安全：{value}"));
        }
        result.push(component);
    }
    Ok(result)
}

#[cfg(any(not(debug_assertions), test))]
fn is_protected_resource(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("server/") || lower.starts_with("runtime/webview2/")
}

#[cfg(any(not(debug_assertions), test))]
fn checked_regular_file(path: &Path, label: &str) -> Result<fs::Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("便携资源缺失 {label}：{error}"))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(format!("便携资源不允许使用链接或重解析点：{label}"));
    }
    if !metadata.is_file() {
        return Err(format!("便携资源不是普通文件：{label}"));
    }
    Ok(metadata)
}

#[cfg(any(not(debug_assertions), test))]
fn collect_protected_files(
    root: &Path,
    directory: &Path,
    result: &mut HashSet<String>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("便携资源目录缺失或不可读 {}：{error}", directory.display()))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(format!(
            "便携资源目录不允许使用链接或重解析点：{}",
            directory.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("便携资源路径不是目录：{}", directory.display()));
    }
    for entry in
        fs::read_dir(directory).map_err(|error| format!("读取便携资源目录失败：{error}"))?
    {
        let path = entry
            .map_err(|error| format!("读取便携资源项失败：{error}"))?
            .path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("读取便携资源元数据失败：{error}"))?;
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err(format!(
                "便携资源不允许使用链接或重解析点：{}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            collect_protected_files(root, &path, result)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "便携资源越出根目录")?
                .to_str()
                .ok_or("便携资源路径不是有效 UTF-8")?
                .replace('\\', "/")
                .to_lowercase();
            result.insert(relative);
        } else {
            return Err(format!("便携资源包含不支持的文件类型：{}", path.display()));
        }
    }
    Ok(())
}

#[cfg(any(not(debug_assertions), test))]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("读取便携资源 {} 失败：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("计算便携资源哈希失败：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
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

#[cfg(all(windows, debug_assertions))]
fn find_repo_root() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        starts.push(current);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    starts.into_iter().find_map(|start| {
        start.ancestors().find_map(|candidate| {
            if candidate
                .join("apps/desktop/src-tauri/Cargo.toml")
                .is_file()
                && candidate.join("apps/sync-server").is_dir()
            {
                Some(candidate.to_path_buf())
            } else {
                None
            }
        })
    })
}

#[cfg(all(windows, debug_assertions))]
fn debug_runtime_root(repo: &Path, override_path: Option<PathBuf>) -> Result<PathBuf, String> {
    match override_path {
        Some(path) if path.is_absolute() => Ok(path),
        Some(_) => Err("ZICHAN_PORTABLE_TEST_ROOT 必须是绝对路径".into()),
        None => Ok(repo.join(".runtime").join("desktop")),
    }
}

#[cfg(windows)]
fn select_runtime(
    filesystem: &str,
    fixed_runtime: Option<&Path>,
    strict_resources: bool,
) -> Result<WebviewRuntime, String> {
    std::env::remove_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER");
    if !strict_resources {
        ensure_system_webview2()?;
        return Ok(WebviewRuntime::SystemEvergreenFallback);
    }
    let fixed_runtime = fixed_runtime.ok_or("固定版 WebView2 路径缺失")?;
    let version = windows_version::OsVersion::current();
    let acl_granted = filesystem.eq_ignore_ascii_case("NTFS")
        && version.major == 10
        && version.build < 22_000
        && grant_webview_acl(fixed_runtime).is_ok();
    let selected = runtime_decision(version.major, version.build, filesystem, acl_granted)?;
    match selected {
        WebviewRuntime::Fixed => {
            std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", fixed_runtime);
        }
        WebviewRuntime::SystemEvergreen | WebviewRuntime::SystemEvergreenFallback => {
            ensure_system_webview2()?
        }
    }
    Ok(selected)
}

fn runtime_decision(
    os_major: u32,
    os_build: u32,
    filesystem: &str,
    fixed_runtime_acl_granted: bool,
) -> Result<WebviewRuntime, String> {
    if os_major < 10 {
        return Err("便携版要求 Windows 10 或 Windows 11".into());
    }
    if os_major > 10 || os_build >= 22_000 {
        return Ok(WebviewRuntime::Fixed);
    }
    if filesystem.eq_ignore_ascii_case("NTFS") && fixed_runtime_acl_granted {
        Ok(WebviewRuntime::Fixed)
    } else {
        Ok(WebviewRuntime::SystemEvergreenFallback)
    }
}

fn normalize_supported_filesystem(name: &str) -> Result<&'static str, String> {
    if name.eq_ignore_ascii_case("NTFS") {
        Ok("NTFS")
    } else if name.eq_ignore_ascii_case("exFAT") {
        Ok("exFAT")
    } else {
        Err(format!(
            "桌面数据目录仅支持 NTFS 或 exFAT，当前文件系统为 {name}"
        ))
    }
}

#[cfg(windows)]
fn ensure_system_webview2() -> Result<(), String> {
    tauri::webview_version()
        .map(|_| ())
        .map_err(|error| format!("系统未安装 Microsoft Edge WebView2 Runtime：{error}"))
}

#[cfg(windows)]
fn grant_webview_acl(runtime: &Path) -> Result<(), String> {
    for sid in ["*S-1-15-2-2:(OI)(CI)(RX)", "*S-1-15-2-1:(OI)(CI)(RX)"] {
        let mut command = Command::new("icacls.exe");
        command
            .arg(runtime)
            .args(["/grant", sid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut command);
        let status = command
            .status()
            .map_err(|error| format!("无法运行 icacls：{error}"))?;
        if !status.success() {
            return Err(format!("icacls 设置 AppContainer 权限失败：{status}"));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn local_filesystem(_path: &Path) -> Result<String, String> {
    Ok("local".into())
}

#[cfg(windows)]
fn local_filesystem(path: &Path) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetVolumeInformationW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_FIXED, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    validate_windows_disk_path(path)?;
    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut volume_root = vec![0_u16; 32_768];
    let volume_ok = unsafe {
        GetVolumePathNameW(
            input.as_ptr(),
            volume_root.as_mut_ptr(),
            u32::try_from(volume_root.len()).expect("volume buffer fits u32"),
        )
    };
    if volume_ok == 0 {
        return Err(format!(
            "无法识别便携目录所在磁盘：{}",
            std::io::Error::last_os_error()
        ));
    }
    let drive_type = unsafe { GetDriveTypeW(volume_root.as_ptr()) };
    if drive_type == DRIVE_REMOTE {
        return Err("便携版不支持映射网络盘或远程磁盘".into());
    }
    if drive_type != DRIVE_FIXED && drive_type != DRIVE_REMOVABLE {
        return Err("便携版只支持本地磁盘和可移动磁盘".into());
    }
    let mut filesystem = vec![0_u16; 64];
    let info_ok = unsafe {
        GetVolumeInformationW(
            volume_root.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem.as_mut_ptr(),
            u32::try_from(filesystem.len()).expect("filesystem buffer fits u32"),
        )
    };
    if info_ok == 0 {
        return Err(format!(
            "无法读取便携磁盘文件系统：{}",
            std::io::Error::last_os_error()
        ));
    }
    let length = filesystem
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(filesystem.len());
    let name = String::from_utf16_lossy(&filesystem[..length]);
    normalize_supported_filesystem(&name).map(str::to_string)
}

#[cfg(windows)]
fn validate_windows_disk_path(path: &Path) -> Result<(), String> {
    match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_) => {}
            std::path::Prefix::UNC(_, _) | std::path::Prefix::VerbatimUNC(_, _) => {
                return Err("便携版不支持 UNC 或网络共享目录".into())
            }
            _ => return Err("便携版不支持设备路径或非磁盘路径".into()),
        },
        _ => return Err("便携根目录必须是绝对磁盘路径".into()),
    }
    Ok(())
}

pub fn show_native_error(message: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let text: Vec<u16> = std::ffi::OsStr::new(message)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let title: Vec<u16> = std::ffi::OsStr::new("资产生命周期 · 便携版启动失败")
            .encode_wide()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
            );
        }
    }
    #[cfg(not(windows))]
    eprintln!("资产生命周期启动失败：{message}");
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_instance_lock, debug_runtime_root, local_filesystem,
        normalize_supported_filesystem, runtime_decision, safe_manifest_path, sha256_file,
        validate_installed_marker_value, validate_installed_resource_manifest,
        validate_marker_value, validate_resource_manifest, validate_windows_disk_path,
        InstalledMarker, PortableMarker, WebviewRuntime, WebviewRuntimeLock,
        INSTALLED_FILES_MANIFEST, PORTABLE_FORMAT_VERSION, WEBVIEW2_RUNTIME_LOCK_JSON,
    };
    #[cfg(windows)]
    use super::{reject_reparse_point, reject_reparse_points_recursively};
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn marker() -> PortableMarker {
        PortableMarker {
            format_version: PORTABLE_FORMAT_VERSION,
            app_version: "0.1.0".into(),
            architecture: "x64".into(),
            data_directory: "data".into(),
        }
    }

    #[test]
    fn installed_marker_requires_exact_version_and_architecture() {
        let marker = InstalledMarker {
            format_version: 1,
            app_version: env!("CARGO_PKG_VERSION").into(),
            architecture: "x64".into(),
        };
        assert!(validate_installed_marker_value(&marker).is_ok());
        let mut wrong_arch = marker;
        wrong_arch.architecture = "arm64".into();
        assert!(validate_installed_marker_value(&wrong_arch).is_err());
    }

    #[test]
    fn marker_contract_is_exact() {
        assert!(validate_marker_value(&marker(), "0.1.0", "x64").is_ok());
        let mut invalid = marker();
        invalid.data_directory = "../AppData".into();
        assert!(validate_marker_value(&invalid, "0.1.0", "x64").is_err());
        let mut future = marker();
        future.format_version += 1;
        assert!(validate_marker_value(&future, "0.1.0", "x64").is_err());
        let mut wrong_version = marker();
        wrong_version.app_version = "1.0.0".into();
        assert!(validate_marker_value(&wrong_version, "0.1.0", "x64").is_err());
    }

    #[test]
    fn marker_rejects_unknown_fields() {
        let value = r#"{
          "formatVersion": 1,
          "appVersion": "0.1.0",
          "architecture": "x64",
          "dataDirectory": "data",
          "fallbackDirectory": "AppData"
        }"#;
        assert!(serde_json::from_str::<PortableMarker>(value).is_err());
    }

    #[test]
    fn filesystem_contract_accepts_only_ntfs_and_exfat() {
        assert_eq!(normalize_supported_filesystem("ntfs").unwrap(), "NTFS");
        assert_eq!(normalize_supported_filesystem("EXFAT").unwrap(), "exFAT");
        assert!(normalize_supported_filesystem("FAT32").is_err());
        assert!(normalize_supported_filesystem("ReFS").is_err());
    }

    #[test]
    fn webview_runtime_matrix_is_deterministic() {
        for filesystem in ["NTFS", "exFAT"] {
            assert_eq!(
                runtime_decision(10, 22_000, filesystem, false).unwrap(),
                WebviewRuntime::Fixed
            );
            assert_eq!(
                runtime_decision(11, 1, filesystem, false).unwrap(),
                WebviewRuntime::Fixed
            );
        }
        assert_eq!(
            runtime_decision(10, 19_045, "NTFS", true).unwrap(),
            WebviewRuntime::Fixed
        );
        assert_eq!(
            runtime_decision(10, 19_045, "NTFS", false).unwrap(),
            WebviewRuntime::SystemEvergreenFallback
        );
        assert_eq!(
            runtime_decision(10, 19_045, "exFAT", false).unwrap(),
            WebviewRuntime::SystemEvergreenFallback
        );
        assert!(runtime_decision(6, 9_600, "NTFS", true).is_err());
    }

    #[test]
    fn instance_lock_rejects_a_second_instance_for_the_same_directory() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "zichan-portable-lock-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create lock fixture");
        let first = acquire_instance_lock(&directory).expect("acquire first instance lock");
        assert!(acquire_instance_lock(&directory).is_err());
        drop(first);
        let after_release =
            acquire_instance_lock(&directory).expect("lock must be reusable after release");
        drop(after_release);
        fs::remove_dir_all(directory).expect("remove lock fixture");
    }

    #[cfg(windows)]
    #[test]
    fn portable_data_tree_rejects_reparse_points() {
        use std::os::windows::fs::{symlink_dir, symlink_file};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zichan-portable-reparse-{}-{nonce}",
            std::process::id()
        ));
        let data = root.join("data");
        let outside = root.join("outside.txt");
        fs::create_dir_all(data.join("ledger")).expect("create data fixture");
        fs::write(data.join("ledger").join("ledger.sqlite"), b"fixture")
            .expect("write ordinary file fixture");
        fs::write(&outside, b"outside").expect("write outside fixture");
        assert!(reject_reparse_points_recursively(&data).is_ok());

        let link = data.join("ledger").join("escaped.sqlite");
        if symlink_file(&outside, &link).is_ok() {
            assert!(reject_reparse_points_recursively(&data).is_err());
            fs::remove_file(&link).expect("remove symlink fixture");
        }

        let linked_root = root.join("linked-root");
        if symlink_dir(&data, &linked_root).is_ok() {
            assert!(reject_reparse_point(&linked_root, "程序目录").is_err());
            fs::remove_dir(&linked_root).expect("remove directory symlink fixture");
        }
        fs::remove_dir_all(root).expect("remove reparse fixture");
    }

    #[test]
    fn windows_path_classifier_accepts_verbatim_local_but_rejects_unc() {
        assert!(validate_windows_disk_path(Path::new(r"C:\portable")).is_ok());
        assert!(validate_windows_disk_path(Path::new(r"\\?\C:\portable")).is_ok());
        assert!(validate_windows_disk_path(Path::new(r"\\server\share\portable")).is_err());
        assert!(validate_windows_disk_path(Path::new(r"\\?\UNC\server\share\portable")).is_err());
        let canonical_temp = std::env::temp_dir()
            .canonicalize()
            .expect("canonicalize Windows temp directory");
        assert!(local_filesystem(&canonical_temp).is_ok());
    }

    #[test]
    fn debug_test_root_override_must_be_absolute() {
        let repo = Path::new(r"C:\repo");
        assert_eq!(
            debug_runtime_root(repo, None).unwrap(),
            repo.join(".runtime").join("desktop")
        );
        assert_eq!(
            debug_runtime_root(repo, Some(Path::new(r"D:\portable-test").into())).unwrap(),
            Path::new(r"D:\portable-test")
        );
        assert!(debug_runtime_root(repo, Some(Path::new("relative").into())).is_err());
    }

    #[test]
    fn manifest_paths_reject_traversal_and_windows_aliases() {
        assert_eq!(
            safe_manifest_path("server/web/index.html").unwrap(),
            Path::new("server/web/index.html")
        );
        for invalid in [
            "../server/node.exe",
            "server/../node.exe",
            "/server/node.exe",
            r"server\node.exe",
            "C:/server/node.exe",
            "server//node.exe",
        ] {
            assert!(safe_manifest_path(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn resource_manifest_rejects_hash_mismatch_and_extra_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zichan-portable-manifest-{}-{nonce}",
            std::process::id()
        ));
        let server_file = root.join("server").join("server.mjs");
        let runtime_file = root
            .join("runtime")
            .join("webview2")
            .join("msedgewebview2.exe");
        fs::create_dir_all(server_file.parent().unwrap()).expect("create server fixture");
        fs::create_dir_all(runtime_file.parent().unwrap()).expect("create runtime fixture");
        fs::write(&server_file, b"server").expect("write server fixture");
        fs::write(&runtime_file, b"runtime").expect("write runtime fixture");
        let lock: WebviewRuntimeLock =
            serde_json::from_str(WEBVIEW2_RUNTIME_LOCK_JSON).expect("parse embedded runtime lock");
        let manifest = serde_json::json!({
            "formatVersion": 1,
            "product": "资产生命周期",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "architecture": "x64",
            "webview2RuntimeVersion": lock.runtime_version,
            "nodeVersion": include_str!("../../../../.node-version").trim(),
            "files": [
                {
                    "path": "runtime/webview2/msedgewebview2.exe",
                    "bytes": 7,
                    "sha256": sha256_file(&runtime_file).unwrap()
                },
                {
                    "path": "server/server.mjs",
                    "bytes": 6,
                    "sha256": sha256_file(&server_file).unwrap()
                }
            ]
        });
        fs::write(
            root.join("portable-files.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .expect("write manifest fixture");
        assert!(validate_resource_manifest(&root).is_ok());

        let mut wrong_node_manifest = manifest.clone();
        wrong_node_manifest["nodeVersion"] = serde_json::json!("0.0.0");
        fs::write(
            root.join("portable-files.json"),
            serde_json::to_vec(&wrong_node_manifest).unwrap(),
        )
        .expect("write wrong Node.js version");
        assert!(validate_resource_manifest(&root).is_err());
        fs::write(
            root.join("portable-files.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .expect("restore manifest fixture");

        fs::write(&server_file, b"tampered").expect("tamper resource fixture");
        assert!(validate_resource_manifest(&root).is_err());
        fs::write(&server_file, b"server").expect("restore resource fixture");
        fs::write(root.join("server").join("extra.js"), b"extra")
            .expect("write extra resource fixture");
        assert!(validate_resource_manifest(&root).is_err());
        fs::remove_dir_all(root).expect("remove manifest fixture");
    }

    #[test]
    fn installed_manifest_covers_only_server_resources() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "zichan-installed-manifest-{}-{nonce}",
            std::process::id()
        ));
        let server_file = root.join("server").join("server.mjs");
        fs::create_dir_all(server_file.parent().unwrap()).expect("create server fixture");
        fs::write(&server_file, b"server").expect("write server fixture");
        let manifest = serde_json::json!({
            "formatVersion": 1,
            "product": "资产生命周期",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "architecture": "x64",
            "nodeVersion": include_str!("../../../../.node-version").trim(),
            "files": [{
                "path": "server/server.mjs",
                "bytes": 6,
                "sha256": sha256_file(&server_file).unwrap()
            }]
        });
        fs::write(
            root.join(INSTALLED_FILES_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .expect("write manifest fixture");
        assert!(validate_installed_resource_manifest(&root).is_ok());
        fs::write(root.join("server").join("extra.js"), b"extra").unwrap();
        assert!(validate_installed_resource_manifest(&root).is_err());
        fs::remove_file(root.join("server").join("extra.js")).unwrap();
        fs::write(&server_file, b"tampered").unwrap();
        assert!(validate_installed_resource_manifest(&root).is_err());
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
