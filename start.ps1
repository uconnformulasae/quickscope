# QuickScope - start script (Windows PowerShell)
# Starts the Python backend and React frontend

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Install Python deps if needed
$hasLibxrk = $false
try {
    python -c "import libxrk" 2>$null
    if ($LASTEXITCODE -eq 0) { $hasLibxrk = $true }
} catch {}

if (-not $hasLibxrk) {
    Write-Host "Installing Python dependencies..."
    pip install -r backend/requirements.txt
}

# Install Node deps if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing Node dependencies..."
    npm install
}

# Start backend
Write-Host "Starting QuickScope backend on :8000..."
$backend = Start-Process -FilePath "python" `
    -ArgumentList "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000" `
    -WorkingDirectory (Join-Path $PSScriptRoot "backend") `
    -NoNewWindow -PassThru

# Start frontend dev server
Write-Host "Starting QuickScope frontend on :5000..."
$frontend = Start-Process -FilePath "npm" `
    -ArgumentList "run", "dev" `
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
