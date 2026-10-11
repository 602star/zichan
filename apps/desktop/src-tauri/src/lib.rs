use serde::{Deserialize, Serialize};
use std::{
    fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
mod ledger_profile;
mod native_attachments;
mod native_backup_export;
mod native_sql;
mod portable;
mod restricted_stronghold;
use native_sql::NativeSqlState;
use portable::PortablePaths;

#[derive(Default)]
struct DesktopServerState {
    child: Mutex<Option<Child>>,
}

impl Drop for DesktopServerState {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(mut child) = slot.take() {
                stop_managed_child(&mut child);
            }
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
struct DesktopBackupExportResult {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerHealthResponse {
    ok: bool,
    server_id: String,
}

fn backup_dir(paths: &PortablePaths) -> PathBuf {
    paths.backups.clone()
}

fn local_server_port_open() -> bool {
    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("static local address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn fetch_server_status(path: &str) -> Result<ServerHealthResponse, String> {
    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("static local address");
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(300))
        .map_err(|error| format!("连接 8787 失败：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("设置服务器读取超时失败：{error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| format!("设置服务器写入超时失败：{error}"))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    )
    .map_err(|error| format!("发送服务器状态请求失败：{error}"))?;
    stream
        .flush()
        .map_err(|error| format!("刷新服务器状态请求失败：{error}"))?;
    let mut bytes = Vec::new();
    stream
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取服务器状态失败：{error}"))?;
    let response = String::from_utf8(bytes).map_err(|_| "服务器状态不是有效 UTF-8")?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("8787 返回的不是有效 HTTP 响应")?;
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return Err(format!(
            "服务器状态接口返回异常：{}",
            headers.lines().next().unwrap_or("unknown status")
        ));
    }
    let health: ServerHealthResponse =
        serde_json::from_str(body).map_err(|error| format!("服务器状态 JSON 无效：{error}"))?;
    if !health.ok || health.server_id.trim().is_empty() {
        return Err("服务器状态未就绪或缺少 serverId".into());
    }
    Ok(health)
}

fn read_expected_server_id(paths: &PortablePaths) -> Result<Option<String>, String> {
    let file = paths.server.join("server-id");
    if !file.is_file() {
        return Ok(None);
    }
    let value = fs::read_to_string(&file)
        .map_err(|error| format!("读取服务器身份 {} 失败：{error}", file.display()))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err("服务器身份文件为空".into());
    }
    Ok(Some(value))
}

fn validate_server_identity(paths: &PortablePaths) -> Result<Option<String>, String> {
    let has_state = fs::read_dir(&paths.server)
        .map_err(|error| format!("读取服务器数据目录失败：{error}"))?
        .next()
        .is_some();
    if !has_state {
        return Ok(None);
    }
    for name in [
        "server.sqlite",
        "server.secret",
        "server-id",
        "opaque.server-setup",
    ] {
        let path = paths.server.join(name);
        let metadata = path.metadata().map_err(|_| {
            format!("服务器数据不完整：已有状态但缺少 {name}；为防止身份被静默重建，启动已中止")
        })?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(format!("服务器数据不完整或为空：{name}"));
        }
    }
    read_expected_server_id(paths)
}

fn stop_managed_child(child: &mut Child) {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"shutdown\n");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_server_before_exit(app: &tauri::AppHandle) {
    let state = app.state::<DesktopServerState>();
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            stop_managed_child(&mut child);
        }
    };
}

#[cfg(debug_assertions)]
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

#[cfg(not(debug_assertions))]
fn bundled_server_dir(paths: &PortablePaths) -> Option<PathBuf> {
    let dir = paths.server_resources.clone();
    let runtime = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    if runtime.is_file() && dir.join("server.mjs").is_file() && dir.join("web/index.html").is_file()
    {
        Some(dir)
    } else {
        None
    }
}

#[cfg(debug_assertions)]
fn bundled_server_dir(_paths: &PortablePaths) -> Option<PathBuf> {
    None
}

fn child_process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(unc_path) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc_path}"));
        }
        if let Some(local_path) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(local_path);
        }
    }
    path.to_path_buf()
}

fn user_visible_path(path: &Path) -> String {
    child_process_path(path).display().to_string()
}

fn bundled_server_command(bundle: &Path) -> Command {
    let bundle = child_process_path(bundle);
    let mut command = Command::new(bundle.join(if cfg!(windows) { "node.exe" } else { "node" }));
    // PortablePaths uses Windows extended-length paths after canonicalization. Node.js 26
    // cannot load a `\\\\?\\`-prefixed main-script argument, so keep the entrypoint
    // relative to the explicitly selected bundle directory.
    command
        .arg("server.mjs")
        .current_dir(&bundle)
        .env("WEB_DIST", bundle.join("web"));
    command
}

