/**
 * Stream Manager
 *
 * Orchestrates the entire streaming pipeline:
 *   Torrent → Temp Dir → Piece Prioritizer → HTTP Server → MPV
 *
 * Features:
 *   - Adaptive piece prioritization (seek detection, prefetch)
 *   - HTTP range request server for mpv
 *   - Temp directory with automatic cleanup
 *   - Real-time progress reporting
 *   - Graceful shutdown on SIGINT/SIGTERM
 */

import { spawn } from "child_process";
import chalk from "chalk";
import WebTorrent from "webtorrent";
import { PiecePrioritizer } from "./prioritizer.js";
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
  }

  /**
   * Start the full streaming pipeline
   */
  async start() {
    const log = (msg) => console.log(chalk.gray(`  ${msg}`));

    try {
      // 1. Setup cleanup
      this.cleanup = new CleanupManager(log);
      this.cleanup.installHandlers();

      // 2. Create temp directory
      const tempDir = this.cleanup.createTempDir();
      log(`Temp: ${tempDir}`);

      // 3. Initialize WebTorrent (downloads to temp dir)
      this.client = new WebTorrent({ tempDest: tempDir });
      this.cleanup.onCleanup(() => this._destroyClient());

      const magnet = buildMagnet(this.torrentInfo);
      log("Adding torrent...");

      this.wt = await this._addTorrent(magnet);

      // 4. Select the video file
      const files = this.wt.files;
      log(`${files.length} file(s) in torrent`);

      this.videoFile = this._selectFile(files);
      if (!this.videoFile) {
        throw new Error("No video files found in torrent");
      }

      // Select only this file, deselect others
      for (const f of files) {
        if (f === this.videoFile) f.select();
        else f.deselect();
      }

      log(`Playing: ${chalk.green(this.videoFile.name)}`);
      log(`Size: ${fmtBytes(this.videoFile.length)}`);
      log(`Peers: ${this.wt.numPeers}`);

      // 5. Wait for initial pieces
      log("Waiting for initial pieces...");
      await this._waitForInitialPieces(4, 30000);
      log(`Pieces ready: ${this._countReadyPieces()}`);

      // 6. Create piece prioritizer
      this.prioritizer = new PiecePrioritizer(
        this.wt,
        this.wt.pieceLength,
        this.videoFile.length
      );
      log("Piece prioritizer initialized");

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
      this.progress = new ProgressReporter(this.videoFile, this.wt, this.prioritizer);
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
   * Add a magnet to WebTorrent and wait for metadata
   */
  _addTorrent(magnet) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for torrent metadata (30s)"));
      }, 30000);

      let torrent;
      try {
        torrent = this.client.add(magnet, {
          deselect: true,
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }

      torrent.on("ready", () => {
        clearTimeout(timeout);
        resolve(torrent);
      });

      torrent.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Wait for initial pieces before starting server
   */
  _waitForInitialPieces(minPieces, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const fileStart = Math.floor(this.videoFile.offset / this.wt.pieceLength);
      const fileEnd = Math.floor((this.videoFile.offset + this.videoFile.length - 1) / this.wt.pieceLength);

      // Prioritize the beginning of the file
      try {
        this.wt.select(fileStart, fileStart + 50, 3);
      } catch {}

      const check = () => {
        if (Date.now() > deadline) {
          resolve();
          return;
        }

        let ready = 0;
        for (let i = fileStart; i <= Math.min(fileStart + 100, fileEnd); i++) {
          const piece = this.wt.pieces[i];
          if (piece && piece.missing === 0) ready++;
        }

        if (ready >= minPieces) {
          resolve();
        } else {
          setTimeout(check, 200);
        }
      };

      check();
    });
  }

  /**
   * Count ready pieces for the video file
   */
  _countReadyPieces() {
    const start = Math.floor(this.videoFile.offset / this.wt.pieceLength);
    const end = Math.floor((this.videoFile.offset + this.videoFile.length - 1) / this.wt.pieceLength);
    let ready = 0;
    for (let i = start; i <= end; i++) {
      const piece = this.wt.pieces[i];
      if (piece && piece.missing === 0) ready++;
    }
    return `${ready}/${end - start + 1}`;
  }

  /**
   * Select the best video file from torrent
   */
  _selectFile(files) {
    if (this.torrentInfo.fileIdx !== undefined &&
        this.torrentInfo.fileIdx >= 0 &&
        this.torrentInfo.fileIdx < files.length) {
      return files[this.torrentInfo.fileIdx];
    }
    return findLargestVideo(files);
  }

  /**
   * Launch mpv with the stream URL
   */
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

      this.mpv.on("close", (code) => {
        resolve(code);
      });

      this.mpv.on("error", (err) => {
        console.error(chalk.red(`  MPV error: ${err.message}`));
        reject(err);
      });
    });
  }

  /**
   * Destroy the WebTorrent client
   */
  async _destroyClient() {
    if (this.wt) {
      try {
        this.wt.destroy();
      } catch {}
      this.wt = null;
    }
    if (this.client) {
      try {
        this.client.destroy();
      } catch {}
      this.client = null;
    }
  }
}

/**
 * Convenience function — stream a torrent and play with mpv
 */
export async function playWithMpv(torrentInfo) {
  const manager = new StreamManager(torrentInfo);
  await manager.start();
}
