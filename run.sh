#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND="$ROOT/frontend"
BACKEND="$ROOT/backend"

echo "==> building frontend..."
cd "$FRONTEND"
npm install --silent
npm run build

echo "==> installing backend dependencies..."
cd "$BACKEND"
pip install -q -r requirements.txt

echo "==> launching app..."
python launch.py
