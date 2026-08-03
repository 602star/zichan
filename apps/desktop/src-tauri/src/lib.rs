use serde::Serialize;
use std::{
    fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

mod native_attachments;
mod native_sql;
mod desktop_updater;
use native_sql::NativeSqlState;

#[derive(Default)]
struct DesktopServerState {
    child: Mutex<Option<Child>>,
}

impl Drop for DesktopServerState {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *slot = None;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopServerStatus {
    available: bool,
    running: bool,
    managed: bool,
    endpoint: String,
    data_file: Option<String>,
    admin_token_file: Option<String>,
    admin_token: Option<String>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackupStatus {
    directory: String,
    available_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackupWriteResult {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSecurityStatus {
    platform: &'static str,
    mobile: bool,
    stronghold_path: String,
    stronghold_exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackupFile {
    file_name: String,
    path: String,
    size_bytes: u64,
    header_bytes: Vec<u8>,
}

fn server_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("ZichanLedger").join("server");
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        return PathBuf::from(xdg).join("zichan-ledger").join("server");
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
        .join(".zichan-ledger")
        .join("server")
}

fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("backups"))
        .map_err(|error| error.to_string())
}

fn read_admin_token(file: &Path) -> Option<String> {
    fs::read_to_string(file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn local_server_running() -> bool {
    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("static local address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn find_repo_root() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(dir) = std::env::current_dir() {
        starts.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }

    for start in starts {
        for dir in start.ancestors() {
            if dir.join("apps/desktop/scripts/server.mjs").is_file()
                && dir.join("apps/sync-server").is_dir()
            {
                return Some(dir.to_path_buf());
            }
        }
    }
    None
}

fn bundled_server_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("server");
    let runtime = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    if runtime.is_file() && dir.join("server.mjs").is_file() && dir.join("web/index.html").is_file()
    {
        Some(dir)
    } else {
        None
    }
}

fn desktop_status(
    app: &tauri::AppHandle,
    state: &DesktopServerState,
    message: String,
) -> DesktopServerStatus {
    let data_dir = server_data_dir();
    let token_file = data_dir.join("admin-token.txt");
    let managed = state
        .child
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    DesktopServerStatus {
        available: find_repo_root().is_some() || bundled_server_dir(app).is_some(),
        running: local_server_running(),
        managed,
        endpoint: "http://localhost:8787".into(),
        data_file: Some(data_dir.join("server.sqlite").display().to_string()),
        admin_token_file: Some(token_file.display().to_string()),
        admin_token: read_admin_token(&token_file),
        message,
    }
}

fn npm_cmd() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn node_cmd() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
}

fn ensure_server_build(root: &Path) -> Result<(), String> {
    let web_index = root.join("apps/web/dist/index.html");
    let server_entry = root.join("apps/sync-server/dist/main.js");
    if web_index.is_file() && server_entry.is_file() {
        return Ok(());
    }

    let mut cmd = Command::new(npm_cmd());
    cmd.args(["run", "server:build", "--workspace", "@zichan/desktop"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let status = cmd.status().map_err(|e| format!("构建服务失败：{e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("构建服务失败，请在项目根目录运行 npm run server:build -w @zichan/desktop".into())
    }
}

#[tauri::command]
fn desktop_backup_status(app: tauri::AppHandle) -> Result<DesktopBackupStatus, String> {
    let directory = backup_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败：{error}"))?;
    Ok(DesktopBackupStatus {
        available_bytes: fs2::available_space(&directory)
            .map_err(|error| format!("读取备份目录剩余空间失败：{error}"))?,
        directory: directory.display().to_string(),
    })
}

fn checked_backup_name(file_name: &str) -> Result<&str, String> {
    let clean_name = Path::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "备份文件名无效".to_string())?;
    if clean_name != file_name || !clean_name.ends_with(".zcbak") {
        return Err("备份文件名无效".into());
    }
    Ok(clean_name)
}

fn backup_temp_path(app: &tauri::AppHandle, file_name: &str) -> Result<PathBuf, String> {
    Ok(backup_dir(app)?.join(format!(".{file_name}.tmp")))
}

#[tauri::command]
fn desktop_begin_backup_write(
    app: tauri::AppHandle,
    file_name: String,
    estimated_size_bytes: u64,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let dir = backup_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    let available =
        fs2::available_space(&dir).map_err(|error| format!("读取备份目录剩余空间失败：{error}"))?;
    if available < estimated_size_bytes.saturating_add(8 * 1024 * 1024) {
        return Err(format!(
            "备份预计需要 {estimated_size_bytes} 字节，但目录仅剩 {available} 字节"
        ));
    }
    let target = dir.join(clean_name);
    if target.exists() {
        return Err("同名备份已经存在".into());
    }
    let temp = backup_temp_path(&app, clean_name)?;
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(|error| format!("创建临时备份失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("初始化临时备份失败：{error}"))
}

#[tauri::command]
fn desktop_append_backup_chunk(
    app: tauri::AppHandle,
    file_name: String,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    if chunk.is_empty() || chunk.len() > 1024 * 1024 {
        return Err("备份写入分块大小无效".into());
    }
    let temp = backup_temp_path(&app, clean_name)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&temp)
        .map_err(|error| format!("打开临时备份失败：{error}"))?;
    file.write_all(&chunk)
        .map_err(|error| format!("追加备份分块失败：{error}"))
}

#[tauri::command]
fn desktop_commit_backup_write(
    app: tauri::AppHandle,
    file_name: String,
    expected_size_bytes: u64,
) -> Result<DesktopBackupWriteResult, String> {
    let clean_name = checked_backup_name(&file_name)?;
    let dir = backup_dir(&app)?;
    let target = dir.join(clean_name);
    let temp = backup_temp_path(&app, clean_name)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&temp)
        .map_err(|error| format!("打开临时备份失败：{error}"))?;
    file.sync_all()
        .map_err(|error| format!("刷新临时备份失败：{error}"))?;
    let actual = file
        .metadata()
        .map_err(|error| format!("读取临时备份大小失败：{error}"))?
        .len();
    drop(file);
    if actual != expected_size_bytes {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "备份写入长度不一致：应为 {expected_size_bytes}，实际为 {actual}"
        ));
    }
    if target.exists() {
        let _ = fs::remove_file(&temp);
        return Err("同名备份已经存在".into());
    }
    fs::rename(&temp, &target).map_err(|error| format!("原子提交备份失败：{error}"))?;
    Ok(DesktopBackupWriteResult {
        path: target.display().to_string(),
    })
}

#[tauri::command]
fn desktop_abort_backup_write(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let temp = backup_temp_path(&app, clean_name)?;
    if temp.is_file() {
        fs::remove_file(temp).map_err(|error| format!("清理临时备份失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_delete_backup_file(app: tauri::AppHandle, file_name: String) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let target = backup_dir(&app)?.join(clean_name);
    if target.is_file() {
        fs::remove_file(target).map_err(|error| format!("删除轮换备份失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_list_backup_files(app: tauri::AppHandle) -> Result<Vec<DesktopBackupFile>, String> {
    let dir = backup_dir(&app)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|error| format!("读取备份目录失败：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("zcbak"))
        .collect();
    paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    paths
        .into_iter()
        .map(|path| {
            let size_bytes = path
                .metadata()
                .map_err(|error| format!("读取备份 {} 大小失败：{error}", path.display()))?
                .len();
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("读取备份 {} 失败：{error}", path.display()))?;
            let mut header_bytes = vec![
                0_u8;
                usize::try_from(size_bytes.min(1024 * 1024 + 12))
                    .map_err(|_| "备份头长度超出平台限制")?
            ];
            file.read_exact(&mut header_bytes)
                .map_err(|error| format!("读取备份 {} 的归档头失败：{error}", path.display()))?;
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("备份文件名不是有效 UTF-8")?
                .to_string();
            Ok(DesktopBackupFile {
                file_name,
                path: path.display().to_string(),
                size_bytes,
                header_bytes,
            })
        })
        .collect()
}

#[tauri::command]
fn desktop_read_backup_chunk(
    app: tauri::AppHandle,
    file_name: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    let clean_name = checked_backup_name(&file_name)?;
    if length == 0 || length > 1024 * 1024 {
        return Err("备份读取分块大小无效".into());
    }
    let path = backup_dir(&app)?.join(clean_name);
    let mut file = fs::File::open(&path)
        .map_err(|error| format!("打开备份 {} 失败：{error}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|error| format!("读取备份大小失败：{error}"))?
        .len();
    let end = offset
        .checked_add(u64::try_from(length).map_err(|_| "备份读取长度超出平台限制")?)
        .ok_or("备份读取范围溢出")?;
    if end > size {
        return Err("备份读取范围超出文件大小".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位备份分块失败：{error}"))?;
    let mut bytes = vec![0_u8; length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("读取备份分块失败：{error}"))?;
    Ok(bytes)
}

fn security_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("security"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn native_security_status(app: tauri::AppHandle) -> Result<NativeSecurityStatus, String> {
    let stronghold_path = security_dir(&app)?.join("sync-vault.hold");
    Ok(NativeSecurityStatus {
        platform: std::env::consts::OS,
        mobile: cfg!(mobile),
        stronghold_exists: stronghold_path.is_file(),
        stronghold_path: stronghold_path.display().to_string(),
    })
}

#[tauri::command]
fn native_reset_security_vault(app: tauri::AppHandle) -> Result<(), String> {
    let security = security_dir(&app)?;
    for file_name in ["sync-vault.hold", "stronghold-salt.txt"] {
        let path = security.join(file_name);
        if path.is_file() {
            fs::remove_file(&path)
                .map_err(|error| format!("删除安全密码库文件 {} 失败：{error}", path.display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn desktop_server_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopServerState>,
) -> DesktopServerStatus {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *guard = None;
            }
        }
    }
    let msg = if bundled_server_dir(&app).is_some() {
        "安装包已内置 Web 与同步服务器，可在线启动".into()
    } else if find_repo_root().is_some() {
        "开发环境可在线启动本机服务器".into()
    } else {
        "当前安装包尚未内置服务脚本，请使用 npm run start:server".into()
    };
    desktop_status(&app, &state, msg)
}

#[tauri::command]
fn desktop_start_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopServerState>,
) -> DesktopServerStatus {
    if local_server_running() {
        return desktop_status(&app, &state, "本机服务器已经在运行".into());
    }
    let mut cmd = if let Some(bundle) = bundled_server_dir(&app) {
        let mut command =
            Command::new(bundle.join(if cfg!(windows) { "node.exe" } else { "node" }));
        command
            .arg(bundle.join("server.mjs"))
            .current_dir(&bundle)
            .env("WEB_DIST", bundle.join("web"));
        command
    } else if let Some(root) = find_repo_root() {
        if let Err(e) = ensure_server_build(&root) {
            return desktop_status(&app, &state, e);
        }
        let mut command = Command::new(node_cmd());
        command
            .arg("apps/desktop/scripts/server.mjs")
            .current_dir(&root);
        command
    } else {
        return desktop_status(
            &app,
            &state,
            "当前安装包缺少服务器资源，无法在线启动".into(),
        );
    };
    cmd.env("HOST", "0.0.0.0")
        .env("PORT", "8787")
        .env("ALLOW_INSECURE_HTTP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);

    match cmd.spawn() {
        Ok(child) => {
            if let Ok(mut guard) = state.child.lock() {
                *guard = Some(child);
            }
            for _ in 0..20 {
                if local_server_running() {
                    return desktop_status(&app, &state, "本机服务器已启动".into());
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            desktop_status(&app, &state, "已发起启动，但 8787 暂未响应".into())
        }
        Err(e) => desktop_status(&app, &state, format!("启动服务失败：{e}")),
    }
}

#[tauri::command]
fn desktop_stop_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopServerState>,
) -> DesktopServerStatus {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
            return desktop_status(&app, &state, "本机服务器已停止".into());
        }
    }
    if local_server_running() {
        desktop_status(
            &app,
            &state,
            "服务器正在运行，但不是由桌面在线启动，不能安全停止".into(),
        )
    } else {
        desktop_status(&app, &state, "本机服务器未运行".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_system_share::init())
        .manage(DesktopServerState::default())
        .manage(NativeSqlState::default())
        .setup(|app| {
            let security = security_dir(app.handle()).map_err(std::io::Error::other)?;
            fs::create_dir_all(&security)?;
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(
                    &security.join("stronghold-salt.txt"),
                )
                .build(),
            )?;
            #[cfg(mobile)]
            {
                app.handle()
                    .plugin(tauri_plugin_biometric::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
                app.handle().plugin(tauri_plugin_geolocation::init())?;
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_sql::native_sql_database_url,
            native_sql::native_sql_open,
            native_sql::native_sql_close,
            native_sql::native_sql_prepare,
            native_sql::native_sql_execute,
            native_sql::native_sql_select,
            native_sql::native_sql_begin,
            native_sql::native_sql_commit,
            native_sql::native_sql_rollback,
            native_sql::native_sql_database_path,
            native_sql::native_sql_delete_database,
            native_attachments::native_attachment_stage_begin,
            native_attachments::native_attachment_stage_append,
            native_attachments::native_attachment_stage_commit,
            native_attachments::native_attachment_stage_status,
            native_attachments::native_attachment_stage_read_range,
            native_attachments::native_attachment_stage_discard,
            native_attachments::native_attachment_promote,
            native_attachments::native_attachment_status,
            native_attachments::native_attachment_read_range,
            native_attachments::native_attachment_exists,
            native_attachments::native_attachment_trash,
            native_attachments::native_attachment_restore,
            native_attachments::native_attachment_quarantine,
            native_attachments::native_attachment_purge,
            native_attachments::native_attachment_directory,
            native_attachments::native_attachment_storage_status,
            native_attachments::native_attachment_clear,
            native_security_status,
            native_reset_security_vault,
            desktop_server_status,
            desktop_start_server,
            desktop_stop_server,
            desktop_backup_status,
            desktop_begin_backup_write,
            desktop_append_backup_chunk,
            desktop_commit_backup_write,
            desktop_abort_backup_write,
            desktop_read_backup_chunk,
            desktop_list_backup_files,
            desktop_delete_backup_file,
            desktop_updater::desktop_update_status,
            desktop_updater::desktop_check_for_update,
            desktop_updater::desktop_install_update,
            desktop_updater::desktop_confirm_update_healthy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
