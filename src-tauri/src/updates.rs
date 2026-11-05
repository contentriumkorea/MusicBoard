//! Native update transport. Release metadata is accepted only from the canonical
//! repository; installation remains an explicit action after state is flushed.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};

pub const RELEASES_URL: &str = "https://github.com/contentriumkorea/MusicBoard/releases";
const RELEASE_API: &str = "https://api.github.com/repos/contentriumkorea/MusicBoard/releases/latest";
const MAX_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Release {
    pub version: String,
    pub name: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

fn version_parts(version: &str) -> Result<[u64; 3], String> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3 { return Err("유효한 정식 버전이 아닙니다.".into()); }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return Err("유효한 정식 버전이 아닙니다.".into());
        }
        result[index] = part.parse().map_err(|_| "유효한 정식 버전이 아닙니다.".to_string())?;
    }
    Ok(result)
}

fn newer(candidate: &str, current: &str) -> Result<bool, String> {
    Ok(version_parts(candidate)? > version_parts(current)?)
}

pub fn parse_release(value: &Value, platform: &str) -> Result<Release, String> {
    let invalid = || "검증 가능한 업데이트 파일이 없습니다.".to_string();
    if value["draft"].as_bool() != Some(false) || value["prerelease"].as_bool() != Some(false) { return Err(invalid()); }
    let tag = value["tag_name"].as_str().ok_or_else(invalid)?;
    let version = tag.strip_prefix('v').ok_or_else(invalid)?;
    version_parts(version)?;
    if value["html_url"].as_str() != Some(format!("{RELEASES_URL}/tag/{tag}").as_str()) { return Err(invalid()); }
    let suffix = match platform {
        "macos" | "darwin" => "mac-universal.zip",
        "windows" | "win32" => "windows-x64-setup.exe",
        _ => return Err("이 운영체제는 자동 업데이트를 지원하지 않습니다.".into()),
    };
    let assets = value["assets"].as_array().ok_or_else(invalid)?;
    let preferred = format!("MusicBoard-{version}-{suffix}");
    let legacy = format!("SONO-{version}-{suffix}");
    // Presence selects the preferred artifact, even when its metadata is invalid.
    let name = if assets.iter().any(|a| a["name"].as_str() == Some(preferred.as_str())) { preferred } else { legacy };
    let matches: Vec<_> = assets.iter().filter(|a| a["name"].as_str() == Some(name.as_str())).collect();
    if matches.len() != 1 { return Err(invalid()); }
    let asset = matches[0];
    let url = format!("{RELEASES_URL}/download/{tag}/{name}");
    if asset["browser_download_url"].as_str() != Some(url.as_str()) { return Err(invalid()); }
    let size = asset["size"].as_u64().filter(|&size| size > 0 && size <= MAX_DOWNLOAD).ok_or_else(invalid)?;
    let digest = asset["digest"].as_str().ok_or_else(invalid)?;
    let sha256 = digest.strip_prefix("sha256:").filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(invalid)?.to_ascii_lowercase();
    Ok(Release { version: version.into(), name, url, size, sha256 })
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("MusicBoard-native-updater")
        .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let trusted = matches!(url.host_str(), Some("github.com" | "api.github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com" | "github-releases.githubusercontent.com"));
            if attempt.previous().len() < 8 && trusted && url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443) {
                attempt.follow()
            } else { attempt.stop() }
        }))
        .build().map_err(|_| "업데이트 연결을 준비하지 못했습니다.".into())
}

struct Staged {
    workspace: PathBuf,
    artifact: PathBuf,
    bundle: Option<PathBuf>,
    token: String,
}

pub struct Updater {
    data_dir: PathBuf,
    helper_path: PathBuf,
    version: String,
    state: Value,
    release: Option<Release>,
    staged: Option<Staged>,
}

