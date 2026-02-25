#!/bin/bash
# Build WASM AI engine and copy to project root
# Run from the dominos project root

set -e

echo "Building WASM AI engine..."
cd wasm-ai
export PATH="$HOME/.cargo/bin:$PATH"
wasm-pack build --target no-modules --release --out-dir ../wasm-out

echo "Copying artifacts..."
cp ../wasm-out/dominos_ai.js ../dominos_ai.js
cp ../wasm-out/dominos_ai_bg.wasm ../dominos_ai_bg.wasm

echo "Done! Files:"
ls -la ../dominos_ai.js ../dominos_ai_bg.wasm
echo ""
echo "Remember to bump sw.js cache version!"
