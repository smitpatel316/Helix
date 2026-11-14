//! In-app auto-update: download + verify + apply + relaunch (v2, item 77).
//!
//! The check itself lives in the frontend (`src/updates.ts`, `src/lib/channel.ts`);
//! this module owns what a web page cannot do: fetch the asset, check it,
//! swap the app bundle in, and relaunch. No new crates, so `Cargo.lock` is
//! untouched: downloads go through `curl`, hashes through the system's
//! `shasum`/`sha256sum`, unzipping through `ditto` (macOS).
//!
//! The apply path is macOS-only: the release artifact is a ditto zip of
//! `Titer.app` (`Titer-<version>.zip`, published next to the DMG), and the
//! bundle swap is a rename the running app cannot do to itself. Linux has
//! no shipped artifact yet, so its updater stops at the manual download.
//!
//! The 1.0.4 guard (UPDATE-LOOP-105.md): the staged bundle's own version
//! stamp must say the version the manifest promised, or nothing is swapped.
//! A payload whose stamp still says the old version would make the updater
//! re-offer the same update forever — so a mismatch refuses the swap before
//! anything is moved, and the second launch after a good swap is quiet.

use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::process::Command;

/// Runs a command, returning its stdout on success, or the command's
/// stderr on failure.
fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("couldn't run {cmd}: {e}"))?;
    if !output.status.success() {
        return Err(format!("{cmd} failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A fresh temp dir per purpose. The version is sanitised: it comes from
/// the channel manifest, and a `..` in it must never escape the temp dir.
fn staging_dir(purpose: &str) -> PathBuf {
    let safe: String = purpose
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect();
    std::env::temp_dir().join(format!("titer-update-{safe}"))
}

/// A path, quoted for a double-quoted shell string. macOS only: the
/// Linux `apply_update` is a stub, so nothing there quotes a path.
#[cfg(target_os = "macos")]
fn sh_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for c in raw.chars() {
        if matches!(c, '\\' | '"' | '$' | '`') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Downloads the update asset to a temp file, checks its size and sha256
/// against the manifest, and returns the temp path. The URL must be https:
/// it comes from the channel manifest, but a manifest must never be able
/// to point the updater at a local file or a plain-http host.
#[tauri::command]
pub fn download_update(url: String, sha256: String, size: u64) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("update URL must be https".to_string());
    }
    let dir = staging_dir("download");
    std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't make {dir:?}: {e}"))?;
    let file = dir.join("Titer-update.zip");
    let _ = std::fs::remove_file(&file);
    let file_str = file.to_str().ok_or("temp path isn't UTF-8")?;
    run("curl", &["-fsSL", "--max-time", "900", "-o", file_str, url.as_str()])?;
    let actual = std::fs::metadata(&file)
        .map_err(|e| format!("download vanished: {e}"))?
        .len();
    if actual != size {
        return Err(format!("download is {actual} bytes, the manifest says {size}"));
    }
    let sum = if cfg!(target_os = "macos") {
        run("shasum", &["-a", "256", file_str])?
    } else {
        run("sha256sum", &[file_str])?
    };
    let actual_sha = sum.split_whitespace().next().unwrap_or("");
    if !actual_sha.eq_ignore_ascii_case(&sha256) {
        return Err("download's sha256 doesn't match the manifest".to_string());
    }
    Ok(file.to_string_lossy().into_owned())
}

/// The running app's bundle: the executable is `<bundle>/Contents/MacOS/titer`.
#[cfg(target_os = "macos")]
fn current_bundle() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("couldn't find this app: {e}"))?;
    let bundle = exe
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .and_then(|p| p.parent()) // Titer.app
        .ok_or("this app isn't in a bundle")?
        .to_path_buf();
    if !bundle.join("Contents").join("Info.plist").is_file() {
        return Err("this app isn't in a bundle".to_string());
    }
    Ok(bundle)
}

/// Verifies the downloaded asset's version stamp and stages the bundle
/// swap. Returns once the swap is staged; the caller then quits through
/// the normal flow, and a helper swaps the bundle once this process has
/// exited and opens the new app.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn apply_update(path: String, version: String) -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;

    let asset = Path::new(&path);
    if !asset.is_file() {
        return Err("downloaded update is missing".to_string());
    }
    let bundle = current_bundle()?;
    let parent = bundle.parent().ok_or("Titer isn't in a folder")?.to_path_buf();
    // The swap needs to write beside the running bundle: prove it now, so
    // a read-only /Applications fails here, before anything is staged.
    let probe = parent.join(".titer-update-write-test");
    std::fs::write(&probe, b"").map_err(|e| format!("can't write beside Titer ({parent:?}): {e}"))?;
    let _ = std::fs::remove_file(&probe);

    let stage = staging_dir(&version);
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage).map_err(|e| format!("couldn't make {stage:?}: {e}"))?;
    let asset_str = asset.to_str().ok_or("asset path isn't UTF-8")?;
    let stage_str = stage.to_str().ok_or("stage path isn't UTF-8")?;
    run("ditto", &["-x", "-k", asset_str, stage_str])?;
    let new_bundle = stage.join("Titer.app");
    if !new_bundle.is_dir() {
        return Err("update asset holds no Titer.app".to_string());
    }
    // The 1.0.4 guard: the staged bundle's own stamp must say the version
    // the manifest promised, or nothing is swapped.
    let plist = new_bundle.join("Contents").join("Info.plist");
    let plist_str = plist.to_str().ok_or("plist path isn't UTF-8")?;
    let stamp = run("/usr/libexec/PlistBuddy", &["-c", "Print :CFBundleShortVersionString", plist_str])?;
    if stamp.trim() != version {
        return Err(format!("update is stamped {}, not {version}", stamp.trim()));
    }
    // The swap runs in a helper after this process exits: a running app
    // cannot move its own bundle. The helper waits for our PID (60 s, so
    // a quit the user cancelled just abandons the swap), moves the old
    // bundle aside, moves the new one in, and opens it.
    let helper = stage.join("swap.sh");
    let script = format!(
        "#!/bin/sh\n\
         # Titer update helper: swap the bundle once the old app has exited.\n\
         n=0\n\
         while kill -0 {pid} 2>/dev/null && [ \"$n\" -lt 60 ]; do sleep 1; n=$((n + 1)); done\n\
         if kill -0 {pid} 2>/dev/null; then rm -rf {stage}; exit 0; fi\n\
         OLD={bundle}\n\
         BACKUP=\"$OLD.titer-update-backup\"\n\
         rm -rf \"$BACKUP\"\n\
         mv \"$OLD\" \"$BACKUP\" || exit 1\n\
         if ! mv {new_bundle} \"$OLD\"; then mv \"$BACKUP\" \"$OLD\"; exit 1; fi\n\
         rm -rf \"$BACKUP\"\n\
         open \"$OLD\"\n\
         rm -rf {stage}\n",
        pid = std::process::id(),
        stage = sh_quote(&stage),
        bundle = sh_quote(&bundle),
        new_bundle = sh_quote(&new_bundle),
    );
    std::fs::write(&helper, script).map_err(|e| format!("couldn't write the update helper: {e}"))?;
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("couldn't make the update helper executable: {e}"))?;
    Command::new("/bin/sh")
        .arg(&helper)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("couldn't start the update helper: {e}"))?;
    Ok("restarting".to_string())
}

/// Linux has no shipped artifact yet, so there is nothing to swap in: the
/// frontend offers the manual download instead of calling this.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn apply_update(_path: String, _version: String) -> Result<String, String> {
    Err("in-place updates are macOS-only; download the release instead".to_string())
}
