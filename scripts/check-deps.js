#!/usr/bin/env node

import { execSync } from "child_process";

const REQUIRED = [
  { cmd: "node", name: "Node.js", min: "20.0.0" },
  { cmd: "pnpm", name: "pnpm", min: "8.0.0" },
  { cmd: "mpv", name: "MPV player", min: null },
  { cmd: "fzf", name: "fzf", min: null },
];

function semverGte(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return true;
}

function getVersion(cmd) {
  try {
    const out = execSync(`${cmd} --version 2>&1`, { encoding: "utf-8", timeout: 5000 });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RED = "31";
const GREEN = "32";
const YELLOW = "33";
const CYAN = "36";
const BOLD = "1";
const DIM = "2";

console.log();
console.log(color(BOLD, "  Dependency Check"));
console.log(color(DIM, "  ────────────────────────────────"));

let allGood = true;

for (const dep of REQUIRED) {
  const ver = getVersion(dep.cmd);
  if (ver) {
    const versionOk = dep.min ? semverGte(ver, dep.min) : true;
    if (versionOk) {
      console.log(`  ${color(GREEN, "✓")} ${dep.name} ${color(DIM, "v" + ver)}`);
    } else {
      console.log(`  ${color(RED, "✗")} ${dep.name} ${color(YELLOW, "v" + ver + " (need " + dep.min + "+)")}`);
      allGood = false;
    }
  } else {
    console.log(`  ${color(RED, "✗")} ${dep.name} ${color(RED, "not found")}`);
    allGood = false;
  }
}

// Check node_modules
import { existsSync } from "fs";
if (existsSync("node_modules")) {
  console.log(`  ${color(GREEN, "✓")} node_modules ${color(DIM, "installed")}`);
} else {
  console.log(`  ${color(RED, "✗")} node_modules ${color(RED, "not found — run pnpm install")}`);
  allGood = false;
}

console.log(color(DIM, "  ────────────────────────────────"));

if (allGood) {
  console.log(color(GREEN, "  All dependencies satisfied!"));
  console.log();
  process.exit(0);
} else {
  console.log();
  console.log(color(YELLOW, "  Install missing dependencies:"));
  console.log(color(CYAN, "    Ubuntu/Debian:  sudo apt install mpv fzf"));
  console.log(color(CYAN, "    macOS:          brew install mpv fzf"));
  console.log(color(CYAN, "    Arch:           sudo pacman -S mpv fzf"));
  console.log(color(CYAN, "    Node deps:      pnpm install"));
  console.log();
  process.exit(1);
}
