#!/bin/bash
# QuickScope — start script
# Starts the Python backend and React frontend

set -e
cd "$(dirname "$0")"

# Pick a Python 3.10+ interpreter
if command -v python3.12 >/dev/null 2>&1; then
    PYTHON=python3.12
elif command -v python3.11 >/dev/null 2>&1; then
    PYTHON=python3.11
elif command -v python3.10 >/dev/null 2>&1; then
    PYTHON=python3.10
else
    PYTHON=python3
fi

# Create venv if missing
if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment (.venv)..."
    "$PYTHON" -m venv .venv
fi

VENV_PY=".venv/bin/python"

# Install Python deps if libxrk missing inside the venv
if ! "$VENV_PY" -c "import libxrk" 2>/dev/null; then
    echo "Installing Python dependencies..."
    "$VENV_PY" -m pip install --upgrade pip
    "$VENV_PY" -m pip install -r backend/requirements.txt
fi

# Install Node deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Node dependencies..."
    npm install
fi

# Start backend
echo "Starting QuickScope backend on :8000..."
(cd backend && "../$VENV_PY" -m uvicorn main:app --host 0.0.0.0 --port 8000) &
BACKEND_PID=$!

# Start frontend dev server
echo "Starting QuickScope frontend on :5000..."
npm run dev &
FRONTEND_PID=$!

# Cleanup on exit
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM EXIT

echo ""
echo "QuickScope is running!"
echo "  Frontend: http://localhost:5000"
echo "  Backend:  http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop."
wait
