#!/bin/bash
# QuickScope — start script
# Starts the Python backend and React frontend

set -e
cd "$(dirname "$0")"

# Install Python deps if needed
if ! python3 -c "import libxrk" 2>/dev/null; then
    echo "Installing Python dependencies..."
    pip install -r backend/requirements.txt
fi

# Install Node deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Node dependencies..."
    npm install
fi

# Start backend
echo "Starting QuickScope backend on :8000..."
cd backend
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ..

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
