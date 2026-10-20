import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../desktop/src-tauri/', import.meta.url);
const cargo = readFileSync(new URL('Cargo.toml', root), 'utf8');
const rust = readFileSync(new URL('src/lib.rs', root), 'utf8');
const portable = readFileSync(new URL('src/portable.rs', root), 'utf8');
const nativeSql = readFileSync(new URL('src/native_sql.rs', root), 'utf8');
const desktopCapability = readFileSync(new URL('capabilities/default.json', root), 'utf8');
const tauriConfig = readFileSync(new URL('tauri.conf.json', root), 'utf8');
const windowsConfig = readFileSync(new URL('tauri.windows.conf.json', root), 'utf8');
const mobileCapability = readFileSync(new URL('capabilities/mobile.json', root), 'utf8');
const iosPlist = readFileSync(new URL('Info.ios.plist', root), 'utf8');
const desktopPackage = readFileSync(new URL('../package.json', root), 'utf8');
const androidConfigure = readFileSync(new URL('../scripts/configure-android.mjs', root), 'utf8');
const systemShareCargo = readFileSync(new URL('../plugins/system-share/Cargo.toml', root), 'utf8');
const systemShareAndroid = readFileSync(new URL('../plugins/system-share/android/src/main/java/com/zichan/systemshare/SystemSharePlugin.kt', root), 'utf8');
const systemShareFileProvider = readFileSync(new URL('../plugins/system-share/android/src/main/java/com/zichan/systemshare/SystemShareFileProvider.kt', root), 'utf8');
const systemShareManifest = readFileSync(new URL('../plugins/system-share/android/src/main/AndroidManifest.xml', root), 'utf8');
const systemShareIos = readFileSync(new URL('../plugins/system-share/ios/Sources/SystemSharePlugin.swift', root), 'utf8');

describe('native security and device configuration', () => {
  it('grants only the native SQL and Stronghold commands used by the app', () => {
    expect(cargo).toContain('tauri-plugin-stronghold = "2"');
    expect(cargo).not.toContain('tauri-plugin-notification');
    expect(rust).toContain('restricted_stronghold::init');
    expect(rust).not.toContain('tauri_plugin_stronghold::Builder::with_argon2');
    expect(readFileSync(new URL('src/restricted_stronghold.rs', root), 'utf8')).toContain(
      '拒绝访问便携 data/security 之外的 Stronghold 路径',
    );
    expect(rust).not.toContain('tauri_plugin_notification::init()');
    expect(desktopCapability).not.toContain('stronghold:default');
    expect(desktopCapability).not.toContain('sql:allow-load');
    expect(desktopCapability).not.toContain('sql:allow-close');
    expect(desktopCapability).not.toContain('sql:default');
    expect(desktopCapability).toContain('stronghold:allow-initialize');
    expect(desktopCapability).toContain('stronghold:allow-get-store-record');
    expect(desktopCapability).toContain('stronghold:allow-remove-store-record');
    expect(desktopCapability).not.toContain('notification:default');
    expect(tauriConfig).not.toContain('"csp": null');
    expect(tauriConfig).toContain("object-src 'none'");
    expect(tauriConfig).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(tauriConfig).not.toContain("'unsafe-eval'");
    expect(rust).toContain('.enable_clipboard_access()');
    expect(rust).not.toContain('CryptProtectData');
    expect(rust).not.toContain('desktop_store_sync_credential');
  });

  it('builds native SQLite with SQLCipher without exposing its key in a database URL', () => {
    expect(cargo).toContain('bundled-sqlcipher-vendored-openssl');
    expect(nativeSql).toContain('PRAGMA cipher_version');
    expect(nativeSql).toContain('.pragma("key", key_pragma)');
    expect(nativeSql).not.toContain('password=');
    expect(nativeSql).not.toContain('database_key_hex})');
  });

  it('keeps every Windows persistent path inside the portable root', () => {
    expect(cargo).not.toContain('tauri-plugin-sql');
    expect(cargo).not.toContain('tauri-plugin-updater');
    expect(rust).not.toContain('.app_data_dir()');
    expect(rust).not.toContain('.app_local_data_dir()');
    expect(rust).toContain('.data_directory(setup_paths.webview.clone())');
    expect(portable).toContain('portable-mode.json');
    expect(portable).toContain('current_exe()');
    expect(portable).toContain('GetDriveTypeW');
    expect(portable).toContain('DRIVE_REMOTE');
    expect(portable).toContain('try_lock_exclusive');
    expect(portable).toContain('WEBVIEW2_BROWSER_EXECUTABLE_FOLDER');
    expect(portable).toContain('#[cfg(not(windows))]');
    expect(tauriConfig).toContain('"active": false');
    expect(tauriConfig).toContain('"type": "skip"');
    expect(windowsConfig).toContain('"create": false');
    expect(tauriConfig).not.toContain('"targets": "all"');
  });

  it('uses bounded binary attachment IPC instead of whole-file Base64 commands', () => {
    expect(rust).toContain('native_attachment_stage_append');
    expect(rust).toContain('native_attachment_read_range');
    expect(rust).toContain('native_attachment_storage_status');
    expect(rust).not.toContain('native_attachment_stage_write');
    expect(rust).not.toContain('native_attachment_stage_read,');
    expect(rust).not.toContain('native_attachment_read,');
  });

  it('declares mobile biometric, scanner and geolocation plugins and permissions', () => {
    expect(cargo).toContain('tauri-plugin-biometric = "2"');
    expect(cargo).toContain('tauri-plugin-barcode-scanner = "2"');
    expect(cargo).toContain('tauri-plugin-geolocation = "2"');
    expect(rust).toContain('tauri_plugin_biometric::init()');
    expect(rust).toContain('tauri_plugin_barcode_scanner::init()');
    expect(rust).toContain('tauri_plugin_geolocation::init()');
    expect(mobileCapability).toContain('biometric:default');
    expect(mobileCapability).toContain('barcode-scanner:default');
    expect(mobileCapability).toContain('geolocation:allow-get-current-position');
  });

  it('uses a local native file share plugin on Android and iOS', () => {
    expect(cargo).toContain('tauri-plugin-system-share = { path = "../plugins/system-share" }');
    expect(systemShareCargo).toContain('name = "tauri-plugin-system-share"');
    expect(rust).toContain('tauri_plugin_system_share::init()');
    expect(mobileCapability).toContain('system-share:default');
    expect(systemShareAndroid).toContain('Intent.ACTION_SEND');
    expect(systemShareAndroid).toContain('FileProvider.getUriForFile');
    expect(systemShareManifest).toContain('com.zichan.systemshare.SystemShareFileProvider');
    expect(systemShareFileProvider).toContain('class SystemShareFileProvider : FileProvider()');
    expect(systemShareIos).toContain('UIActivityViewController');
  });

  it('contains the required iOS privacy descriptions', () => {
    expect(iosPlist).toContain('NSFaceIDUsageDescription');
    expect(iosPlist).toContain('NSCameraUsageDescription');
    expect(iosPlist).toContain('NSLocationWhenInUseUsageDescription');
  });

  it('keeps LAN HTTP reachable for encrypted home-server sync on mobile', () => {
    expect(desktopPackage).toContain('node scripts/configure-android.mjs');
    expect(androidConfigure).toContain('usesCleartextTraffic');
    expect(iosPlist).toContain('NSAllowsLocalNetworking');
    expect(iosPlist).toContain('NSAllowsArbitraryLoadsInWebContent');
  });
});
