// Runs the real `oms update` against a copy of a release served from this computer, with the
// repository's own install script. The Windows path hands over to install.ps1, which the
// release workflow tests on Windows.
#![cfg(unix)]

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

const INSTALLED: &str = env!("CARGO_PKG_VERSION");
const NEXT_RELEASE: &str = "#!/bin/sh\n# Stands in for the next release.\necho \"oms 99.0.0\"\n";

static FOLDERS: AtomicUsize = AtomicUsize::new(0);

struct Folder(PathBuf);

impl Folder {
    fn new() -> Self {
        let count = FOLDERS.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("oms-update-{}-{count}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Serves a folder's files over plain HTTP on this computer, and returns its address.
fn serve(folder: &Path) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let folder = folder.to_path_buf();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(read) if read > 0 => request.extend_from_slice(&chunk[..read]),
                    _ => break,
                }
            }
            let request = String::from_utf8_lossy(&request);
            let name = request.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/');
            let reply = match fs::read(folder.join(name)) {
                Ok(body) if !name.is_empty() && !name.contains("..") => {
                    let mut reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                    reply.extend(body);
                    reply
                }
                _ => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            };
            let _ = stream.write_all(&reply);
        }
    });
    address
}

/// The archive name the install script asks for on this computer.
fn archive_name() -> String {
    let os = if cfg!(target_os = "macos") { "apple-darwin" } else { "unknown-linux-musl" };
    format!("oms-{}-{os}.tar.gz", std::env::consts::ARCH)
}

fn checksums(release: &Path, files: &[&str]) {
    let lines: String = files
        .iter()
        .map(|file| {
            let hash: String = Sha256::digest(fs::read(release.join(file)).unwrap()).iter().map(|byte| format!("{byte:02x}")).collect();
            format!("{hash}  {file}\n")
        })
        .collect();
    fs::write(release.join("SHA256SUMS"), lines).unwrap();
}

/// A computer with `oms` installed in a folder of its own, and a release it can be offered.
struct Setup {
    home: Folder,
    release: Folder,
    address: String,
}

