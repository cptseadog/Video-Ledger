$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousCache = $env:UV_CACHE_DIR
Push-Location $projectDir
try {
    $env:UV_CACHE_DIR = Join-Path $projectDir '.uv-cache'
    New-Item -ItemType Directory -Force -Path (Join-Path $projectDir 'test-results') | Out-Null
    $env:TEMP = Join-Path $projectDir 'test-results'
    $env:TMP = $env:TEMP
    & uv run --offline python -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed' }
    & node --preserve-symlinks --preserve-symlinks-main --test tests/core.test.js tests/background.test.js
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $projectDir 'extension') -Filter '*.js') {
        Get-Content -Raw -LiteralPath $file.FullName | & node --input-type=module --check
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($file.Name)" }
    }
} finally {
    $env:TEMP = $previousTemp
    $env:TMP = $previousTmp
    $env:UV_CACHE_DIR = $previousCache
    Pop-Location
}
