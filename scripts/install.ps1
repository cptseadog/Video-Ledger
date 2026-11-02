param(
    [string]$DataDir = 'D:\dev\Documents\Ivan\data\browse-history-tracker',
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$previousCache = $env:UV_CACHE_DIR
$env:UV_CACHE_DIR = Join-Path $projectDir '.uv-cache'
Push-Location $projectDir
try {
    & uv sync --python 3.12
    if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }
    $pythonPath = Join-Path $projectDir '.venv\Scripts\python.exe'
    $hostPath = Join-Path $projectDir 'native\host.py'
    $generated = Join-Path $projectDir 'native\generated'
    New-Item -ItemType Directory -Force -Path $generated | Out-Null
    $dataPath = [IO.Path]::GetFullPath($DataDir)
    # The native bridge receives three paths in a UTF-8 configuration file.
    foreach ($p in @($pythonPath, $hostPath, $dataPath)) {
        if ($p -match '[%"\r\n]') { throw 'Installation paths cannot contain percent signs, quotes, or newlines.' }
    }
    $extensionManifest = Get-Content -Raw (Join-Path $projectDir 'extension\manifest.json') | ConvertFrom-Json
    $sha = [Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([Convert]::FromBase64String($extensionManifest.key))
    $extensionId = -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
    $launcherPath = Join-Path $generated 'video-ledger-host.exe'
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler was not found.' }
    & $compiler /nologo /target:winexe /optimize+ "/out:$launcherPath" (Join-Path $projectDir 'native\Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed' }
    [IO.File]::WriteAllLines((Join-Path $generated 'host-config.txt'), @($pythonPath, $hostPath, $dataPath), (New-Object Text.UTF8Encoding($false)))
    $nativeManifestPath = Join-Path $generated 'com.seadog.video_ledger.json'
    $nativeManifest = @{
        name = 'com.seadog.video_ledger'
        description = 'Video Ledger local SQLite storage'
        path = $launcherPath
        type = 'stdio'
        allowed_origins = @("chrome-extension://$extensionId/")
    } | ConvertTo-Json
    [IO.File]::WriteAllText($nativeManifestPath, $nativeManifest, (New-Object Text.UTF8Encoding($false)))
    & $pythonPath $hostPath --data-dir $dataPath --check
    if ($LASTEXITCODE -ne 0) { throw 'Native helper self-check failed' }
    if (!$PrepareOnly) {
        $registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.seadog.video_ledger'
        New-Item -Path $registryPath -Force | Out-Null
        Set-Item -LiteralPath $registryPath -Value $nativeManifestPath
        Write-Output 'Registered the native helper for the current Windows user.'
    }
    Write-Output "Extension ID: $extensionId"
    Write-Output "Load unpacked directory: $(Join-Path $projectDir 'extension')"
    Write-Output "Database: $(Join-Path $dataPath 'history.sqlite3')"
} finally { $env:UV_CACHE_DIR = $previousCache; Pop-Location }
