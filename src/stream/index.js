/**
 * Stream Manager
 *
 * Orchestrates the entire streaming pipeline:
 *   Torrent → Temp Dir → Piece Prioritizer → HTTP Server → MPV
 */

import { spawn } from "child_process";
import chalk from "chalk";
import WebTorrent from "webtorrent";
import { createSafeTorrent, createSafeClient } from "./safe-torrent.js";
import { PiecePrioritizer, isPieceReady } from "./prioritizer.js";
import { StreamServer } from "./server.js";
import { ProgressReporter } from "./progress.js";
import { CleanupManager } from "./cleanup.js";
import { buildMagnet } from "../torrent.js";

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function findLargestVideo(files) {
  const videoExts = [".mp4", ".mkv", ".avi", ".webm", ".mov", ".ogv", ".ogg"];
  let best = null;
  for (const f of files) {
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (videoExts.includes(ext)) {
      if (!best || f.length > best.length) best = f;
    }
  }
  return best;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class StreamManager {
  constructor(torrentInfo) {
    this.torrentInfo = torrentInfo;
    this.client = null;
    this.wt = null;
    this.prioritizer = null;
    this.server = null;
    this.progress = null;
    this.cleanup = null;
    this.mpv = null;

    this.videoFile = null;
    this.startTime = Date.now();

    // Manual download tracking (WebTorrent's piece tracking crashes after null-piece bug)
    this._downloadedBytes = 0;
    this._downloadSpeed = 0;
    this._numPeers = 0;
  }

  async start() {
    const log = (msg) => console.log(chalk.gray(`  ${msg}`));

    try {
      // 1. Setup cleanup
      this.cleanup = new CleanupManager(log);
      this.cleanup.installHandlers();

      // 2. Create temp directory
      const tempDir = this.cleanup.createTempDir();
      log(`Temp: ${tempDir}`);

      // 3. Initialize WebTorrent
      this.client = await createSafeClient({ tempDest: tempDir });
      this.cleanup.onCleanup(() => this._destroyClient());

      const magnet = buildMagnet(this.torrentInfo);
      log("Adding torrent...");

      this.wt = await this._addTorrent(magnet);

      // 4. Wait for WebTorrent internal state to stabilize
      log("Initializing...");
      await sleep(5000);

      // 5. Select the video file
      const files = this.wt.files;
      log(`${files.length} file(s) in torrent`);

      this.videoFile = this._selectFile(files);
      if (!this.videoFile) {
        throw new Error("No video files found in torrent");
      }

      // Safely select the video file
      this._safeSelectFile();

      log(`Playing: ${chalk.green(this.videoFile.name)}`);
      log(`Size: ${fmtBytes(this.videoFile.length)}`);

      // Setup manual download tracking
      this._setupDownloadTracking();

      log(`Peers: ${this._numPeers}`);

      // 6. Create prioritizer
      this.prioritizer = new PiecePrioritizer(
        this.wt,
        this.wt.pieceLength,
        this.videoFile.length
      );

      // 7. Start HTTP server
      this.server = new StreamServer(
        this.videoFile,
        this.wt,
        this.prioritizer,
        log
      );
      await this.server.start();
      this.cleanup.onCleanup(() => this.server.stop());
      log(`Server: ${this.server.getUrl()}`);

      // 8. Start progress reporter
      this.progress = new ProgressReporter(this.videoFile, this.wt, this.prioritizer, this);
      this.progress.start(1000);
      this.cleanup.onCleanup(() => this.progress.stop());

      // 9. Launch MPV
      log("Launching MPV...");
      await this._launchMpv(this.server.getUrl());

      // 10. Done
      this.progress.printSummary();
      await this.cleanup.cleanup();

    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}`));
      if (this.cleanup) {
        await this.cleanup.cleanup();
      }
      throw err;
    }
  }

  /**
   * Setup manual download tracking that doesn't rely on WebTorrent's
   * corrupted piece array. Uses torrent 'download' event for speed
   * and periodic polling for total bytes.
   */
  _setupDownloadTracking() {
    // Track download stats using safe methods from createSafeTorrent
    const updateStats = () => {
      this._downloadedBytes = this.wt._safeDownloaded();
      this._downloadSpeed = this.wt._safeSpeed();
      this._numPeers = this.wt._safePeers();
    };

    this.wt.on("download", updateStats);
    this.wt.on("wire", updateStats);
    this.wt.on("wireDisconnected", updateStats);

    // Poll for updates
    setInterval(updateStats, 1000);

    // Initial values
    this._numPeers = this.wt._safePeers();
  }

  /**
   * Get current download stats (safe, works after piece corruption)
   */
  getDownloadStats() {
    return {
      downloaded: this._downloadedBytes,
      speed: this._downloadSpeed,
      peers: this._numPeers,
    };
  }

  _addTorrent(magnet) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for torrent metadata (30s)"));
      }, 30000);

      let torrent;
      try {
        torrent = this.client.add(magnet, { deselect: true });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      torrent.on("ready", () => {
        clearTimeout(timeout);
        // Wrap torrent to prevent null-piece crashes
        const safe = createSafeTorrent(torrent);
        resolve(safe);
      });

      torrent.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      torrent.on("warning", () => {});
    });
  }

  _safeSelectFile() {
    try {
      try { this.videoFile.select(); } catch {}
      for (const f of this.wt.files) {
        if (f !== this.videoFile) {
          try { f.deselect(); } catch {}
        }
      }
    } catch {}
  }

  _selectFile(files) {
    if (this.torrentInfo.fileIdx !== undefined &&
        this.torrentInfo.fileIdx >= 0 &&
        this.torrentInfo.fileIdx < files.length) {
      return files[this.torrentInfo.fileIdx];
    }
    return findLargestVideo(files);
  }

  _launchMpv(streamUrl) {
    return new Promise((resolve, reject) => {
      this.mpv = spawn("mpv", [
        "--no-terminal",
        "--force-seekable=yes",
        "--cache=yes",
        "--demuxer-max-bytes=75MiB",
        "--demuxer-readahead-secs=60",
        "--hr-seek=yes",
        "--cache-secs=60",
        "--keep-open=yes",
        "--keep-open-pause=no",
        streamUrl,
      ], {
        stdio: ["ignore", "inherit", "inherit"],
      });

      this.cleanup.onCleanup(() => {
        if (this.mpv && !this.mpv.killed) {
          this.mpv.kill("SIGTERM");
        }
      });

      this.mpv.on("close", (code) => resolve(code));
      this.mpv.on("error", (err) => {
        console.error(chalk.red(`  MPV error: ${err.message}`));
        reject(err);
      });
    });
  }

  async _destroyClient() {
    if (this.wt) {
      try { this.wt.destroy(); } catch {}
      this.wt = null;
    }
    if (this.client) {
      try { this.client.destroy(); } catch {}
      this.client = null;
    }
  }
}

export async function playWithMpv(torrentInfo) {
  const manager = new StreamManager(torrentInfo);
  await manager.start();
}
