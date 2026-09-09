# QuickScope - start script (Windows PowerShell)
# Starts the Python backend and React frontend
#
# Usage:
#   ./start.ps1           Auto: AiM DLL on Windows when available, else libxrk
#   ./start.ps1 -Libxrk   Force libxrk parser
#   ./start.ps1 -Dll      Force AiM DLL parser (Windows only)

param(
    [switch]$Libxrk,
    [switch]$Dll
)

$ErrorActionPreference = "Stop"

if ($Libxrk -and $Dll) {
    Write-Error "Use only one parser flag: -Libxrk or -Dll."
}

Set-Location -Path $PSScriptRoot

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

# Create venv if missing
if (-not (Test-Path $venvPy)) {
    Write-Host "Creating Python virtual environment (.venv)..."
    python -m venv .venv
}

# Install Python deps if needed
$hasLibxrk = $false
try {
    & $venvPy -c "import libxrk" 2>$null
    if ($LASTEXITCODE -eq 0) { $hasLibxrk = $true }
} catch {}

if (-not $hasLibxrk) {
    Write-Host "Installing Python dependencies..."
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r backend/requirements.txt
}

# Install Node deps if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing Node dependencies..."
    npm install
}

# npm 11+ warns on devdir injected by some tooling (e.g. Cursor); not a valid npm config key.
foreach ($envName in @("npm_config_devdir", "NPM_CONFIG_DEVDIR")) {
    if (Test-Path "Env:$envName") {
        Remove-Item "Env:$envName" -ErrorAction SilentlyContinue
    }
}

function Stop-ListenerOnPort([int]$Port) {
    $matches = netstat -ano | Select-String ":$Port\s+.*LISTENING\s+(\d+)"
    foreach ($match in $matches) {
        $procId = [int]$match.Matches[0].Groups[1].Value
        if ($procId -gt 0) {
            Write-Host "Stopping existing process on port $Port (PID $procId)..."
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
}

Stop-ListenerOnPort 8000
Stop-ListenerOnPort 5000

# Parser selection (backend reads QUICKSCOPE_PARSER)
$parserMode = "auto"
if ($Libxrk) {
    $env:QUICKSCOPE_PARSER = "libxrk"
    $parserMode = "libxrk"
} elseif ($Dll) {
    $env:QUICKSCOPE_PARSER = "aim_dll"
    $parserMode = "aim_dll"
} else {
    Remove-Item Env:QUICKSCOPE_PARSER -ErrorAction SilentlyContinue
}

# Start backend
Write-Host "Starting QuickScope backend on :8000 (parser: $parserMode)..."
$backend = Start-Process -FilePath $venvPy `
    -ArgumentList "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000" `
    -WorkingDirectory (Join-Path $PSScriptRoot "backend") `
    -NoNewWindow -PassThru

# Start frontend dev server (npm is a cmd shim — must run via cmd.exe on Windows)
Write-Host "Starting QuickScope frontend on :5000..."
$frontend = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm run dev" `
    -WorkingDirectory $PSScriptRoot `
    -NoNewWindow -PassThru

# Cleanup on exit
$cleanup = {
    Write-Host "`nShutting down..."
    if ($backend -and -not $backend.HasExited)  { Stop-Process -Id $backend.Id  -Force -ErrorAction SilentlyContinue }
    if ($frontend -and -not $frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
}
Register-EngineEvent PowerShell.Exiting -Action $cleanup | Out-Null

Write-Host ""
Write-Host "QuickScope is running!"
Write-Host "  Frontend: http://localhost:5000"
Write-Host "  Backend:  http://localhost:8000"
Write-Host ""
Write-Host "Press Ctrl+C to stop."

try {
    Wait-Process -Id $backend.Id, $frontend.Id
} finally {
    & $cleanup
}
