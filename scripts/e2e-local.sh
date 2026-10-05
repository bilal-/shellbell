#!/usr/bin/env bash
# Runs the relay locally. Start the agent (Plan 03) with:  shellbell start --relay ws://<LAN-IP>:8787
set -euo pipefail
cd "$(dirname "$0")/../apps/relay"
IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
echo "Relay dev server: ws://localhost:8787  (LAN: ws://${IP}:8787 — use the LAN form in the agent so the phone's QR works)"
exec pnpm wrangler dev --ip 0.0.0.0 --port 8787