impl Setup {
    fn new(tag: &str) -> Self {
        let home = Folder::new();
        let release = Folder::new();
        fs::create_dir_all(home.0.join("bin")).unwrap();
        fs::copy(env!("CARGO_BIN_EXE_oms"), home.0.join("bin/oms")).unwrap();

        let stage = release.0.join("stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("oms"), NEXT_RELEASE).unwrap();
        fs::set_permissions(stage.join("oms"), fs::Permissions::from_mode(0o755)).unwrap();
        let packed = Command::new("tar").arg("-czf").arg(release.0.join(archive_name())).arg("-C").arg(&stage).arg("oms").status().unwrap();
        assert!(packed.success());
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../install.sh"), release.0.join("install.sh")).unwrap();
        checksums(&release.0, &[&archive_name(), "install.sh"]);
        fs::write(release.0.join("latest.json"), format!(r#"{{"tag_name":"{tag}"}}"#)).unwrap();

        let address = serve(&release.0);
        Self { home, release, address }
    }

    fn installed(&self) -> PathBuf {
        self.home.0.join("bin/oms")
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(self.installed())
            .args(args)
            .env_clear()
            .env("HOME", &self.home.0)
            // The install script needs the system's own tools: a downloader, tar, a checksum.
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("OMS_RELEASE_API", format!("{}/latest.json", self.address))
            .env("OMS_DOWNLOAD_URL", &self.address)
            // The script must put the new file here, whatever the caller's own setting says.
            .env("OMS_INSTALL_DIR", self.home.0.join("elsewhere"))
            .output()
            .unwrap()
    }

    fn still_this_version(&self) -> bool {
        fs::read(self.installed()).unwrap() == fs::read(env!("CARGO_BIN_EXE_oms")).unwrap()
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn update_replaces_this_program_with_the_newest_release() {
    let setup = Setup::new("v99.0.0");

    let check = setup.run(&["update", "--check"]);
    assert!(check.status.success(), "{}", text(&check.stderr));
    assert_eq!(text(&check.stdout), format!("oms 99.0.0 is available (installed {INSTALLED}). To install it, run\n  oms update\n"));
    assert!(setup.still_this_version(), "checking changes nothing");

    let update = setup.run(&["update"]);
    let said = text(&update.stdout);
    assert!(update.status.success(), "{}\n{}", said, text(&update.stderr));
    assert!(said.starts_with(&format!("Updating oms {INSTALLED} to 99.0.0\n")), "{said}");
    // The folder is named the way the system resolves it, which on macOS is under /private.
    let folder = fs::canonicalize(setup.home.0.join("bin")).unwrap();
    assert!(said.contains(&format!("Installed oms 99.0.0 to {}/oms", folder.display())), "{said}");
    assert!(!said.contains("sign this machine in"), "an update doesn't explain how to start: {said}");
    assert_eq!(fs::read_to_string(setup.installed()).unwrap(), NEXT_RELEASE, "the new release is where the old one was");
    assert!(!setup.home.0.join("elsewhere").exists(), "and nowhere else");
}

#[test]
fn update_restarts_a_background_agent_that_is_set_up() {
    let setup = Setup::new("v99.0.0");
    let service = setup.home.0.join("Library/LaunchAgents/dev.oh-my-stats.agent.plist");
    fs::create_dir_all(service.parent().unwrap()).unwrap();
    fs::write(&service, "").unwrap();
    let update = setup.run(&["update"]);
    assert!(update.status.success(), "{}", text(&update.stderr));
    assert!(text(&update.stdout).contains("The background service restarted on the new version."), "{}", text(&update.stdout));
}

#[test]
fn nothing_is_installed_when_this_is_the_newest_stable_release() {
    for tag in [format!("v{INSTALLED}"), "v0.0.1".to_string(), "v99.0.0-rc.1".to_string()] {
        let setup = Setup::new(&tag);
        for args in [&["update"][..], &["update", "--check"][..]] {
            let update = setup.run(args);
            assert!(update.status.success(), "{tag}: {}", text(&update.stderr));
            assert_eq!(text(&update.stdout), format!("oms {INSTALLED} is up to date.\n"), "{tag}");
        }
        assert!(setup.still_this_version(), "{tag}");
    }
}

#[test]
fn an_install_script_that_fails_its_checksum_is_never_run() {
    let setup = Setup::new("v99.0.0");
    let script = setup.release.0.join("install.sh");
    let marker = setup.home.0.join("ran");
    fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    let update = setup.run(&["update"]);
    assert!(!update.status.success());
    assert!(text(&update.stderr).contains("install.sh doesn't match its checksum, so it wasn't run"), "{}", text(&update.stderr));
    assert!(!marker.exists() && setup.still_this_version());

    // A release that doesn't list the script at all is refused the same way.
    checksums(&setup.release.0, &[&archive_name()]);
    let update = setup.run(&["update"]);
    assert!(!update.status.success());
    assert!(text(&update.stderr).contains("install.sh isn't in the release's checksums"), "{}", text(&update.stderr));
    assert!(!marker.exists() && setup.still_this_version());
}

#[test]
fn a_failed_install_leaves_this_version_and_says_what_to_run() {
    let setup = Setup::new("v99.0.0");
    fs::remove_file(setup.release.0.join(archive_name())).unwrap();
    let update = setup.run(&["update"]);
    assert!(!update.status.success());
    let complaint = text(&update.stderr);
    let folder = fs::canonicalize(setup.home.0.join("bin")).unwrap();
    assert!(complaint.contains("the installer stopped before it finished. To install it yourself, run"), "{complaint}");
    assert!(complaint.contains(&format!("curl -fsSL https://ohmystats.dev/install.sh | OMS_INSTALL_DIR='{}' sh", folder.display())), "{complaint}");
    assert!(setup.still_this_version());

    // Without an answer about the latest release, nothing is attempted.
    fs::remove_file(setup.release.0.join("latest.json")).unwrap();
    let update = setup.run(&["update"]);
    assert!(!update.status.success());
    assert!(text(&update.stderr).contains("couldn't ask GitHub for the latest release"), "{}", text(&update.stderr));
    assert!(setup.still_this_version());
}
