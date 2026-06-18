import { execSync } from "child_process";
import chalk from "chalk";

const REQUIRED = [
  { cmd: "node", name: "Node.js", min: "20.0.0" },
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

export function checkDeps() {
  const missing = [];

  for (const dep of REQUIRED) {
    const ver = getVersion(dep.cmd);
    if (!ver) {
      missing.push(dep);
      continue;
    }
    if (dep.min && !semverGte(ver, dep.min)) {
      missing.push({ ...dep, found: ver });
    }
  }

  if (missing.length > 0) {
    console.error(chalk.red.bold("\n  ✗ Missing or outdated dependencies:\n"));
    for (const m of missing) {
      if (m.found) {
        console.error(
          chalk.red(`    ${m.name}: found v${m.found}, need v${m.min}+`)
        );
      } else {
        console.error(chalk.red(`    ${m.name}: not found`));
      }
    }
    console.error(chalk.gray("\n  Install instructions:"));
    console.error(chalk.gray("    Ubuntu/Debian:"));
    console.error(chalk.cyan("      sudo apt install mpv fzf"));
    console.error(chalk.gray("    macOS:"));
    console.error(chalk.cyan("      brew install mpv fzf"));
    console.error(chalk.gray("    Arch:"));
    console.error(chalk.cyan("      sudo pacman -S mpv fzf\n"));
    process.exit(1);
  }
}