impl Updater {
    pub fn new(data_dir: PathBuf, version: &str, helper_path: PathBuf) -> Self {
        Self { data_dir, helper_path, version: version.into(), release: None, staged: None,
            state: json!({"version":version,"status":"idle","mode":"automatic","releasesUrl":RELEASES_URL,"message":"새 버전이 있는지 확인해보세요."}) }
    }
    pub fn get(&self) -> Value { self.state.clone() }
    fn status(&mut self, status: &str, message: &str) {
        self.state["status"] = json!(status); self.state["message"] = json!(message);
    }
    fn fail(&mut self, message: &str) {
        self.status("error", message);
        if let Some(state) = self.state.as_object_mut() { state.remove("percent"); state.remove("latestVersion"); }
    }
    pub fn check(&mut self) -> Result<Value, String> {
        if matches!(self.state["status"].as_str(), Some("downloading" | "downloaded" | "installing")) { return Ok(self.get()); }
        self.release = None;
        self.status("checking", "새 버전을 확인하고 있습니다.");
        if let Some(state) = self.state.as_object_mut() { state.remove("percent"); state.remove("latestVersion"); }
        let result: Result<Value, String> = (|| {
            let response = client()?.get(RELEASE_API).header("Accept", "application/vnd.github+json")
                .timeout(Duration::from_secs(15)).send().map_err(|_| "새 버전을 확인하지 못했습니다.".to_string())?;
            if response.status() != reqwest::StatusCode::OK { return Err("새 버전을 확인하지 못했습니다.".into()); }
            // Bound metadata independently of a server supplied Content-Length.
            let mut bytes = Vec::new(); response.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "릴리스 정보를 읽지 못했습니다.".to_string())?;
            if bytes.len() > 4 * 1024 * 1024 { return Err("릴리스 정보가 너무 큽니다.".into()); }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| "릴리스 정보를 확인하지 못했습니다.".to_string())?;
            let release = parse_release(&value, std::env::consts::OS)?;
            if newer(&release.version, &self.version)? {
                self.state["latestVersion"] = json!(release.version);
                self.release = Some(release);
                self.status("available", "새 버전을 다운로드할 수 있습니다.");
            } else { self.status("current", "최신 버전을 사용하고 있습니다."); }
            Ok(self.get())
        })();
        if let Err(ref message) = result { self.fail(message); }
        result
    }
    pub fn download(&mut self, progress: &mut dyn FnMut(Value)) -> Result<Value, String> {
        if self.state["status"] != "available" { return Ok(self.get()); }
        let release = self.release.clone().ok_or("먼저 새 버전을 확인해주세요.")?;
        self.status("downloading", "업데이트를 다운로드하고 있습니다."); self.state["percent"] = json!(0); progress(self.get());
        let token = uuid::Uuid::new_v4().to_string();
        let workspace = self.data_dir.join(if cfg!(target_os = "macos") { "mac-updates" } else { "updates" }).join(&token);
        let result: Result<Value, String> = (|| {
            private_workspace(&workspace)?;
            let artifact = workspace.join(if cfg!(target_os = "macos") { "update.zip" } else { "update.exe" });
            let mut response = client()?.get(&release.url).send().map_err(|_| "업데이트를 내려받지 못했습니다.".to_string())?;
            if response.status() != reqwest::StatusCode::OK || response.content_length().is_some_and(|n| n != release.size) { return Err("업데이트 파일 크기가 다릅니다.".into()); }
            let mut file = private_file(&artifact)?;
            let mut hash = Sha256::new(); let mut received = 0u64; let mut buffer = [0u8; 64 * 1024]; let mut reported = -1i32;
            loop {
                let count = response.read(&mut buffer).map_err(|_| "업데이트를 내려받지 못했습니다.".to_string())?;
                if count == 0 { break; }
                received += count as u64;
                if received > release.size || received > MAX_DOWNLOAD { return Err("업데이트 파일 크기가 다릅니다.".into()); }
                hash.update(&buffer[..count]); file.write_all(&buffer[..count]).map_err(|_| "업데이트 파일을 저장하지 못했습니다.".to_string())?;
                let percent = (received * 100 / release.size) as i32;
                if percent != reported { reported = percent; self.state["percent"] = json!(percent); progress(self.get()); }
            }
            if received != release.size || hex::encode(hash.finalize()) != release.sha256 { return Err("업데이트 파일 검증에 실패했습니다.".into()); }
            file.sync_all().map_err(|_| "업데이트 파일을 저장하지 못했습니다.".to_string())?; drop(file);
            let bundle = if cfg!(target_os = "macos") { Some(extract_bundle(&artifact, &workspace.join("unpacked"), &release.version)?) } else { None };
            self.staged = Some(Staged { workspace: workspace.clone(), artifact, bundle, token });
            self.status("downloaded", "다운로드가 완료되었습니다. 재시작하면 업데이트가 설치됩니다."); self.state["percent"] = json!(100);
            Ok(self.get())
        })();
        if let Err(ref message) = result { let _ = fs::remove_dir_all(&workspace); self.staged = None; self.fail(message); }
        progress(self.get()); result
    }
    /// The caller must flush persistent state before this and exit only on success.
    pub fn prepare_install(&mut self) -> Result<(), String> {
        if self.state["status"] != "downloaded" { return Err("다운로드한 업데이트가 없습니다.".into()); }
        let result: Result<(), String> = (|| {
            let release = self.release.as_ref().ok_or("먼저 새 버전을 확인해주세요.")?;
            let staged = self.staged.as_ref().ok_or("다운로드한 업데이트가 없습니다.")?;
            verify_file(&staged.artifact, release)?;
            if cfg!(target_os = "macos") { prepare_mac_install(staged, release, &self.helper_path)?; }
            else if cfg!(target_os = "windows") {
                let mut command = Command::new(&staged.artifact);
                command.args(["--updated", "--force-run", "/S"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
                #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
                command.spawn().map_err(|_| "업데이트 설치 프로그램을 실행하지 못했습니다.".to_string())?;
            } else { return Err("이 운영체제는 자동 업데이트를 지원하지 않습니다.".into()); }
            Ok(())
        })();
        if result.is_ok() { self.status("installing", "설정을 저장하고 재시작합니다."); }
        else { self.status("downloaded", "앱을 교체하지 못했습니다. 기존 앱은 유지됩니다. 다시 시도해주세요."); }
        result
    }
}

fn private_workspace(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("업데이트 경로가 잘못되었습니다.")?).map_err(|_| "업데이트 폴더를 만들지 못했습니다.".to_string())?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(path).map_err(|_| "업데이트 폴더를 만들지 못했습니다.".into())
}
fn private_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(path).map_err(|_| "업데이트 파일을 만들지 못했습니다.".into())
}
fn verify_file(path: &Path, release: &Release) -> Result<(), String> {
    let mut file = File::open(path).map_err(|_| "업데이트 파일을 읽지 못했습니다.".to_string())?;
    if !file.metadata().map_err(|_| "업데이트 파일을 읽지 못했습니다.".to_string())?.is_file() { return Err("업데이트 파일이 잘못되었습니다.".into()); }
    let mut hash = Sha256::new(); let mut total = 0u64; let mut buffer = [0u8; 64 * 1024];
    loop { let count = file.read(&mut buffer).map_err(|_| "업데이트 파일을 읽지 못했습니다.".to_string())?; if count == 0 { break; } total += count as u64; if total > release.size { return Err("업데이트 파일 검증에 실패했습니다.".into()); } hash.update(&buffer[..count]); }
    if total != release.size || hex::encode(hash.finalize()) != release.sha256 { return Err("업데이트 파일 검증에 실패했습니다.".into()); }
    Ok(())
}

