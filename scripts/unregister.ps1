$ErrorActionPreference = 'Stop'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.seadog.video_ledger'
if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath
}
Write-Output 'Native helper registration removed. Your SQLite database and source files were kept.'
