/**
 * Progress Reporter
 *
 * Displays download progress, speed, peers, and buffering status.
 * Updates in-place using carriage returns for clean terminal output.
 */

import chalk from "chalk";

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return "0 B/s";
  return fmtBytes(bytesPerSec) + "/s";
}

export class ProgressReporter {
  constructor(videoFile, torrent, prioritizer) {
    this.videoFile = videoFile;
    this.torrent = torrent;
    this.prioritizer = prioritizer;

    this.interval = null;
    this.lastDl = -1;
    this.startTime = Date.now();
    this.isBuffering = false;
    this.bufferingSince = 0;
    this.lastSpeedSamples = [];
  }

  /**
   * Start periodic progress reporting
   */
  start(intervalMs = 1000) {
    this.startTime = Date.now();
    this.interval = setInterval(() => this._update(), intervalMs);
  }

  /**
   * Stop reporting
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Clear the line
    process.stdout.write("\r" + " ".repeat(100) + "\r");
  }

  /**
   * Update the progress display
   */
  _update() {
    try {
      const stats = this._getStats();
      this._render(stats);
    } catch {}
  }

  /**
   * Gather stats from all sources
   */
  _getStats() {
    const downloaded = this.videoFile.downloaded || 0;
    const total = this.videoFile.length || 1;
    const percent = (downloaded / total) * 100;

    // Speed (smoothed over 3 samples)
    const rawSpeed = this.torrent.downloadSpeed || 0;
    this.lastSpeedSamples.push(rawSpeed);
    if (this.lastSpeedSamples.length > 3) this.lastSpeedSamples.shift();
    const speed = this.lastSpeedSamples.reduce((a, b) => a + b, 0) / this.lastSpeedSamples.length;

    const peers = this.torrent.numPeers || 0;
    const ratio = this.torrent.ratio || 0;

    // Buffering detection
    const isBuffering = speed < 1024 && percent < 100 && peers > 0;
    if (isBuffering && !this.isBuffering) {
      this.isBuffering = true;
      this.bufferingSince = Date.now();
    } else if (!isBuffering && this.isBuffering) {
      this.isBuffering = false;
    }

    // Piece-level progress
    const pieceStats = this.prioritizer ? this.prioritizer.getStats() : null;

    // Elapsed time
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const elapsedStr = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

    // ETA
    const remaining = total - downloaded;
    const eta = speed > 0 ? Math.ceil(remaining / speed) : Infinity;
    const etaStr = eta === Infinity ? "--:--" : `${Math.floor(eta / 60)}:${String(eta % 60).padStart(2, "0")}`;

    return {
      downloaded,
      total,
      percent,
      speed,
      peers,
      ratio,
      isBuffering,
      bufferingSince: this.bufferingSince,
      pieceStats,
      elapsed: elapsedStr,
      eta: etaStr,
    };
  }

  /**
   * Render the progress line
   */
  _render(stats) {
    const { downloaded, total, percent, speed, peers, isBuffering, elapsed, eta, pieceStats } = stats;

    // Detect changes
    const dl = Math.floor(downloaded / (1024 * 1024)); // MB
    if (dl === this.lastDl) return;
    this.lastDl = dl;

    // Build progress bar
    const barWidth = 20;
    const filled = Math.floor((percent / 100) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    // Piece info
    const pieceInfo = pieceStats
      ? `pieces: ${pieceStats.downloaded}/${pieceStats.totalPieces}`
      : "";

    // Status indicator
    let status;
    if (isBuffering) {
      status = chalk.yellow("⟳ buffering");
    } else if (percent >= 100) {
      status = chalk.green("✓ complete");
    } else {
      status = chalk.cyan("▶ streaming");
    }

    // Build line
    const line = [
      status,
      chalk.gray(`${elapsed} / ${eta}`),
      chalk.cyan(`${bar} ${percent.toFixed(1)}%`),
      chalk.green(fmtSpeed(speed)),
      chalk.yellow(`${peers} peers`),
      pieceInfo ? chalk.gray(pieceInfo) : "",
    ].filter(Boolean).join("  ");

    process.stdout.write(`\r${" ".repeat(100)}\r  ${line}`);
  }

  /**
   * Print final summary
   */
  printSummary() {
    const stats = this._getStats();
    const serverStats = {};

    console.log();
    console.log(chalk.gray("  ─── Stream Summary ───"));
    console.log(chalk.gray(`  File:     ${this.videoFile.name}`));
    console.log(chalk.gray(`  Size:     ${fmtBytes(this.videoFile.length)}`));
    console.log(chalk.gray(`  Downloaded: ${fmtBytes(stats.downloaded)} (${stats.percent.toFixed(1)}%)`));
    console.log(chalk.gray(`  Peers:    ${stats.peers}`));
    console.log(chalk.gray(`  Elapsed:  ${stats.elapsed}`));
    if (stats.pieceStats) {
      console.log(chalk.gray(`  Pieces:   ${stats.pieceStats.downloaded}/${stats.pieceStats.totalPieces}`));
    }
    console.log();
  }
}
