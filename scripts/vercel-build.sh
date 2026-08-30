#!/usr/bin/env bash
# Builds the workspaces the Conserve UI depends on before Vite runs.
#
# Vercel's Root Directory for the UI project is packages/ui, so its default
# build never compiles @conserve/contract or @conserve/api first. Those need
# the Compact toolchain, which isn't on Vercel's build image, so install it
# here the same way CI does.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! compact --version >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -LsSf \
    https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
compact update 0.31.1

npm run build -w @conserve/contract
npm run build -w @conserve/api
npm run build -w @conserve/ui
