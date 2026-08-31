use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// Shows an explicit native Save As dialog and copies an already committed archive to the
/// chosen location. The portable data directory is deliberately excluded: saving back into it
/// would look like an independent backup while remaining on the same portable volume.
pub fn export_backup_to_user_selected_path(
    source: &Path,
    portable_data_directory: &Path,
    suggested_file_name: &str,
) -> Result<Option<PathBuf>, String> {
    let source_metadata = source
        .metadata()
        .map_err(|error| format!("读取本机备份 {} 失败：{error}", source.display()))?;
    if !source_metadata.is_file() {
        return Err("本机备份不是普通文件，已停止导出".into());
    }

    let Some(target) = choose_backup_save_path(suggested_file_name)? else {
        return Ok(None);
    };
    ensure_external_destination(&target, portable_data_directory)?;
    copy_backup_file(source, &target)?;
    Ok(Some(target))
}

fn ensure_external_destination(
    target: &Path,
    portable_data_directory: &Path,
) -> Result<(), String> {
    let file_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or("导出目标文件名无效")?;
    if target.extension().and_then(|extension| extension.to_str()) != Some("zcbak") {
        return Err("导出文件必须使用 .zcbak 扩展名".into());
    }
    let parent = target.parent().ok_or("导出目标目录无效")?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|error| format!("无法解析导出目标目录 {}：{error}", parent.display()))?;
    let resolved_data = portable_data_directory.canonicalize().map_err(|error| {
        format!(
            "无法解析便携数据目录 {}：{error}",
            portable_data_directory.display()
        )
    })?;
    if resolved_parent.starts_with(&resolved_data) {
        return Err("为确保这是独立副本，请选择便携 data 目录之外的位置".into());
    }
    let normalized_target = resolved_parent.join(file_name);
    if normalized_target.is_dir() {
        return Err("导出目标不能是目录".into());
    }
    Ok(())
}

fn copy_backup_file(source: &Path, target: &Path) -> Result<(), String> {
    let source_size = source
        .metadata()
        .map_err(|error| format!("读取本机备份大小失败：{error}"))?
        .len();
    let (temp, mut output) = create_export_temp_file(target)?;
    let result = (|| {
        let mut input = File::open(source)
            .map_err(|error| format!("打开本机备份 {} 失败：{error}", source.display()))?;
        let copied = io::copy(&mut input, &mut output)
            .map_err(|error| format!("复制备份到临时文件失败：{error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("同步导出临时文件失败：{error}"))?;
        drop(output);
        if copied != source_size {
            return Err(format!(
                "导出文件长度不一致：应为 {source_size}，实际为 {copied}"
            ));
        }
        if sha256_file(source)? != sha256_file(&temp)? {
            return Err("导出文件校验和不一致，未写入目标位置".into());
        }
        publish_export_temp_file(&temp, target)
    })();
    if result.is_err() && temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn create_export_temp_file(target: &Path) -> Result<(PathBuf, File), String> {
    let parent = target.parent().ok_or("导出目标目录无效")?;
    let file_name = target
        .file_name()
        .ok_or("导出目标文件名无效")?
        .to_string_lossy();
    for attempt in 0..32_u32 {
        let temp = parent.join(format!(
            ".{file_name}.zichan-export-{}-{attempt}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => {
                return Ok((temp, file));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("创建导出临时文件 {} 失败：{error}", temp.display()));
            }
        }
    }
    Err("无法创建唯一的导出临时文件".into())
}

fn sha256_file(path: &Path) -> Result<[u8; 32], String> {
    let mut file = File::open(path)
        .map_err(|error| format!("读取导出文件 {} 失败：{error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取导出文件 {} 失败：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().into())
}

#[cfg(windows)]
fn publish_export_temp_file(temp: &Path, target: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let temp_wide = path_to_wide(temp);
    let target_wide = path_to_wide(target);
    let published = unsafe {
        if target.exists() {
            ReplaceFileW(
                target_wide.as_ptr(),
                temp_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        } else {
            MoveFileExW(
                temp_wide.as_ptr(),
                target_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if published == 0 {
        return Err(format!(
            "原子提交导出文件失败：{}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_export_temp_file(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| format!("原子提交导出文件失败：{error}"))
}

#[cfg(windows)]
fn path_to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn choose_backup_save_path(suggested_file_name: &str) -> Result<Option<PathBuf>, String> {
    use std::{
        ffi::OsString,
        mem::size_of,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let mut file = vec![0_u16; 32_768];
    let suggested: Vec<u16> = std::ffi::OsStr::new(suggested_file_name)
        .encode_wide()
        .collect();
    if suggested.len() + 1 >= file.len() {
        return Err("建议的备份文件名过长".into());
    }
    file[..suggested.len()].copy_from_slice(&suggested);
    let filter: Vec<u16> = "资产生命周期加密备份 (*.zcbak)\0*.zcbak\0\0"
        .encode_utf16()
        .collect();
    let default_extension: Vec<u16> = "zcbak\0".encode_utf16().collect();
    let title: Vec<u16> = "将加密备份另存为\0".encode_utf16().collect();
    let mut dialog = OPENFILENAMEW {
        lStructSize: size_of::<OPENFILENAMEW>() as u32,
        lpstrFilter: filter.as_ptr(),
        lpstrFile: file.as_mut_ptr(),
        nMaxFile: file.len() as u32,
        lpstrDefExt: default_extension.as_ptr(),
        lpstrTitle: title.as_ptr(),
        Flags: OFN_NOCHANGEDIR | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST,
        ..Default::default()
    };
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let detail = unsafe { CommDlgExtendedError() };
        if detail == 0 {
            return Ok(None);
        }
        return Err(format!("打开备份另存为窗口失败：Windows 错误 {detail}"));
    }
    let length = file
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(file.len());
    if length == 0 {
        return Err("备份另存为窗口没有返回文件路径".into());
    }
    Ok(Some(PathBuf::from(OsString::from_wide(&file[..length]))))
}

#[cfg(not(windows))]
fn choose_backup_save_path(_suggested_file_name: &str) -> Result<Option<PathBuf>, String> {
    Err("当前桌面平台不支持原生备份另存为".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "zichan-native-backup-export-{name}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn copies_and_replaces_an_export_only_after_the_copy_is_complete() {
        let directory = test_directory("copy");
        let source = directory.join("source.zcbak");
        let target = directory.join("outside.zcbak");
        fs::write(&source, b"encrypted archive contents").expect("write source");
        fs::write(&target, b"old contents").expect("write target");

        copy_backup_file(&source, &target).expect("copy backup");

        assert_eq!(
            fs::read(&target).expect("read target"),
            b"encrypted archive contents"
        );
        assert!(!directory
            .join(".outside.zcbak.zichan-export-0-0.tmp")
            .exists());
        fs::remove_dir_all(&directory).expect("clean test directory");
    }

    #[test]
    fn rejects_saving_back_inside_the_portable_data_directory() {
        let directory = test_directory("internal");
        let data = directory.join("data");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("create backup directory");

        let error = ensure_external_destination(&backups.join("copy.zcbak"), &data)
            .expect_err("portable data must be excluded");

        assert!(error.contains("data 目录之外"));
        fs::remove_dir_all(&directory).expect("clean test directory");
    }
}
