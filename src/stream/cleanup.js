/**
 * Cleanup Manager
 *
 * Manages temporary directories and ensures cleanup on exit.
 * Handles SIGINT, SIGTERM, uncaught exceptions, and normal exit.
 * Everything streams to temp — nothing persists on disk.
 */

import os from "os";
import path from "path";
import fs from "fs";

export class CleanupManager {
  constructor(log) {
    this.log = log || (() => {});
    this.tempDir = null;
    this.cleanupCallbacks = [];
    this.isCleaningUp = false;
    this.originalHandlers = {};

    // Bind signal handlers
    this._onSignal = this._onSignal.bind(this);
    this._onExit = this._onExit.bind(this);
    this._onUncaught = this._onUncaught.bind(this);
  }

  /**
   * Create a temporary directory for this session
   */
  createTempDir(prefix = "rattin-") {
    const base = os.tmpdir();
    const name = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.tempDir = path.join(base, name);

    fs.mkdirSync(this.tempDir, { recursive: true });
    this.log(`Temp dir: ${this.tempDir}`);

    return this.tempDir;
  }

  /**
   * Get the temp directory path
   */
  getTempDir() {
    if (!this.tempDir) this.createTempDir();
    return this.tempDir;
  }

  /**
   * Register a cleanup callback
   */
  onCleanup(callback) {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Install signal handlers for cleanup
   */
  installHandlers() {
    // Save original handlers
    this.originalHandlers.SIGINT = process.listeners("SIGINT");
    this.originalHandlers.SIGTERM = process.listeners("SIGTERM");

    process.on("SIGINT", this._onSignal);
    process.on("SIGTERM", this._onSignal);
    process.on("exit", this._onExit);

    // Catch uncaught exceptions for cleanup
    process.on("uncaughtException", (err) => {
      this._onUncaught(err);
    });
  }

  /**
   * Remove signal handlers
   */
  removeHandlers() {
    process.removeListener("SIGINT", this._onSignal);
    process.removeListener("SIGTERM", this._onSignal);
    process.removeListener("exit", this._onExit);
  }

  /**
   * Run all cleanup callbacks
   */
  async cleanup() {
    if (this.isCleaningUp) return;
    this.isCleaningUp = true;

    this.log("Cleaning up...");

    // Run cleanup callbacks in reverse order
    for (const cb of this.cleanupCallbacks.reverse()) {
      try {
        await cb();
      } catch (err) {
        this.log(`Cleanup error: ${err.message}`);
      }
    }

    // Remove temp directory
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        this.log(`Removed temp dir: ${this.tempDir}`);
      } catch (err) {
        this.log(`Failed to remove temp dir: ${err.message}`);
      }
    }

    this.log("Cleanup complete");
  }

  /**
   * Handle signals
   */
  async _onSignal(signal) {
    console.log(`\n  Received ${signal}, cleaning up...`);
    await this.cleanup();
    process.exit(0);
  }

  /**
   * Handle process exit
   */
  _onExit(code) {
    // Synchronous cleanup only (can't do async in exit handler)
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Handle uncaught exceptions
   */
  async _onUncaught(err) {
    console.error(`\n  Uncaught error: ${err.message}`);
    await this.cleanup();
    process.exit(1);
  }

  /**
   * Get temp directory size
   */
  getTempSize() {
    if (!this.tempDir || !fs.existsSync(this.tempDir)) return 0;

    let size = 0;
    const walk = (dir) => {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const f of files) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) {
          walk(p);
        } else {
          size += fs.statSync(p).size;
        }
      }
    };
    walk(this.tempDir);
    return size;
  }
}

/**
 * Format bytes to human readable
 */
function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
