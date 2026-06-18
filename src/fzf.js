import { spawn } from "child_process";

// Strip ANSI escape codes for matching
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

/**
 * Launch fzf with choices and return the selected value.
 * Colors show in fzf, matching uses stripped text.
 * @param {Array<{name: string, value: any}>} choices
 * @param {string} prompt
 * @returns {Promise<any>}
 */
export function fzfSelect(choices, prompt = "Select") {
  return new Promise((resolve, reject) => {
    // Map stripped name → choice for reliable matching
    const strippedMap = new Map();
    for (const c of choices) {
      strippedMap.set(stripAnsi(c.name).trim(), c);
    }

    const fzf = spawn("fzf", [
      "--prompt", `${prompt} > `,
      "--ansi",
      "--height", "40",
      "--reverse",
      "--border",
      "--info", "inline",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send colored names to fzf — renders with colors
    fzf.stdin.write(choices.map((c) => c.name).join("\n"));
    fzf.stdin.end();

    let stdout = "";
    fzf.stdout.on("data", (data) => { stdout += data.toString(); });

    fzf.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) {
        reject(new Error("ExitPromptError"));
        return;
      }

      // fzf --ansi strips colors from output, so match against stripped names
      const selected = stripAnsi(stdout.trim());
      const choice = strippedMap.get(selected);
      if (choice) {
        resolve(choice.value);
      } else {
        reject(new Error("No matching choice found"));
      }
    });

    fzf.on("error", (err) => reject(err));
  });
}
