#!/usr/bin/env bash
set -euo pipefail

# Assembly installer
# Builds from source and installs to ~/.local/bin

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

echo "🏭 Installing Assembly..."
echo ""

# Check bun
if ! command -v bun &>/dev/null; then
  echo "❌ Bun is required. Install it: https://bun.sh"
  exit 1
fi

# Install deps
echo "📦 Installing dependencies..."
cd "$REPO_DIR"
bun install --silent

# Compile binary
echo "🔨 Compiling binary..."
bun build --compile src/cli.ts --outfile assembly 2>&1

# Install to PATH
mkdir -p "$INSTALL_DIR"
cp assembly "$INSTALL_DIR/assembly"
chmod +x "$INSTALL_DIR/assembly"

# Check PATH
if ! echo "$PATH" | tr ':' '\n' | grep -q "$INSTALL_DIR"; then
  echo ""
  echo "⚠ $INSTALL_DIR is not in your PATH. Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Init global dir
"$INSTALL_DIR/assembly" init

echo ""
echo "✅ Assembly installed! Try:"
echo "   assembly list"
echo "   assembly enqueue hello-world --task 'Greet a new contributor'"