fn desktop_status(
    paths: &PortablePaths,
    state: &DesktopServerState,
    message: String,
) -> DesktopServerStatus {
    let data_dir = paths.server.clone();
    let managed = state
        .child
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|_| true))
        .unwrap_or(false);
    DesktopServerStatus {
        available: development_server_available() || bundled_server_dir(paths).is_some(),
        running: fetch_server_status("/api/health")
            .ok()
            .and_then(|health| {
                read_expected_server_id(paths)
                    .ok()
                    .flatten()
                    .map(|expected| expected == health.server_id)
            })
            .unwrap_or(false),
        managed,
        endpoint: "http://localhost:8787".into(),
        data_file: Some(user_visible_path(&data_dir.join("server.sqlite"))),
        message,
    }
}

#[cfg(debug_assertions)]
fn npm_cmd() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

#[cfg(debug_assertions)]
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

fn configure_server_output(cmd: &mut Command, paths: &PortablePaths) -> Result<PathBuf, String> {
    let path = paths.logs.join("sync-server.log");
    let stdout = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|error| format!("创建同步服务器日志 {} 失败：{error}", path.display()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("打开同步服务器日志副本失败：{error}"))?;
    cmd.stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr));
    Ok(path)
}

#[cfg(debug_assertions)]
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

#[cfg(debug_assertions)]
fn development_server_available() -> bool {
    find_repo_root().is_some()
}

#[cfg(not(debug_assertions))]
fn development_server_available() -> bool {
    false
}

#[cfg(debug_assertions)]
fn development_server_command() -> Result<Command, String> {
    let root = find_repo_root().ok_or("无法定位开发仓库")?;
    ensure_server_build(&root)?;
    let mut command = Command::new(node_cmd());
    command
        .arg("apps/desktop/scripts/server.mjs")
        .current_dir(&root);
    Ok(command)
}

#[cfg(not(debug_assertions))]
fn development_server_command() -> Result<Command, String> {
    Err("便携版服务器资源损坏或缺失；Release 不允许回退仓库或系统 Node.js".into())
}

