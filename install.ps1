# Installs oms.exe, the oh-my-stats program, on Windows.
#
#   irm https://ohmystats.dev/install.ps1 | iex
#
# It downloads the latest release from GitHub, checks it against the release's checksums,
# and puts oms.exe in ~\.local\bin, which it adds to your PATH. Run it again to update: if
# oms already runs in the background, it restarts on the new version.
#
#   $env:OMS_VERSION       a release to install instead of the latest, such as v0.1.0
#   $env:OMS_INSTALL_DIR   where to put oms.exe, instead of ~\.local\bin
#   $env:OMS_DOWNLOAD_URL  a copy of the release's files to use instead of GitHub's
#
# `oms update` runs this script too, and sets $env:OMS_UPDATING so it doesn't end by
# explaining how to sign in to a machine that already is.

# A script block keeps this script's variables and settings out of the session that runs it,
# and `throw` stops it without closing that session's window, which `exit` would do.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell draws a progress bar that makes downloads many times slower.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'saintlee83/oh-my-stats'
  $installDir = if ($env:OMS_INSTALL_DIR) { $env:OMS_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }
  $installDir = [IO.Path]::GetFullPath($installDir).TrimEnd('\')

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  $target = switch ($arch) {
    'AMD64' { 'x86_64-pc-windows-msvc' }
    'ARM64' { 'aarch64-pc-windows-msvc' }
    default { throw "There's no prebuilt oms for $arch. Build it from source: https://github.com/$repo#build-from-source" }
  }

  $archive = "oms-$target.zip"
  $version = $env:OMS_VERSION
  if ($version -and -not $version.StartsWith('v')) { $version = "v$version" }
  $base = "https://github.com/$repo/releases/latest/download"
  if ($version) { $base = "https://github.com/$repo/releases/download/$version" }
  if ($env:OMS_DOWNLOAD_URL) { $base = $env:OMS_DOWNLOAD_URL.TrimEnd('/') }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('oms-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Write-Host "Downloading $archive"
    foreach ($file in $archive, 'SHA256SUMS') {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $tmp $file)
      } catch {
        throw "Couldn't download $base/$file. $($_.Exception.Message)"
      }
    }

    $expected = Get-Content (Join-Path $tmp 'SHA256SUMS') | ForEach-Object {
      $hash, $name = -split $_
      if ($name -eq $archive -or $name -eq "*$archive") { $hash }
    } | Select-Object -First 1
    if (-not $expected) { throw "$archive isn't in the release's checksums." }
    $actual = (Get-FileHash (Join-Path $tmp $archive) -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "$archive doesn't match its checksum, so it wasn't installed." }

    Expand-Archive (Join-Path $tmp $archive) -DestinationPath (Join-Path $tmp 'files') -Force

    # Windows can't replace a program while it runs, so stop the oms this would replace.
    # If it runs in the background, it starts again below.
    $running = @(Get-Process oms, omsw -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and ((Split-Path $_.Path -Parent) -eq $installDir)
    })
    if ($running) {
      $running | Stop-Process -Force
      $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    }

    New-Item -ItemType Directory -Force $installDir | Out-Null
    # omsw.exe runs oms in the background with no console window.
    Copy-Item (Join-Path $tmp 'files\oms.exe'), (Join-Path $tmp 'files\omsw.exe') $installDir -Force
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  $oms = Join-Path $installDir 'oms.exe'
  $installed = & $oms --version
  if ($LASTEXITCODE -ne 0) { throw "oms was installed to $oms, but it didn't run." }
  Write-Host "Installed $installed to $oms"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') })
  if ($entries -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', ((@($installDir) + $entries) -join ';'), 'User')
    Write-Host "Added $installDir to your PATH. Terminals that were already open need restarting to see it."
  }
  if (@($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $installDir) {
    $env:Path = "$installDir;$env:Path"
  }

  $others = @(Get-Command oms -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object { $_.Path -ne $oms })
  foreach ($other in $others) {
    Write-Host ''
    Write-Host "Note: there's another oms at $($other.Path). Remove it, for example with ``cargo uninstall oh-my-stats``, so you run this one."
  }

  # If oms already runs in the background, it moves to the new version.
  $startup = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'oh-my-stats' -ErrorAction SilentlyContinue
  Write-Host ''
  if ($startup) {
    & $oms service install | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host 'The background service restarted on the new version.'
    } else {
      Write-Host "Couldn't restart the background service. Run: oms service install"
    }
  } elseif (-not $env:OMS_UPDATING) {
    Write-Host 'Next, sign this machine in and keep it tracking:'
    Write-Host ''
    Write-Host '  oms login'
    Write-Host '  oms sync'
    Write-Host '  oms service install'
  }
}
