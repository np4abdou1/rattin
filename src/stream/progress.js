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
  constructor(videoFile, torrent, prioritizer, streamManager = null) {
    this.videoFile = videoFile;
    this.torrent = torrent;
    this.prioritizer = prioritizer;
    this._streamManager = streamManager;

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
    // Use manual tracking if available (works after piece corruption)
    let downloaded = 0;
    let speed = 0;
    let peers = 0;
    try {
      // Try torrent-level first
      downloaded = this.torrent?.downloaded || 0;
      speed = this.torrent?.downloadSpeed || 0;
      peers = this.torrent?.numPeers || 0;
    } catch {}
    // If torrent properties crash, try manual stats
    if (this._streamManager) {
      const stats = this._streamManager.getDownloadStats();
      if (stats.downloaded > downloaded) downloaded = stats.downloaded;
      if (stats.speed > 0) speed = stats.speed;
      if (stats.peers > 0) peers = stats.peers;
    }
    const total = this.videoFile.length || 1;
    const percent = Math.min(100, (downloaded / total) * 100);

    // Speed (smoothed over 3 samples)
    this.lastSpeedSamples.push(speed);
    if (this.lastSpeedSamples.length > 3) this.lastSpeedSamples.shift();
    const avgSpeed = this.lastSpeedSamples.reduce((a, b) => a + b, 0) / this.lastSpeedSamples.length;

    let ratio = 0;
    try { ratio = this.torrent?.ratio || 0; } catch {}

    // Buffering detection
    const isBuffering = avgSpeed < 1024 && percent < 100 && peers > 0;
    if (isBuffering && !this.isBuffering) {
      this.isBuffering = true;
      this.bufferingSince = Date.now();
    } else if (!isBuffering && this.isBuffering) {
      this.isBuffering = false;
    }

    // Piece-level progress (safe, works after corruption)
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
      speed: avgSpeed,
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