#[tauri::command]
fn desktop_backup_status(
    paths: tauri::State<'_, PortablePaths>,
) -> Result<DesktopBackupStatus, String> {
    let directory = backup_dir(&paths);
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

fn backup_temp_path(paths: &PortablePaths, file_name: &str) -> PathBuf {
    backup_dir(paths).join(format!(".{file_name}.tmp"))
}

#[tauri::command]
fn desktop_begin_backup_write(
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
    estimated_size_bytes: u64,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let dir = backup_dir(&paths);
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
    let temp = backup_temp_path(&paths, clean_name);
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
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
    chunk: Vec<u8>,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    if chunk.is_empty() || chunk.len() > 1024 * 1024 {
        return Err("备份写入分块大小无效".into());
    }
    let temp = backup_temp_path(&paths, clean_name);
    let mut file = OpenOptions::new()
        .append(true)
        .open(&temp)
        .map_err(|error| format!("打开临时备份失败：{error}"))?;
    file.write_all(&chunk)
        .map_err(|error| format!("追加备份分块失败：{error}"))
}

#[tauri::command]
fn desktop_commit_backup_write(
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
    expected_size_bytes: u64,
) -> Result<DesktopBackupWriteResult, String> {
    let clean_name = checked_backup_name(&file_name)?;
    let dir = backup_dir(&paths);
    let target = dir.join(clean_name);
    let temp = backup_temp_path(&paths, clean_name);
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
fn desktop_abort_backup_write(
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let temp = backup_temp_path(&paths, clean_name);
    if temp.is_file() {
        fs::remove_file(temp).map_err(|error| format!("清理临时备份失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_delete_backup_file(
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
) -> Result<(), String> {
    let clean_name = checked_backup_name(&file_name)?;
    let target = backup_dir(&paths).join(clean_name);
    if target.is_file() {
        fs::remove_file(target).map_err(|error| format!("删除轮换备份失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_export_backup_file(
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
) -> Result<Option<DesktopBackupExportResult>, String> {
    let clean_name = checked_backup_name(&file_name)?;
    let source = backup_dir(&paths).join(clean_name);
    native_backup_export::export_backup_to_user_selected_path(&source, &paths.data, clean_name).map(
        |path| {
            path.map(|path| DesktopBackupExportResult {
                path: user_visible_path(&path),
            })
        },
    )
}

#[tauri::command]
fn desktop_list_backup_files(
    paths: tauri::State<'_, PortablePaths>,
) -> Result<Vec<DesktopBackupFile>, String> {
    let dir = backup_dir(&paths);
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
    paths: tauri::State<'_, PortablePaths>,
    file_name: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    let clean_name = checked_backup_name(&file_name)?;
    if length == 0 || length > 1024 * 1024 {
        return Err("备份读取分块大小无效".into());
    }
    let path = backup_dir(&paths).join(clean_name);
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

fn security_dir(paths: &PortablePaths) -> PathBuf {
    paths.security.clone()
}

#[tauri::command]
fn native_security_status(
    paths: tauri::State<'_, PortablePaths>,
) -> Result<NativeSecurityStatus, String> {
    let stronghold_path = security_dir(&paths).join("sync-vault.hold");
    Ok(NativeSecurityStatus {
        platform: std::env::consts::OS,
        mobile: cfg!(mobile),
        stronghold_exists: stronghold_path.is_file(),
        stronghold_path: stronghold_path.display().to_string(),
    })
}

#[tauri::command]
fn native_reset_security_vault(paths: tauri::State<'_, PortablePaths>) -> Result<(), String> {
    let security = security_dir(&paths);
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
    state: tauri::State<'_, DesktopServerState>,
    paths: tauri::State<'_, PortablePaths>,
) -> DesktopServerStatus {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *guard = None;
            }
        }
    }
    let msg = if bundled_server_dir(&paths).is_some() {
        "便携版已内置 Web 与同步服务器；启动后将监听局域网 0.0.0.0:8787".into()
    } else if development_server_available() {
        "开发环境可在线启动本机服务器".into()
    } else {
        "当前安装包尚未内置服务脚本，请使用 npm run start:server".into()
    };
    desktop_status(&paths, &state, msg)
}

#[tauri::command]
fn desktop_start_server(
    state: tauri::State<'_, DesktopServerState>,
    paths: tauri::State<'_, PortablePaths>,
) -> DesktopServerStatus {
    let expected_before_start = match validate_server_identity(&paths) {
        Ok(value) => value,
        Err(error) => return desktop_status(&paths, &state, error),
    };
    if local_server_port_open() {
        let message = match fetch_server_status("/api/health") {
            Ok(health)
                if expected_before_start
                    .as_deref()
                    .is_some_and(|expected| expected == health.server_id) =>
            {
                "本便携目录的服务器已经在运行".into()
            }
            Ok(health) => format!(
                "端口 8787 已被另一个服务器占用（serverId={}），未启动也未终止该进程",
                health.server_id
            ),
            Err(error) => format!("端口 8787 已被其他程序占用：{error}"),
        };
        return desktop_status(&paths, &state, message);
    }
    let mut cmd = if let Some(bundle) = bundled_server_dir(&paths) {
        bundled_server_command(&bundle)
    } else {
        match development_server_command() {
            Ok(command) => command,
            Err(error) => return desktop_status(&paths, &state, error),
        }
    };
    cmd.env("HOST", "0.0.0.0")
        .env("PORT", "8787")
        .env("REGISTRATION_MODE", "invite")
        .env("ALLOW_INSECURE_HTTP", "1")
        .env("DATA_DIR", child_process_path(&paths.server))
        .env("CONTROL_STDIN", "1")
        .stdin(Stdio::piped());
    let server_log = match configure_server_output(&mut cmd, &paths) {
        Ok(path) => path,
        Err(error) => return desktop_status(&paths, &state, error),
    };
    hide_window(&mut cmd);

    match cmd.spawn() {
        Ok(mut child) => {
            for _ in 0..40 {
                if let Ok(Some(status)) = child.try_wait() {
                    return desktop_status(
                        &paths,
                        &state,
                        format!(
                            "同步服务器启动失败，子进程已退出：{status}；日志：{}",
                            user_visible_path(&server_log)
                        ),
                    );
                }
                if let (Ok(health), Ok(ready), Ok(Some(expected))) = (
                    fetch_server_status("/api/health"),
                    fetch_server_status("/api/ready"),
                    read_expected_server_id(&paths),
                ) {
                    if health.server_id != expected || ready.server_id != expected {
                        stop_managed_child(&mut child);
                        return desktop_status(
                            &paths,
                            &state,
                            "端口 8787 的服务器身份与便携目录不一致，启动已中止".into(),
                        );
                    }
                    if let Ok(mut guard) = state.child.lock() {
                        *guard = Some(child);
                    }
                    return desktop_status(
                        &paths,
                        &state,
                        "本机服务器已启动，正在监听局域网 0.0.0.0:8787；请确认防火墙暴露范围"
                            .into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            stop_managed_child(&mut child);
            desktop_status(
                &paths,
                &state,
                format!(
                    "同步服务器在 10 秒内未同时通过 health、ready 和 serverId 校验，已停止；日志：{}",
                    user_visible_path(&server_log)
                ),
            )
        }
        Err(e) => desktop_status(
            &paths,
            &state,
            format!(
                "启动服务失败：{e}；日志：{}",
                user_visible_path(&server_log)
            ),
        ),
    }
}

#[tauri::command]
fn desktop_stop_server(
    state: tauri::State<'_, DesktopServerState>,
    paths: tauri::State<'_, PortablePaths>,
) -> DesktopServerStatus {
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            stop_managed_child(&mut child);
            return desktop_status(&paths, &state, "本机服务器已安全停止".into());
        }
    }
    if local_server_port_open() {
        desktop_status(
            &paths,
            &state,
            "服务器正在运行，但不是由桌面在线启动，不能安全停止".into(),
        )
    } else {
        desktop_status(&paths, &state, "本机服务器未运行".into())
    }
}

fn app_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_system_share::init())
        .manage(DesktopServerState::default())
        .manage(NativeSqlState::default())
        .invoke_handler(tauri::generate_handler![
            portable::desktop_storage_status,
            ledger_profile::desktop_bind_legacy_profile,
            ledger_profile::desktop_list_ledger_profiles,
            ledger_profile::desktop_switch_ledger_profile,
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
            desktop_export_backup_file
        ])
}

fn install_stronghold(
    app: &tauri::App,
    paths: &PortablePaths,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(&paths.security)?;
    app.handle().plugin(restricted_stronghold::init())?;
    Ok(())
}

#[cfg(windows)]
fn run_windows() {
    let portable = match PortablePaths::prepare() {
        Ok(portable) => portable,
        Err(error) => {
            portable::show_native_error(&error);
            return;
        }
    };
    let portable::PortableRuntime { paths, lock } = portable;
    let setup_paths = paths.clone();
    let mut context = tauri::generate_context!();
    let Some(window_config) = context.config().app.windows.first().cloned() else {
        portable::show_native_error("桌面窗口配置缺失");
        return;
    };
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    let builder = app_builder().manage(paths).manage(lock).setup(move |app| {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            install_stronghold(app, &setup_paths)?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .data_directory(setup_paths.webview.clone())
                .enable_clipboard_access()
                .build()?;
            Ok(())
        })();
        if let Err(error) = result {
            portable::show_native_error(&format!("初始化便携桌面失败：{error}"));
            app.handle().exit(1);
        }
        Ok(())
    });
    match builder.build(context) {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_server_before_exit(handle);
            }
        }),
        Err(error) => portable::show_native_error(&format!("构建桌面运行时失败：{error}")),
    }
}

