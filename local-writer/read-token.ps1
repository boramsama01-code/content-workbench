param([Parameter(Mandatory=$true)][string]$TokenFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$writerBytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($TokenFile))
$writerClear = [Security.Cryptography.ProtectedData]::Unprotect($writerBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($writerClear)) }
finally { [Array]::Clear($writerClear, 0, $writerClear.Length) }
