#!/bin/sh
# Installs the oh-my-stats agent, `oms`, on macOS or Linux.
#
#   curl -fsSL https://ohmystats.dev/install.sh | sh
#
# It downloads the latest release from GitHub, checks it against the release's checksums,
# and puts `oms` in ~/.local/bin. Run it again to update: a background agent that's already
# set up restarts on the new version.
#
#   OMS_VERSION       a release to install instead of the latest, such as v0.1.0
#   OMS_INSTALL_DIR   where to put `oms`, instead of ~/.local/bin
#   OMS_DOWNLOAD_URL  a copy of the release's files to use instead of GitHub's

set -eu

repo=saintlee83/oh-my-stats
install_dir=${OMS_INSTALL_DIR:-$HOME/.local/bin}

say() { printf '%s\n' "$@"; }
fail() {
  printf 'oms install: %s\n' "$*" >&2
  exit 1
}

case $(uname -s) in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) fail "this script is for macOS and Linux. On Windows, run this in PowerShell: irm https://ohmystats.dev/install.ps1 | iex" ;;
esac

case $(uname -m) in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "there's no prebuilt agent for $(uname -m). Build it from source: https://github.com/$repo#build-from-source" ;;
esac

# A terminal running under Rosetta reports x86_64 on Apple silicon, where the native build is better.
if [ "$os" = apple-darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=aarch64
fi

archive=oms-$arch-$os.tar.gz
version=${OMS_VERSION:-}
case $version in
  '' | v*) ;;
  *) version=v$version ;;
esac
if [ -n "${OMS_DOWNLOAD_URL:-}" ]; then
  base=${OMS_DOWNLOAD_URL%/}
elif [ -n "$version" ]; then
  base=https://github.com/$repo/releases/download/$version
else
  base=https://github.com/$repo/releases/latest/download
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto-redir '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed to download the agent"
  fi
}

tmp=$(mktemp -d)
staged=
cleanup() {
  rm -rf "$tmp"
  if [ -n "$staged" ]; then rm -f "$staged"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

say "Downloading $archive"
download "$base/$archive" "$tmp/$archive" || fail "couldn't download $base/$archive"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download the release's checksums"

expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "$archive isn't in the release's checksums"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')
else
  fail "sha256sum or shasum is needed to check the download"
fi
[ "$actual" = "$expected" ] || fail "$archive doesn't match its checksum, so it wasn't installed"

tar -xzf "$tmp/$archive" -C "$tmp" oms

# Moving the new file into place, rather than writing over the old one, leaves an agent
# that's running undisturbed until it restarts.
mkdir -p "$install_dir"
oms=$install_dir/oms
staged=$install_dir/.oms-install.$$
cp "$tmp/oms" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$oms"
staged=

installed=$("$oms" --version) || fail "the agent was installed to $oms, but it didn't run"
say "Installed $installed to $oms"

case ":$PATH:" in
  *":$install_dir:"*)
    cmd=oms
    found=$(command -v oms 2>/dev/null || true)
    if [ -n "$found" ] && [ "$found" != "$oms" ]; then
      say "" "Note: $found comes first on your PATH, so \`oms\` still runs that one." \
        "Remove it, for example with \`cargo uninstall oh-my-stats\`."
    fi
    ;;
  *)
    cmd=$oms
    say "" "$install_dir isn't on your PATH yet. Add this line to your shell's startup file," \
      "such as ~/.zshrc or ~/.bashrc, then open a new terminal:" "" \
      "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

# An agent that already runs in the background moves to the new version.
if [ -f "$HOME/Library/LaunchAgents/dev.oh-my-stats.agent.plist" ] || [ -f "$HOME/.config/systemd/user/oh-my-stats.service" ]; then
  if "$oms" service install >/dev/null; then
    say "" "The background agent restarted on the new version."
  else
    say "" "Couldn't restart the background agent. Run: $cmd service install"
  fi
else
  say "" "Next, sign this machine in and keep it tracking:" "" \
    "  $cmd login" "  $cmd sync" "  $cmd service install"
fi
