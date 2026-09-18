#!/usr/bin/env bash
# Mobile Agent — PC Edition · setup (Linux / macOS)
set -e
cd "$(dirname "$0")"

echo ""
echo "  Mobile Agent — PC Edition · Setup"
echo "  ================================"
echo ""

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "  [x] Node.js was not found."
  echo "      Install the LTS from https://nodejs.org and run this again."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "  [1/3] Node.js $(node --version) found."
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  [x] Node.js 20+ required."
  exit 1
fi

# 2. Dependencies
echo "  [2/3] Installing dependencies (first run takes a minute)…"
cd pc
npm install --no-audit --no-fund
cd ..

# 3. Data dir
mkdir -p pc/data
echo "  [3/3] Data directory ready: pc/data"

echo ""
echo "  Setup complete. Start the agent with:  ./start.sh"
echo ""
