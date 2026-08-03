use serde::Serialize;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_TRANSFER_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentStatus {
    path: String,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentStorageStatus {
    directory: String,
    available_bytes: u64,
}

fn attachment_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("attachments"))
        .map_err(|error| error.to_string())
}

fn validate_key(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(format!("{label}无效"));
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("附件 SHA-256 无效".into());
    }
    Ok(())
}

fn stage_path(app: &AppHandle, temp_key: &str) -> Result<PathBuf, String> {
    validate_key(temp_key, "附件暂存键")?;
    Ok(attachment_dir(app)?.join("staging").join(temp_key))
}

fn stage_part_path(app: &AppHandle, temp_key: &str) -> Result<PathBuf, String> {
    let path = stage_path(app, temp_key)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("附件文件名无效")?;
    Ok(path.with_file_name(format!(".{file_name}.part")))
}

fn content_path(app: &AppHandle, area: &str, sha256: &str) -> Result<PathBuf, String> {
    validate_sha256(sha256)?;
    if area != "objects" && area != "trash" && area != "quarantine" {
        return Err("附件存储区域无效".into());
    }
    Ok(attachment_dir(app)?
        .join(area)
        .join(&sha256[0..2])
        .join(sha256.to_ascii_lowercase()))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("附件目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建附件目录失败：{error}"))
}

fn file_status(path: &Path) -> Result<NativeAttachmentStatus, String> {
    let size_bytes = fs::metadata(path)
        .map_err(|error| format!("读取附件状态失败：{error}"))?
        .len();
    Ok(NativeAttachmentStatus {
        path: path.display().to_string(),
        size_bytes,
    })
}

fn read_range(path: &Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    if length > MAX_TRANSFER_BYTES {
        return Err(format!("附件单次读取不能超过 {MAX_TRANSFER_BYTES} 字节"));
    }
    let size = fs::metadata(path)
        .map_err(|error| format!("读取附件状态失败：{error}"))?
        .len();
    if offset > size || length as u64 > size.saturating_sub(offset) {
        return Err("附件分块读取范围越界".into());
    }
    let mut file = File::open(path).map_err(|error| format!("打开附件失败：{error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位附件分块失败：{error}"))?;
    let mut result = vec![0_u8; length];
    file.read_exact(&mut result)
        .map_err(|error| format!("读取附件分块失败：{error}"))?;
    Ok(result)
}

#[tauri::command]
pub fn native_attachment_stage_begin(
    app: AppHandle,
    temp_key: String,
    expected_size_bytes: u64,
) -> Result<NativeAttachmentStatus, String> {
    let target = stage_path(&app, &temp_key)?;
    let temporary = stage_part_path(&app, &temp_key)?;
    ensure_parent(&target)?;
    let available = fs2::available_space(target.parent().ok_or("附件暂存目录无效")?)
        .map_err(|error| format!("读取附件目录剩余空间失败：{error}"))?;
    if available < expected_size_bytes {
        return Err(format!(
            "附件需要 {expected_size_bytes} 字节，但存储目录仅剩 {available} 字节"
        ));
    }
    for candidate in [&target, &temporary] {
        if candidate.is_file() {
            fs::remove_file(candidate)
                .map_err(|error| format!("清理旧附件暂存文件失败：{error}"))?;
        }
    }
    File::create(&temporary).map_err(|error| format!("创建附件临时文件失败：{error}"))?;
    file_status(&temporary)
}

#[tauri::command]
pub fn native_attachment_stage_append(
    app: AppHandle,
    temp_key: String,
    chunk: Vec<u8>,
) -> Result<NativeAttachmentStatus, String> {
    if chunk.is_empty() || chunk.len() > MAX_TRANSFER_BYTES {
        return Err(format!("附件写入分块必须为 1 至 {MAX_TRANSFER_BYTES} 字节"));
    }
    let temporary = stage_part_path(&app, &temp_key)?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&temporary)
        .map_err(|error| format!("打开附件临时文件失败：{error}"))?;
    file.write_all(&chunk)
        .map_err(|error| format!("写入附件分块失败：{error}"))?;
    file_status(&temporary)
}

#[tauri::command]
pub fn native_attachment_stage_commit(
    app: AppHandle,
    temp_key: String,
    expected_size_bytes: u64,
) -> Result<NativeAttachmentStatus, String> {
    let target = stage_path(&app, &temp_key)?;
    let temporary = stage_part_path(&app, &temp_key)?;
    let file = OpenOptions::new()
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("打开附件临时文件失败：{error}"))?;
    let actual = file
        .metadata()
        .map_err(|error| format!("校验附件临时文件失败：{error}"))?
        .len();
    if actual != expected_size_bytes {
        return Err(format!(
            "附件暂存大小不一致：预期 {expected_size_bytes}，实际 {actual}"
        ));
    }
    file.sync_all()
        .map_err(|error| format!("同步附件临时文件失败：{error}"))?;
    drop(file);
    fs::rename(&temporary, &target).map_err(|error| format!("提交附件暂存文件失败：{error}"))?;
    file_status(&target)
}

#[tauri::command]
pub fn native_attachment_stage_status(
    app: AppHandle,
    temp_key: String,
) -> Result<NativeAttachmentStatus, String> {
    file_status(&stage_path(&app, &temp_key)?)
}

