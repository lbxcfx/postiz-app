#!/bin/bash
echo "Cleaning up processes..."

pkill -f 'node' || echo "No node processes found."
pkill -f 'python' || echo "No python processes found."
pkill -f 'uvicorn' || echo "No uvicorn processes found."
pkill -f 'social_auto_upload' || echo "No social upload processes found."

echo "Cleanup complete."
