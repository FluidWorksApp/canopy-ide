# Signs one Windows file in place with SSL.com eSigner (CodeSignTool), with SSL.com's timestamp.
# Tauri's `bundle.windows.signCommand` calls it once per file (the app, its sidecars, the NSIS installer and its
# uninstaller); .github/workflows/release.yml sets that up for the Windows build:
#
#   pwsh -NoProfile -File scripts/esigner-sign.ps1 <file>
#
# Reads ES_USERNAME, ES_PASSWORD, ES_TOTP_SECRET and, if the account has more than one eSigner certificate,
# ES_CREDENTIAL_ID from the environment (never the command line, so Tauri's log of the command shows no secret), and
# CODESIGNTOOL_DIR, the unpacked CodeSignTool for Windows (the release workflow sets it).
#
# Every call is a paid signing on the eSigner plan, so this never retries: a failure stops the build.

param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

foreach ($k in 'ES_USERNAME', 'ES_PASSWORD', 'ES_TOTP_SECRET', 'CODESIGNTOOL_DIR') {
  if (-not [Environment]::GetEnvironmentVariable($k)) { throw "esigner-sign: $k is not set" }
}
$tool = $env:CODESIGNTOOL_DIR
$jar = Get-ChildItem -Path (Join-Path $tool 'jar') -Filter 'code_sign_tool-*.jar' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jar) { throw "esigner-sign: no jar/code_sign_tool-*.jar under $tool" }
# The Windows download carries its own Java runtime; use the runner's Java only if it doesn't.
$java = Get-ChildItem -Path $tool -Recurse -Filter 'java.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$javaExe = if ($java) { $java.FullName } else { 'java' }

$target = (Resolve-Path -LiteralPath $File).Path
$name = Split-Path -Leaf $target

# Tauri also hands over the NSIS plugin DLLs and bundled DLLs (ONNX Runtime comes signed by Microsoft), every release.
# Only the executables are signed (the app, its sidecars, the installer, its uninstaller), never a file twice, since
# each is paid.
$ext = [IO.Path]::GetExtension($target).ToLower()
# The NSIS uninstaller arrives as a temp file (nst*.tmp, from !uninstfinalize) that NSIS packs once this returns.
$uninstaller = $name -like 'nst*.tmp'
if ($ext -ne '.exe' -and $ext -ne '.msi' -and -not $uninstaller) {
  Write-Host "esigner-sign: skipping $name (not shipped as a signed file)"
  exit 0
}
if ((Get-AuthenticodeSignature -LiteralPath $target).Status -eq 'Valid') {
  Write-Host "esigner-sign: skipping $name (already signed)"
  exit 0
}

# One one-time code per 30-second window: if the last file was signed in this window, wait for the next, so a second
# file in quick succession is not refused for reusing the code (a refused call can still count as a signing).
$stamp = Join-Path ([IO.Path]::GetTempPath()) 'esigner-last-window'
$window = [math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 30)
if ((Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq "$window")) {
  $wait = 30 - ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() % 30) + 1
  Write-Host "esigner-sign: waiting $wait s for a fresh one-time code"
  Start-Sleep -Seconds $wait
}

# Signed into a folder of its own, then moved over the original: without -output_dir_path the tool asks before it
# overwrites, which would hang an unattended build.
$out = Join-Path ([IO.Path]::GetTempPath()) ("esigner-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null

# CodeSignTool chooses how to sign from the extension, so the uninstaller is signed as a copy named .exe.
$source = $target
$signedName = $name
$inDir = $null
if ($uninstaller) {
  $inDir = Join-Path ([IO.Path]::GetTempPath()) ("esigner-in-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $inDir | Out-Null
  $signedName = 'uninstall.exe'
  $source = Join-Path $inDir $signedName
  Copy-Item -LiteralPath $target -Destination $source
}

$toolArgs = @(
  '-jar', $jar.FullName, 'sign',
  "-username=$env:ES_USERNAME",
  "-password=$env:ES_PASSWORD",
  "-totp_secret=$env:ES_TOTP_SECRET",
  "-input_file_path=$source",
  "-output_dir_path=$out"
)
if ($env:ES_CREDENTIAL_ID) { $toolArgs += "-credential_id=$env:ES_CREDENTIAL_ID" }

Write-Host "esigner-sign: signing $name"
# The tool reads conf/ from its own folder, so it runs there.
Push-Location $tool
try {
  $log = & $javaExe @toolArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
} finally {
  Pop-Location
  if ($inDir) { Remove-Item -Recurse -Force $inDir -ErrorAction SilentlyContinue }
  [math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 30) | Set-Content $stamp
}
Write-Host $log.Trim()

# CodeSignTool can print an error and still exit 0, so success is a file it wrote that Windows finds validly signed,
# not the exit code or the wording of its log.
$signed = Join-Path $out $signedName
$status = if (Test-Path -LiteralPath $signed) { (Get-AuthenticodeSignature -LiteralPath $signed).Status } else { 'missing' }
if ($status -ne 'Valid') {
  Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
  throw "esigner-sign: $name was not signed (exit $code, signature $status)"
}
Move-Item -Force -LiteralPath $signed -Destination $target
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
Write-Host "esigner-sign: $name signed"