#[tauri::command]
pub fn native_attachment_stage_read_range(
    app: AppHandle,
    temp_key: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    read_range(&stage_path(&app, &temp_key)?, offset, length)
}

#[tauri::command]
pub fn native_attachment_stage_discard(app: AppHandle, temp_key: String) -> Result<(), String> {
    let path = stage_path(&app, &temp_key)?;
    let temporary = stage_part_path(&app, &temp_key)?;
    for candidate in [path, temporary] {
        if candidate.is_file() {
            fs::remove_file(candidate).map_err(|error| format!("删除暂存附件失败：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn native_attachment_promote(
    app: AppHandle,
    temp_key: String,
    sha256: String,
) -> Result<NativeAttachmentStatus, String> {
    let source = stage_path(&app, &temp_key)?;
    let target = content_path(&app, "objects", &sha256)?;
    ensure_parent(&target)?;
    if target.is_file() {
        if source.is_file() {
            fs::remove_file(&source).map_err(|error| format!("清理重复暂存附件失败：{error}"))?;
        }
    } else {
        fs::rename(&source, &target).map_err(|error| format!("提升附件失败：{error}"))?;
    }
    let size_bytes = fs::metadata(&target)
        .map_err(|error| format!("读取附件状态失败：{error}"))?
        .len();
    Ok(NativeAttachmentStatus {
        path: target.display().to_string(),
        size_bytes,
    })
}

#[tauri::command]
pub fn native_attachment_status(
    app: AppHandle,
    sha256: String,
    area: Option<String>,
) -> Result<NativeAttachmentStatus, String> {
    let path = content_path(&app, area.as_deref().unwrap_or("objects"), &sha256)?;
    file_status(&path)
}

#[tauri::command]
pub fn native_attachment_read_range(
    app: AppHandle,
    sha256: String,
    area: Option<String>,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    let path = content_path(&app, area.as_deref().unwrap_or("objects"), &sha256)?;
    read_range(&path, offset, length)
}

#[tauri::command]
pub fn native_attachment_exists(
    app: AppHandle,
    sha256: String,
    area: Option<String>,
) -> Result<bool, String> {
    Ok(content_path(&app, area.as_deref().unwrap_or("objects"), &sha256)?.is_file())
}

fn move_content(app: &AppHandle, sha256: &str, from: &str, to: &str) -> Result<(), String> {
    let source = content_path(app, from, sha256)?;
    let target = content_path(app, to, sha256)?;
    if !source.is_file() {
        return Ok(());
    }
    ensure_parent(&target)?;
    if target.is_file() {
        fs::remove_file(source).map_err(|error| format!("清理重复附件失败：{error}"))?;
    } else {
        fs::rename(source, target).map_err(|error| format!("移动附件失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn native_attachment_trash(app: AppHandle, sha256: String) -> Result<(), String> {
    move_content(&app, &sha256, "objects", "trash")
}

#[tauri::command]
pub fn native_attachment_restore(app: AppHandle, sha256: String) -> Result<(), String> {
    move_content(&app, &sha256, "trash", "objects")
}

#[tauri::command]
pub fn native_attachment_quarantine(app: AppHandle, sha256: String) -> Result<(), String> {
    move_content(&app, &sha256, "objects", "quarantine")
}

#[tauri::command]
pub fn native_attachment_purge(app: AppHandle, sha256: String) -> Result<(), String> {
    for area in ["objects", "trash", "quarantine"] {
        let path = content_path(&app, area, &sha256)?;
        if path.is_file() {
            fs::remove_file(path).map_err(|error| format!("永久删除附件失败：{error}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn native_attachment_directory(app: AppHandle) -> Result<String, String> {
    attachment_dir(&app).map(|path| path.display().to_string())
}

#[tauri::command]
pub fn native_attachment_storage_status(
    app: AppHandle,
) -> Result<NativeAttachmentStorageStatus, String> {
    let directory = attachment_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建附件目录失败：{error}"))?;
    let available_bytes = fs2::available_space(&directory)
        .map_err(|error| format!("读取附件目录剩余空间失败：{error}"))?;
    Ok(NativeAttachmentStorageStatus {
        directory: directory.display().to_string(),
        available_bytes,
    })
}

#[tauri::command]
pub fn native_attachment_clear(app: AppHandle) -> Result<(), String> {
    let directory = attachment_dir(&app)?;
    if directory.is_dir() {
        fs::remove_dir_all(&directory).map_err(|error| format!("清空附件目录失败：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_range, validate_sha256, MAX_TRANSFER_BYTES};
    use std::{fs, io::Write};

    #[test]
    fn accepts_only_sha256_paths() {
        assert!(validate_sha256(&"a".repeat(64)).is_ok());
        assert!(validate_sha256("../ledger.sqlite").is_err());
    }

    #[test]
    fn range_reads_are_bounded_and_exact() {
        let path =
            std::env::temp_dir().join(format!("zichan-attachment-range-{}", std::process::id()));
        let mut file = fs::File::create(&path).expect("create range fixture");
        file.write_all(b"0123456789").expect("write range fixture");
        drop(file);
        assert_eq!(read_range(&path, 2, 4).expect("read range"), b"2345");
        assert!(read_range(&path, 8, 4).is_err());
        assert!(read_range(&path, 0, MAX_TRANSFER_BYTES + 1).is_err());
        fs::remove_file(path).expect("remove range fixture");
    }
}
