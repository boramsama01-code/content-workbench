param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [string]$CodexPath = '',
  [string]$StudioUrl = 'https://spacepenguin.onrender.com',
  [string]$InstallDirectory = "$env:LOCALAPPDATA\SpacePenguinWriter",
  [string]$BundlePath = '',
  [switch]$LocalTest,
  [switch]$Start,
  [switch]$Autostart
)
$ErrorActionPreference = 'Stop'
$writerInstall = [IO.Path]::GetFullPath($InstallDirectory)
$writerNode = (Get-Item -LiteralPath $NodePath).FullName
if (!$CodexPath) { $CodexPath = (Get-Command codex.exe -ErrorAction Stop).Source }
$writerCodex = (Get-Item -LiteralPath $CodexPath).FullName
$writerUri = [Uri]$StudioUrl
if ($writerUri.AbsoluteUri -ne 'https://spacepenguin.onrender.com/' -and !($LocalTest -and $writerUri.Scheme -eq 'http' -and $writerUri.Host -in @('127.0.0.1','localhost'))) { throw '허용되지 않은 주소입니다.' }
$writerBundle = $BundlePath
if (!$writerBundle) {
  if ($PSScriptRoot) { $writerBundle = Join-Path $PSScriptRoot '..\dist\local-writer\worker.mjs' }
  else { $writerBundle = Join-Path (Get-Location).Path 'dist\local-writer\worker.mjs' }
}
if (!(Test-Path -LiteralPath $writerBundle)) { throw '먼저 글쓰기 연결 프로그램을 빌드해 주세요.' }
[IO.Directory]::CreateDirectory($writerInstall) | Out-Null
$writerTokenFile = Join-Path $writerInstall 'connection.dpapi'
Add-Type -AssemblyName System.Security
if (!(Test-Path -LiteralPath $writerTokenFile)) {
  $writerRandom = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($writerRandom)
  $writerToken = [Convert]::ToBase64String($writerRandom).TrimEnd('=').Replace('+','-').Replace('/','_')
  $writerClear = [Text.Encoding]::UTF8.GetBytes($writerToken)
  [IO.File]::WriteAllBytes($writerTokenFile, [Security.Cryptography.ProtectedData]::Protect($writerClear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
  [Array]::Clear($writerRandom, 0, $writerRandom.Length)
} else { $writerClear = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($writerTokenFile), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
try { $writerHash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($writerClear) | ForEach-Object { $_.ToString('x2') }) }
finally { [Array]::Clear($writerClear, 0, $writerClear.Length); $writerToken = $null }
$writerTarget = Join-Path $writerInstall 'worker.mjs'
Copy-Item -LiteralPath $writerBundle -Destination $writerTarget -Force
Copy-Item -LiteralPath $writerNode -Destination (Join-Path $writerInstall 'node.exe') -Force
$writerConfig = @{studioUrl=$writerUri.AbsoluteUri;codexPath=$writerCodex;deviceName='우주펭귄 제작 PC';tokenFile=$writerTokenFile;allowLoopbackTest=[bool]$LocalTest}
$writerConfig | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $writerInstall 'config.json') -Encoding UTF8
# A startup shortcut opens only this helper, hidden, without changing PowerShell policy or computer power settings.
$writerLaunch = 'CreateObject("WScript.Shell").Run """' + (Join-Path $writerInstall 'node.exe') + '"" ""' + $writerTarget + '"" ""' + (Join-Path $writerInstall 'config.json') + '""", 0, False'
[IO.File]::WriteAllText((Join-Path $writerInstall 'start-writer.vbs'), $writerLaunch, [Text.Encoding]::Unicode)
if ($Autostart) {
  if ($LocalTest) { throw '테스트 연결은 자동 시작으로 등록하지 않습니다.' }
  $writerShell = New-Object -ComObject WScript.Shell
  $writerLink = $writerShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'SpacePenguin Writer.lnk'))
  $writerLink.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $writerLink.Arguments = '"' + (Join-Path $writerInstall 'start-writer.vbs') + '"'
  $writerLink.WorkingDirectory = $writerInstall
  $writerLink.WindowStyle = 7
  $writerLink.Save()
}
if ($Start) { Start-Process -FilePath (Join-Path $writerInstall 'node.exe') -ArgumentList @(('"'+$writerTarget+'"'),('"'+(Join-Path $writerInstall 'config.json')+'"')) -WindowStyle Hidden | Out-Null }
# Only the server-side fingerprint is returned. The bearer token and Codex login never leave their local stores.
@{installed=$true;directory=$writerInstall;tokenSha256=$writerHash;autostart=[bool]$Autostart;started=[bool]$Start} | ConvertTo-Json -Compress