#[cfg(not(windows))]
fn run_platform() {
    let builder = app_builder().setup(|app| {
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let paths = PortablePaths::from_platform_app(app.handle())?;
            install_stronghold(app, &paths)?;
            app.manage(paths);
            #[cfg(mobile)]
            {
                app.handle()
                    .plugin(tauri_plugin_biometric::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
                app.handle().plugin(tauri_plugin_geolocation::init())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            portable::show_native_error(&format!("初始化应用数据目录失败：{error}"));
            app.handle().exit(1);
        }
        Ok(())
    });
    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                stop_server_before_exit(handle);
            }
        }),
        Err(error) => portable::show_native_error(&format!("构建应用运行时失败：{error}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    run_windows();
    #[cfg(not(windows))]
    run_platform();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn bundled_server_normalizes_an_extended_windows_bundle_path() {
        let bundle = PathBuf::from(r"\\?\D:\portable path\server");
        let command = bundled_server_command(&bundle);
        let args: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args, vec!["server.mjs"]);
        assert_eq!(
            command.get_current_dir(),
            Some(Path::new(r"D:\portable path\server"))
        );
        assert_eq!(
            command.get_program(),
            std::ffi::OsStr::new(r"D:\portable path\server\node.exe")
        );
        assert_eq!(
            child_process_path(Path::new(r"\\?\D:\portable path\data\server")),
            PathBuf::from(r"D:\portable path\data\server")
        );
    }
}
