#!/usr/bin/env bash
# Mobile Agent — PC Edition · start (Linux / macOS)
cd "$(dirname "$0")"

PORT="${1:-8787}"

if [ ! -d "pc/node_modules" ]; then
  echo "  Dependencies are missing. Run ./setup.sh first."
  exit 1
fi

echo ""
echo "  Mobile Agent — PC Edition"
echo "  Starting the local agent server on port $PORT …"
echo "  Press Ctrl+C to stop."
echo ""

cd pc
exec node server/index.js --port "$PORT" --open
