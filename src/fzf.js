import { spawn } from "child_process";
import chalk from "chalk";

/**
 * Launch fzf with choices and return the selected value.
 * @param {Array<{name: string, value: any}>} choices
 * @param {string} prompt
 * @returns {Promise<any>}
 */
export function fzfSelect(choices, prompt = "Select") {
  return new Promise((resolve, reject) => {
    const fzf = spawn("fzf", [
      "--prompt", `${prompt} > `,
      "--ansi",
      "--height", "40",
      "--reverse",
      "--border",
      "--info", "inline",
      "--expect", "enter",
      "--bind", "tab:accept",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Send choices as lines
    const lines = choices.map((c) => c.name);
    fzf.stdin.write(lines.join("\n"));
    fzf.stdin.end();

    let stdout = "";
    let stderr = "";

    fzf.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    fzf.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    fzf.on("close", (code) => {
      // fzf returns 1 when user cancels (Esc/Ctrl-C)
      if (code !== 0 && !stdout.trim()) {
        reject(new Error("ExitPromptError"));
        return;
      }

      // --expect prepends the key pressed on the first line
      const outputLines = stdout.trim().split("\n");
      // Skip the first line (expect key) and get the selection
      const selectedName = outputLines[1] || outputLines[0];

      if (!selectedName) {
        reject(new Error("ExitPromptError"));
        return;
      }

      // Find the matching choice
      const choice = choices.find((c) => c.name === selectedName.trim());
      if (choice) {
        resolve(choice.value);
      } else {
        reject(new Error("No matching choice found"));
      }
    });

    fzf.on("error", (err) => {
      reject(err);
    });
  });
}
