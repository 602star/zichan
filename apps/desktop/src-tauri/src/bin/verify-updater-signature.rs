use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(value.trim())
        .map_err(|error| format!("{label} is not valid Base64: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{label} does not decode to UTF-8"))
}

fn verify_updater_bytes(
    encoded_public_key: &str,
    archive: &[u8],
    encoded_signature: &str,
) -> Result<(), String> {
    // Tauri stores both the complete minisign public-key file and the complete
    // minisign signature file as Base64. Decode them exactly as the updater does.
    let public_key_text = decode_base64_text(encoded_public_key, "updater public key")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("updater public key is invalid: {error}"))?;
    let signature_text = decode_base64_text(encoded_signature, "updater signature")?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("updater signature is invalid: {error}"))?;
    public_key
        .verify(archive, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))
}

fn is_updater_archive(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.ends_with(".msi.zip")
        || name.ends_with(".nsis.zip")
        || name.ends_with(".app.tar.gz")
        || name.ends_with(".AppImage.tar.gz")
}

fn updater_archives(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![directory.to_path_buf()];
    let mut archives = Vec::new();
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)
            .map_err(|error| format!("cannot read {}: {error}", current.display()))?
        {
            let path = entry
                .map_err(|error| format!("cannot read {} entry: {error}", current.display()))?
                .path();
            if path.is_dir() {
                pending.push(path);
            } else if is_updater_archive(&path) {
                archives.push(path);
            }
        }
    }
    archives.sort();
    Ok(archives)
}

fn parse_args() -> Result<(PathBuf, String), String> {
    let mut bundle_dir = None;
    let mut public_key_env = None;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {argument}"))?;
        match argument.as_str() {
            "--bundle-dir" => bundle_dir = Some(PathBuf::from(value)),
            "--public-key-env" => public_key_env = Some(value),
            _ => return Err(format!("unknown argument: {argument}")),
        }
    }
    Ok((
        bundle_dir.ok_or("missing --bundle-dir")?,
        public_key_env.ok_or("missing --public-key-env")?,
    ))
}

fn run() -> Result<usize, String> {
    let (bundle_dir, public_key_env) = parse_args()?;
    let encoded_public_key = env::var(&public_key_env)
        .map_err(|_| format!("environment variable {public_key_env} is missing"))?;
    if encoded_public_key.trim().is_empty() {
        return Err(format!("environment variable {public_key_env} is empty"));
    }
    let archives = updater_archives(&bundle_dir)?;
    if archives.is_empty() {
        return Err(format!(
            "no updater archives found under {}",
            bundle_dir.display()
        ));
    }
    for archive_path in &archives {
        let signature_path = PathBuf::from(format!("{}.sig", archive_path.display()));
        let archive = fs::read(archive_path)
            .map_err(|error| format!("cannot read {}: {error}", archive_path.display()))?;
        let encoded_signature = fs::read_to_string(&signature_path)
            .map_err(|error| format!("cannot read {}: {error}", signature_path.display()))?;
        verify_updater_bytes(&encoded_public_key, &archive, &encoded_signature)
            .map_err(|error| format!("{}: {error}", archive_path.display()))?;
        println!("verified updater signature: {}", archive_path.display());
    }
    Ok(archives.len())
}

fn main() {
    match run() {
        Ok(count) => println!("cryptographically verified {count} updater archive(s)"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::verify_updater_bytes;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn encoded(value: &str) -> String {
        STANDARD.encode(value)
    }

    #[test]
    fn accepts_a_real_tauri_wrapped_minisign_signature() {
        verify_updater_bytes(&encoded(PUBLIC_KEY), b"test", &encoded(SIGNATURE))
            .expect("known signature should verify");
    }

    #[test]
    fn rejects_a_tampered_archive() {
        let error = verify_updater_bytes(&encoded(PUBLIC_KEY), b"Test", &encoded(SIGNATURE))
            .expect_err("changed archive must not verify");
        assert!(error.contains("signature verification failed"));
    }

    #[test]
    fn rejects_a_nonmatching_public_key() {
        let different_key =
            PUBLIC_KEY.replace("WucNSCh1CBM0QTaLn73Y7GFO3", "WucNSCh1CBM0QTaLn73Y7GFO2");
        let error = verify_updater_bytes(&encoded(&different_key), b"test", &encoded(SIGNATURE))
            .expect_err("different public key must not verify");
        assert!(error.contains("signature verification failed"));
    }
}