fn archive_path(name: &str) -> Result<String, String> {
    let path = name.strip_suffix('/').unwrap_or(name);
    let components: Vec<_> = path.split('/').collect();
    if name.contains('\\') || name.contains('\0') || components.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || !matches!(components.first().copied(), Some("MusicBoard.app" | "SONO.app" | "__MACOSX")) {
        return Err("잘못된 앱 압축 파일입니다.".into());
    }
    Ok(path.into())
}
fn validate_links(root: &str, links: &HashMap<String, String>) -> Result<(), String> {
    for (path, target) in links {
        if target.is_empty() || target.starts_with('/') || target.contains('\\') || target.contains('\0') { return Err("안전하지 않은 앱 링크입니다.".into()); }
        let parent = path.rsplit_once('/').ok_or("안전하지 않은 앱 링크입니다.")?.0;
        let mut pending: std::collections::VecDeque<String> = format!("{parent}/{target}").split('/').map(str::to_owned).collect();
        let mut resolved = Vec::<String>::new(); let mut followed = 0;
        while let Some(part) = pending.pop_front() {
            if part == "." || part.is_empty() { continue; }
            if part == ".." { if resolved.len() <= 1 { return Err("앱 링크가 압축 폴더 밖을 가리킵니다.".into()); } resolved.pop(); continue; }
            resolved.push(part);
            if resolved.first().map(String::as_str) != Some(root) { return Err("앱 링크가 압축 폴더 밖을 가리킵니다.".into()); }
            if let Some(destination) = links.get(&resolved.join("/")) {
                followed += 1;
                if followed > 40 || destination.starts_with('/') || destination.contains('\\') || destination.contains('\0') { return Err("안전하지 않은 앱 링크입니다.".into()); }
                resolved.pop();
                for component in destination.split('/').rev() { pending.push_front(component.into()); }
            }
        }
    }
    Ok(())
}

