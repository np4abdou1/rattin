#!/usr/bin/env node

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUILD_DIR = join(ROOT, "build");
const BUNDLE = join(BUILD_DIR, "rattin.mjs");
const BINARY = join(BUILD_DIR, "rattin");

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const BOLD = "1";
const GREEN = "32";
const CYAN = "36";
const DIM = "2";
const YELLOW = "33";

console.log();

// Clean build dir
if (existsSync(BUILD_DIR)) {
  rmSync(BUILD_DIR, { recursive: true });
}
mkdirSync(BUILD_DIR, { recursive: true });

console.log(color(BOLD, "  Building rattin..."));
console.log();

// Step 1: Bundle with esbuild
console.log(color(CYAN, "  [1/2] Bundling with esbuild..."));
try {
  execSync(
    `npx esbuild bin/rattin.js --bundle --platform=node --target=node20 --format=esm --outfile=build/rattin.mjs --banner:js="#!/usr/bin/env node" --external:node-datachannel --external:utp-native --external:simple-peer --external:bittorrent-protocol`,
    { cwd: ROOT, stdio: "inherit" }
  );
  console.log(color(GREEN, "  ✓ Bundle created"));
} catch {
  console.error(color("31", "  ✗ esbuild failed"));
  process.exit(1);
}

// Step 2: Create shell wrapper
console.log(color(CYAN, "  [2/2] Creating executable..."));
const wrapper = `#!/bin/bash
# rattin - bundled CLI
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/rattin.mjs" "$@"
`;
writeFileSync(BINARY, wrapper);
chmodSync(BINARY, 0o755);

console.log(color(GREEN, "  ✓ Executable created"));
console.log();

// Summary
const bundleSize = execSync(`wc -c < "${BUNDLE}"`).toString().trim();
const sizeMB = (parseInt(bundleSize) / 1024 / 1024).toFixed(1);

console.log(color(BOLD, "  Build complete!"));
console.log(color(DIM, "  ────────────────────────────────"));
console.log(`  Output:   ${color(CYAN, BINARY)}`);
console.log(`  Size:     ${color(YELLOW, sizeMB + " MB")}`);
console.log(color(DIM, "  ────────────────────────────────"));
console.log();
console.log(color(DIM, "  Run with:"));
console.log(color(CYAN, "    ./build/rattin"));
console.log(color(CYAN, "    ./build/rattin --help"));
console.log();