fn inspect_zip(path: &Path) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|_| "압축 파일을 읽지 못했습니다.".to_string())?).map_err(|_| "잘못된 앱 압축 파일입니다.".to_string())?;
    if archive.len() > 200_000 { return Err("앱 압축 파일에 항목이 너무 많습니다.".into()); }
    let mut roots = HashSet::new(); let mut entries = HashSet::new(); let mut links = HashMap::new(); let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| "잘못된 앱 압축 파일입니다.".to_string())?;
        let name = archive_path(entry.name())?;
        if !entries.insert(name.clone()) { return Err("중복된 앱 압축 경로입니다.".into()); }
        let root = name.split('/').next().ok_or("잘못된 앱 압축 파일입니다.")?;
        if root != "__MACOSX" { roots.insert(root.to_owned()); }
        total = total.checked_add(entry.size()).ok_or("압축 파일이 너무 큽니다.")?;
        if total > MAX_DOWNLOAD * 4 { return Err("압축 파일이 너무 큽니다.".into()); }
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        if kind == 0o120000 {
            if root == "__MACOSX" || entry.size() > 4096 { return Err("안전하지 않은 앱 링크입니다.".into()); }
            let mut target = String::new(); entry.take(4097).read_to_string(&mut target).map_err(|_| "안전하지 않은 앱 링크입니다.".to_string())?;
            links.insert(name, target);
        } else if !matches!(kind, 0 | 0o100000 | 0o040000) { return Err("지원하지 않는 앱 압축 항목입니다.".into()); }
    }
    if roots.len() != 1 { return Err("앱 압축 파일에는 앱 하나만 있어야 합니다.".into()); }
    let root = roots.into_iter().next().ok_or("앱 압축 파일이 비어 있습니다.")?;
    validate_links(&root, &links)?;
    // Extractors must never write through a symlink supplied by the archive.
    for name in &entries {
        let mut parent = name.as_str();
        while let Some((ancestor, _)) = parent.rsplit_once('/') {
            if links.contains_key(ancestor) { return Err("앱 링크 아래의 압축 경로는 허용되지 않습니다.".into()); }
            parent = ancestor;
        }
    }
    Ok(root)
}
fn run(command: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let status = Command::new(command).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|_| "앱 업데이트 도구를 실행하지 못했습니다.".to_string())?;
    if !status.success() { return Err("앱 업데이트 검증에 실패했습니다.".into()); } Ok(())
}
fn validate_bundle(bundle: &Path, version: &str) -> Result<(), String> {
    let plist = bundle.join("Contents/Info.plist");
    for (key, expected) in [("CFBundleIdentifier", "local.luma.music"), ("CFBundleShortVersionString", version), ("CFBundleExecutable", "SONO")] {
        let output = Command::new("/usr/bin/plutil").args(["-extract", key, "raw", "-o", "-"]).arg(&plist).stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| "앱 정보를 읽지 못했습니다.".to_string())?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != expected { return Err("PulseDeck 업데이트 앱을 확인하지 못했습니다.".into()); }
    }
    let executable = bundle.join("Contents/MacOS/SONO");
    if !executable.is_file() { return Err("업데이트 앱 실행 파일이 없습니다.".into()); }
    run("/usr/bin/codesign", &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), bundle.as_os_str()])
}
fn extract_bundle(archive: &Path, destination: &Path, version: &str) -> Result<PathBuf, String> {
    let root = inspect_zip(archive)?;
    fs::create_dir(destination).map_err(|_| "업데이트 압축 폴더를 만들지 못했습니다.".to_string())?;
    run("/usr/bin/ditto", &["-x".as_ref(), "-k".as_ref(), archive.as_os_str(), destination.as_os_str()])?;
    let bundle = destination.join(root); validate_bundle(&bundle, version)?; Ok(bundle)
}
fn prepare_mac_install(staged: &Staged, release: &Release, helper_source: &Path) -> Result<(), String> {
    let executable = std::env::current_exe().and_then(fs::canonicalize).map_err(|_| "현재 앱 경로를 확인하지 못했습니다.".to_string())?;
    if executable.file_name().and_then(|p| p.to_str()) != Some("SONO")
        || executable.parent().and_then(Path::file_name).and_then(|p| p.to_str()) != Some("MacOS")
        || executable.parent().and_then(Path::parent).and_then(Path::file_name).and_then(|p| p.to_str()) != Some("Contents") {
        return Err("현재 앱 경로를 확인하지 못했습니다.".into());
    }
    let target = executable.parent().and_then(Path::parent).and_then(Path::parent).ok_or("현재 앱 경로를 확인하지 못했습니다.")?;
    if target.extension().and_then(|s| s.to_str()) != Some("app") || target.starts_with("/Volumes") || target.components().any(|part| part.as_os_str() == "AppTranslocation") {
        return Err("PulseDeck을 응용프로그램 폴더로 옮긴 뒤 업데이트해주세요.".into());
    }
    if fs::metadata(target).map_err(|_| "현재 앱을 확인하지 못했습니다.".to_string())?.permissions().readonly() {
        return Err("앱 폴더에 쓰기 권한이 없습니다. 사용자 응용프로그램 폴더로 PulseDeck을 옮겨주세요.".into());
    }
    let bundle = staged.bundle.as_ref().ok_or("다운로드한 앱이 없습니다.")?;
    validate_bundle(bundle, &release.version)?;
    let mut candidate_name = target.as_os_str().to_os_string(); candidate_name.push(format!(".sono-update-{}.app", staged.token));
    let candidate = PathBuf::from(candidate_name);
    fs::create_dir(&candidate).map_err(|_| "앱 폴더에 쓰기 권한이 없습니다. 사용자 응용프로그램 폴더로 PulseDeck을 옮겨주세요.".to_string())?;
    let result: Result<(), String> = (|| {
        run("/usr/bin/ditto", &[bundle.as_os_str(), candidate.as_os_str()])?;
        validate_bundle(&candidate, &release.version)?;
        let helper = staged.workspace.join("install.sh");
        if helper.exists() { fs::remove_file(&helper).map_err(|_| "업데이트 도구를 준비하지 못했습니다.".to_string())?; }
        let mut helper_file = private_file(&helper)?;
        let source = fs::read(helper_source).map_err(|_| "업데이트 도구를 읽지 못했습니다.".to_string())?;
        helper_file.write_all(&source).and_then(|_| helper_file.sync_all()).map_err(|_| "업데이트 도구를 저장하지 못했습니다.".to_string())?; drop(helper_file);
        run("/bin/sh", &["-n".as_ref(), helper.as_os_str()])?;
        let log = staged.workspace.join("install.log");
        let mut log_options = OpenOptions::new(); log_options.create(true).append(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; log_options.mode(0o600); }
        let log_file = log_options.open(log).map_err(|_| "업데이트 로그를 만들지 못했습니다.".to_string())?;
        let error_file = log_file.try_clone().map_err(|_| "업데이트 로그를 만들지 못했습니다.".to_string())?;
        Command::new("/usr/bin/nohup").arg("/bin/sh").arg(&helper).arg(std::process::id().to_string()).arg(target).arg(&candidate)
            .arg(&staged.workspace).arg(&staged.token).arg(&release.version).arg(staged.workspace.join("health")).arg("300")
            .stdin(Stdio::null()).stdout(Stdio::from(log_file)).stderr(Stdio::from(error_file))
            .spawn().map_err(|_| "업데이트 도구를 실행하지 못했습니다.".to_string())?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&candidate); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(platform: &str) -> Value {
        let suffix = if platform == "macos" { "mac-universal.zip" } else { "windows-x64-setup.exe" };
        let name = format!("MusicBoard-1.2.3-{suffix}");
        json!({"tag_name":"v1.2.3","draft":false,"prerelease":false,
            "html_url":format!("{RELEASES_URL}/tag/v1.2.3"),"assets":[{
                "name":name,"browser_download_url":format!("{RELEASES_URL}/download/v1.2.3/{name}"),
                "size":10,"digest":format!("sha256:{}", "a".repeat(64))}]})
    }
    #[test]
    fn validates_exact_repository_and_artifact() {
        for platform in ["macos", "windows"] {
            let r = release(platform);
            assert_eq!(parse_release(&r, platform).unwrap().version, "1.2.3");
            for field in ["html_url", "tag_name"] {
                let mut bad = r.clone(); bad[field] = json!("https://github.com/other/MusicBoard");
                assert!(parse_release(&bad, platform).is_err());
            }
            for (key, value) in [
                ("browser_download_url", json!("https://evil.example/update.exe")),
                ("size", json!(0)), ("size", json!(MAX_DOWNLOAD + 1)),
                ("size", json!(1.5)), ("digest", json!("sha256:bad")),
                ("name", json!("MusicBoard-9.9.9-windows-x64-setup.exe"))] {
                let mut bad = r.clone(); bad["assets"][0][key] = value;
                assert!(parse_release(&bad, platform).is_err(), "{key}");
            }
        }
    }
    #[test]
    fn rejects_unstable_or_noncanonical_versions() {
        for tag in ["1.2.3", "v01.2.3", "v1.2.3-beta", "v1.2.3+build", "v1.2", "v1.2.18446744073709551616"] {
            let mut r = release("macos"); r["tag_name"] = json!(tag);
            r["html_url"] = json!(format!("{RELEASES_URL}/tag/{tag}"));
            assert!(parse_release(&r, "macos").is_err(), "{tag}");
        }
        for field in ["draft", "prerelease"] {
            let mut r = release("macos"); r[field] = json!(true);
            assert!(parse_release(&r, "macos").is_err());
        }
        assert!(newer("1.10.0", "1.9.99").unwrap());
        assert!(!newer("1.2.3", "1.2.3").unwrap());
        assert!(!newer("1.2.3", "2.0.0").unwrap());
    }
    #[test]
    fn legacy_fallback_cannot_hide_invalid_preferred_asset() {
        let mut r = release("macos");
        let mut old = r["assets"][0].clone();
        old["name"] = json!("SONO-1.2.3-mac-universal.zip");
        old["browser_download_url"] = json!(format!("{RELEASES_URL}/download/v1.2.3/SONO-1.2.3-mac-universal.zip"));
        r["assets"].as_array_mut().unwrap().push(old.clone());
        r["assets"][0]["digest"] = json!("invalid");
        assert!(parse_release(&r, "macos").is_err());
        r["assets"] = json!([old]);
        assert_eq!(parse_release(&r, "macos").unwrap().name, "SONO-1.2.3-mac-universal.zip");
    }
    #[test]
    fn zip_paths_and_symlinks_cannot_leave_the_bundle() {
        for path in ["/MusicBoard.app/a", "MusicBoard.app/../evil", "MusicBoard.app\\evil", "MusicBoard.app/./a", "evil/a", "MusicBoard.app//a"] {
            assert!(archive_path(path).is_err(), "{path}");
        }
        assert!(archive_path("MusicBoard.app/Contents/MacOS/SONO").is_ok());
        let mut links = std::collections::HashMap::new();
        links.insert("MusicBoard.app/Contents/Frameworks/Foo.framework/Versions/Current".to_string(), "A".to_string());
        links.insert("MusicBoard.app/Contents/Frameworks/Foo.framework/Foo".to_string(), "Versions/Current/Foo".to_string());
        assert!(validate_links("MusicBoard.app", &links).is_ok());
        links.insert("MusicBoard.app/escape".to_string(), "../outside".to_string());
        assert!(validate_links("MusicBoard.app", &links).is_err());
        links.clear(); links.insert("MusicBoard.app/a".into(), "b".into()); links.insert("MusicBoard.app/b".into(), "a".into());
        assert!(validate_links("MusicBoard.app", &links).is_err());
    }
    #[test]
    fn accepts_one_app_archive_and_rejects_mixed_roots() {
        fn archive(names: &[&str]) -> tempfile::NamedTempFile {
            let file = tempfile::NamedTempFile::new().unwrap();
            let mut writer = zip::ZipWriter::new(file.reopen().unwrap());
            for name in names {
                writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                writer.write_all(b"payload").unwrap();
            }
            writer.finish().unwrap(); file
        }
        assert_eq!(inspect_zip(archive(&["MusicBoard.app/Contents/MacOS/SONO", "__MACOSX/._MusicBoard.app"]).path()).unwrap(), "MusicBoard.app");
        assert_eq!(inspect_zip(archive(&["SONO.app/Contents/MacOS/SONO"]).path()).unwrap(), "SONO.app");
        assert!(inspect_zip(archive(&["MusicBoard.app/a", "SONO.app/a"]).path()).is_err());
        assert!(inspect_zip(archive(&["MusicBoard.app/../outside"]).path()).is_err());
    }
    #[test]
    fn installer_file_is_rehashed_before_launch() {
        let mut file = tempfile::NamedTempFile::new().unwrap(); file.write_all(b"verified").unwrap();
        let mut r = parse_release(&release("windows"), "windows").unwrap();
        r.size = 8; r.sha256 = hex::encode(Sha256::digest(b"verified"));
        assert!(verify_file(file.path(), &r).is_ok());
        fs::write(file.path(), b"tampered").unwrap();
        assert!(verify_file(file.path(), &r).is_err());
    }
}
