#!/usr/bin/env node

/**
 * rattin debug — comprehensive pipeline test with ffmpeg
 *
 * Tests every component of the streaming pipeline:
 * 1. TMDB search
 * 2. Torrent search + scoring
 * 3. WebTorrent add + metadata + piece download
 * 4. Piece prioritizer
 * 5. HTTP server + range requests
 * 6. ffmpeg probe of streamed data (validates video is playable)
 * 7. Cleanup
 *
 * Flags:
 *   --quick     Skip torrent/streaming tests
 *   --probe     Test ffmpeg probe on streamed data
 *   --full      Full streaming test with ffmpeg decode
 */

import "dotenv/config";
import chalk from "chalk";

// Catch WebTorrent's internal null-piece crash
let _wtCrashes = 0;
process.on("uncaughtException", (err) => {
  if (err.message && err.message.includes("Cannot read properties of null")) {
    _wtCrashes++;
    if (_wtCrashes <= 3) {
      process.stderr.write(chalk.gray(`  [webtorrent] recovered (#${_wtCrashes})\n`));
    }
    return;
  }
});
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawn } from "child_process";
import WebTorrent from "webtorrent";
import { searchTMDB, fetchTVDetails } from "../src/tmdb.js";
import { searchTorrents, buildMagnet } from "../src/torrent.js";
import { createSafeClient, createSafeTorrent } from "../src/stream/safe-torrent.js";
import { PiecePrioritizer, isPieceReady } from "../src/stream/prioritizer.js";
import { StreamServer } from "../src/stream/server.js";
import { CleanupManager } from "../src/stream/cleanup.js";

// ── Flags ──────────────────────────────────────────────────────────
const QUICK = process.argv.includes("--quick");
const PROBE = process.argv.includes("--probe") || process.argv.includes("--full");
const FULL = process.argv.includes("--full");

// ── Helpers ────────────────────────────────────────────────────────
function log(label, value) {
  console.log(chalk.gray(`  ${label}:`) + " " + value);
}

function section(title) {
  console.log(chalk.cyan.bold(`\n  ═══ ${title} ═══`));
}

function pass(msg) { console.log(chalk.green(`  ✓ ${msg}`)); }
function fail(msg) { console.log(chalk.red(`  ✗ ${msg}`)); }
function warn(msg) { console.log(chalk.yellow(`  ⚠ ${msg}`)); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function hasFfmpeg() {
  try { execSync("ffmpeg -version 2>&1", { stdio: "ignore" }); return true; }
  catch { return false; }
}

function hasFfprobe() {
  try { execSync("ffprobe -version 2>&1", { stdio: "ignore" }); return true; }
  catch { return false; }
}

// ── Test Results ───────────────────────────────────────────────────
const results = [];
function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
}

// ═══ Test 1: TMDB Search ══════════════════════════════════════════

async function testTMDB() {
  section("TMDB Search");

  console.log(chalk.gray("  Searching for 'coco'..."));
  const results = await searchTMDB("coco");

  if (!results.length) { fail("No results"); record("TMDB", false); return null; }

  const item = results[0];
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const type = item.media_type === "tv" ? "TV" : "MOVIE";

  log("Title", chalk.yellow(title));
  log("Year", chalk.blue(year));
  log("Type", chalk.gray(type));
  log("Results", results.length);

  pass("TMDB search OK");
  record("TMDB", true, `${title} (${year})`);
  return item;
}

// ═══ Test 2: Torrent Search ═══════════════════════════════════════

async function testTorrentSearch(tmdbItem) {
  section("Torrent Search");

  const title = tmdbItem.title || tmdbItem.name;
  const year = (tmdbItem.release_date || tmdbItem.first_air_date || "").slice(0, 4);

  const target = { type: "movie", title, year, tmdbId: tmdbItem.id };

  console.log(chalk.gray(`  Searching providers for "${title}"...`));
  const torrents = await searchTorrents(target);

  if (!torrents.length) { fail("No torrents found"); record("TorrentSearch", false); return null; }

  const t = torrents[0];
  log("Best", chalk.white(t.name));
  log("Seeders", chalk.yellow(t.seeders));
  log("Size", t.sizeStr || fmtBytes(t.size));
  log("Score", chalk.green(t.score.toFixed(1)));
  log("Found", `${torrents.length} torrents`);

  pass("Torrent search OK");
  record("TorrentSearch", true, `${torrents.length} results, best: ${t.seeders} seeders`);
  return t;
}

// ═══ Test 3: WebTorrent ═══════════════════════════════════════════

async function testWebTorrent(torrentInfo) {
  section("WebTorrent Metadata");

  const tempDir = path.join(os.tmpdir(), `rattin-debug-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const client = await createSafeClient({ tempDest: tempDir });
  const magnet = buildMagnet(torrentInfo);

  console.log(chalk.gray("  Adding torrent..."));

  const wt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout (30s)")), 30000);
    let t;
    try {
      t = client.add(magnet, { deselect: true });
    } catch (err) { clearTimeout(timeout); reject(err); return; }
    t.on("ready", () => { clearTimeout(timeout); resolve(createSafeTorrent(t)); });
    t.on("error", (err) => { clearTimeout(timeout); reject(err); });
    t.on("warning", () => {});
  });

  const files = wt.files;
  log("Files", files.length);
  log("Pieces", wt.pieces.length);
  log("Piece length", `${(wt.pieceLength / 1024).toFixed(0)} KB`);
  log("Torrent name", wt.name);

  for (const f of files) {
    log("  File", `${f.name} (${fmtBytes(f.length)})`);
  }

  pass("Torrent metadata OK");
  record("WebTorrent", true, `${files.length} files, ${wt.pieces.length} pieces`);

  return { client, wt, tempDir };
}

// ═══ Test 4: Piece Download ═══════════════════════════════════════

async function testPieceDownload(wt) {
  section("Piece Download (15s test)");

  // Find largest video file
  const videoExts = [".mp4", ".mkv", ".avi", ".webm", ".mov"];
  let videoFile = null;
  for (const f of wt.files) {
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (videoExts.includes(ext)) {
      if (!videoFile || f.length > videoFile.length) videoFile = f;
    }
  }

  if (!videoFile) { fail("No video file"); record("PieceDownload", false); return null; }

  // Select the video file
  try { videoFile.select(); } catch {}
  for (const f of wt.files) {
    if (f !== videoFile) try { f.deselect(); } catch {}
  }

  log("File", videoFile.name);
  log("Size", fmtBytes(videoFile.length));

  // Wait for data — track using events (safe after piece corruption)
  console.log(chalk.gray("  Downloading for 15 seconds..."));

  let totalDownloaded = 0;
  let currentSpeed = 0;
  let currentPeers = 0;

  wt.on("download", () => {
    try { currentSpeed = wt.downloadSpeed; } catch {}
    try { currentPeers = wt.numPeers; } catch {}
  });
  wt.on("wire", () => { try { currentPeers = wt.numPeers; } catch {} });
  wt.on("wireDisconnected", () => { try { currentPeers = wt.numPeers; } catch {} });

  // Poll total downloaded (try wt.downloaded, fall back to 0)
  const dlTracker = setInterval(() => {
    try {
      const dl = wt.downloaded;
      if (dl > totalDownloaded) totalDownloaded = dl;
    } catch {}
  }, 500);

  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const filePct = (totalDownloaded / videoFile.length * 100).toFixed(1);
    const speedStr = currentSpeed > 0 ? fmtBytes(currentSpeed) + "/s" : "connecting...";

    process.stdout.write(
      `\r  ${chalk.gray("Speed:")} ${chalk.green(speedStr.padEnd(12))}  ` +
      `${chalk.gray("Peers:")} ${chalk.yellow(String(currentPeers).padEnd(4))}  ` +
      `${chalk.gray("Downloaded:")} ${chalk.cyan(`${filePct}%`.padEnd(8))}  ` +
      `${chalk.gray("Time:")} ${(i + 1)}s`
    );
  }
  clearInterval(dlTracker);
  process.stdout.write("\n");

  // Final stats
  // One last try to get accurate total
  try { const dl = wt.downloaded; if (dl > totalDownloaded) totalDownloaded = dl; } catch {}
  const filePct = (totalDownloaded / videoFile.length * 100).toFixed(1);
  log("Downloaded", `${fmtBytes(totalDownloaded)} (${filePct}%)`);
  log("Speed", fmtBytes(currentSpeed) + "/s");
  log("Peers", currentPeers);

  if (totalDownloaded > 0) {
    pass(`Download OK — ${fmtBytes(totalDownloaded)} (${filePct}%)`);
    record("PieceDownload", true, `${filePct}%`);
  } else {
    warn("No data downloaded (network issue on VPS?)");
    record("PieceDownload", false, "0 bytes — network?");
  }

  return videoFile;
}

// ═══ Test 5: HTTP Server ══════════════════════════════════════════

async function testHttpServer(videoFile, wt) {
  section("HTTP Server + Range Requests");

  const prioritizer = new PiecePrioritizer(wt, wt.pieceLength, videoFile.length);

  const server = new StreamServer(videoFile, wt, prioritizer, (msg) => {
    console.log(chalk.gray(`    [server] ${msg}`));
  });

  await server.start();
  const url = server.getUrl();
  log("URL", chalk.cyan(url));

  // Test HEAD
  console.log(chalk.gray("  Testing HEAD..."));
  const headRes = await fetch(url, { method: "HEAD" });
  log("Status", headRes.status);
  log("Content-Length", fmtBytes(Number(headRes.headers.get("content-length"))));
  log("Accept-Ranges", headRes.headers.get("accept-ranges"));

  if (headRes.status === 200) {
    pass("HEAD request OK");
    record("HTTP_HEAD", true);
  } else {
    fail(`HEAD returned ${headRes.status}`);
    record("HTTP_HEAD", false);
  }

  // Test range request
  console.log(chalk.gray("  Testing range (first 64KB)..."));
  const rangeRes = await fetch(url, { headers: { Range: "bytes=0-65535" } });
  log("Status", rangeRes.status);

  if (rangeRes.status === 206) {
    const body = await rangeRes.arrayBuffer();
    log("Body", fmtBytes(body.byteLength));
    pass("Range request OK (206)");
    record("HTTP_Range", true);
  } else if (rangeRes.status === 503) {
    warn("503 — pieces not ready (expected on slow network)");
    record("HTTP_Range", false, "503 buffering");
  } else {
    fail(`Unexpected status ${rangeRes.status}`);
    record("HTTP_Range", false);
  }

  await server.stop();
  return server;
}

// ═══ Test 6: ffmpeg Probe ═════════════════════════════════════════

async function testFfmpegProbe(videoFile, wt, tempDir) {
  section("ffmpeg Probe");

  if (!hasFfprobe()) {
    warn("ffprobe not installed — skipping");
    record("ffmpeg", false, "ffprobe not found");
    return;
  }

  if (!hasFfmpeg()) {
    warn("ffmpeg not installed — skipping");
    record("ffmpeg", false, "ffmpeg not found");
    return;
  }

  // Wait for some data to be available
  console.log(chalk.gray("  Waiting for data..."));
  for (let i = 0; i < 10; i++) {
    try {
      const dl = wt.downloaded || 0;
      if (dl > 1024 * 1024) break;
    } catch {}
    await sleep(1000);
  }
  try { log("Data available", fmtBytes(wt.downloaded)); } catch { log("Data available", "unknown"); }

  // Create prioritizer and server
  const prioritizer = new PiecePrioritizer(wt, wt.pieceLength, videoFile.length);
  const server = new StreamServer(videoFile, wt, prioritizer, () => {});
  await server.start();
  const url = server.getUrl();

  log("Probing", url);

  try {
    // ffprobe the stream
    const probeOut = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${url}" 2>&1`,
      { timeout: 15000, encoding: "utf-8" }
    );

    const probe = JSON.parse(probeOut);

    if (probe.streams?.length > 0) {
      const videoStream = probe.streams.find((s) => s.codec_type === "video");
      const audioStream = probe.streams.find((s) => s.codec_type === "audio");

      if (videoStream) {
        log("Video", `${videoStream.codec_name} ${videoStream.width}x${videoStream.height}`);
        pass("Video stream detected");
      }
      if (audioStream) {
        log("Audio", `${audioStream.codec_name} ${audioStream.sample_rate}Hz`);
        pass("Audio stream detected");
      }

      log("Duration", probe.format?.duration ? `${Number(probe.format.duration).toFixed(1)}s` : "unknown");
      log("Streams", probe.streams.length);

      record("ffmpeg_probe", true, `${probe.streams.length} streams`);
    } else {
      fail("No streams found in probe");
      record("ffmpeg_probe", false);
    }
  } catch (err) {
    // ffprobe might fail if not enough data is buffered
    warn(`ffprobe failed: ${err.message.split("\n")[0]}`);
    record("ffmpeg_probe", false, err.message.split("\n")[0]);
  }

  await server.stop();
}

// ═══ Test 7: ffmpeg Decode Test ═══════════════════════════════════

async function testFfmpegDecode(videoFile, wt, tempDir) {
  section("ffmpeg Decode Test");

  if (!hasFfmpeg()) {
    warn("ffmpeg not installed — skipping");
    record("ffmpeg_decode", false, "ffmpeg not found");
    return;
  }

  const prioritizer = new PiecePrioritizer(wt, wt.pieceLength, videoFile.length);
  const server = new StreamServer(videoFile, wt, prioritizer, () => {});
  await server.start();
  const url = server.getUrl();

  const outFile = path.join(tempDir, "test-output.mp4");
  log("Decoding 10 seconds to", outFile);

  try {
    // Decode first 10 seconds to a local file
    execSync(
      `ffmpeg -y -i "${url}" -t 10 -c copy "${outFile}" 2>&1`,
      { timeout: 30000, stdio: "pipe" }
    );

    if (fs.existsSync(outFile)) {
      const stat = fs.statSync(outFile);
      log("Output size", fmtBytes(stat.size));

      if (stat.size > 0) {
        pass(`Decode OK — ${fmtBytes(stat.size)} in 10s`);
        record("ffmpeg_decode", true, fmtBytes(stat.size));

        // Verify the output is valid
        try {
          const verify = execSync(
            `ffprobe -v quiet -print_format json -show_format "${outFile}"`,
            { encoding: "utf-8" }
          );
          const info = JSON.parse(verify);
          log("Verified", `${info.format?.format_name} ${info.format?.duration}s`);
        } catch {}
      } else {
        fail("Output file is empty");
        record("ffmpeg_decode", false, "empty output");
      }
    } else {
      fail("Output file not created");
      record("ffmpeg_decode", false, "no output file");
    }
  } catch (err) {
    warn(`Decode failed: ${err.message.split("\n")[0]}`);
    record("ffmpeg_decode", false, err.message.split("\n")[0]);
  }

  await server.stop();
}

// ═══ Test 8: Cleanup ══════════════════════════════════════════════

async function testCleanup(client, wt, tempDir) {
  section("Cleanup");

  const existsBefore = fs.existsSync(tempDir);
  log("Temp dir exists", existsBefore ? chalk.green("YES") : chalk.red("NO"));

  if (existsBefore) {
    let size = 0;
    const walk = (dir) => {
      try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const f of files) {
          const p = path.join(dir, f.name);
          if (f.isDirectory()) walk(p);
          else size += fs.statSync(p).size;
        }
      } catch {}
    };
    walk(tempDir);
    log("Temp size", fmtBytes(size));
  }

  // Destroy WebTorrent
  try { wt.destroy(); } catch {}
  try { client.destroy(); } catch {}

  // Remove temp dir
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

  const existsAfter = fs.existsSync(tempDir);
  if (!existsAfter) {
    pass("Cleanup OK");
    record("Cleanup", true);
  } else {
    fail("Temp dir not removed");
    record("Cleanup", false);
  }
}

// ═══ Main ══════════════════════════════════════════════════════════

async function main() {
  console.log(chalk.yellow.bold("\n  ╔══════════════════════════════════════╗"));
  console.log(chalk.yellow.bold("  ║   rattin debug — full pipeline test  ║"));
  console.log(chalk.yellow.bold("  ╚══════════════════════════════════════╝"));

  const startTime = Date.now();
  let client = null;
  let wt = null;
  let tempDir = null;
  let videoFile = null;

  try {
    // 1. TMDB
    const tmdbItem = await testTMDB();
    if (!tmdbItem) process.exit(1);

    // 2. Torrent search
    const torrentInfo = await testTorrentSearch(tmdbItem);
    if (!torrentInfo) process.exit(1);

    if (QUICK) {
      console.log(chalk.gray("\n  Quick mode — done"));
      printSummary();
      process.exit(0);
    }

    // 3. WebTorrent
    const torrentResult = await testWebTorrent(torrentInfo);
    client = torrentResult.client;
    wt = torrentResult.wt;
    tempDir = torrentResult.tempDir;

    // 4. Piece download
    videoFile = await testPieceDownload(wt);

    // 5. HTTP server
    if (videoFile) {
      await testHttpServer(videoFile, wt);
    }

    // 6. ffmpeg probe
    if (PROBE && videoFile) {
      await testFfmpegProbe(videoFile, wt, tempDir);
    }

    // 7. ffmpeg decode
    if (FULL && videoFile) {
      await testFfmpegDecode(videoFile, wt, tempDir);
    }

    // 8. Cleanup
    await testCleanup(client, wt, tempDir);
    client = null;
    wt = null;

  } catch (err) {
    console.error(chalk.red(`\n  FATAL: ${err.message}`));
    console.error(chalk.gray(err.stack?.split("\n").slice(1, 3).join("\n")));

    // Cleanup on error
    try { if (wt) wt.destroy(); } catch {}
    try { if (client) client.destroy(); } catch {}
    try { if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

    printSummary();
    process.exit(1);
  }

  printSummary();
}

function printSummary() {
  const elapsed = ((Date.now() - (globalThis.__startTime || Date.now())) / 1000).toFixed(1);

  console.log(chalk.yellow.bold("\n  ═══ Results ═══"));
  for (const r of results) {
    const icon = r.passed ? chalk.green("✓") : chalk.red("✗");
    const detail = r.detail ? chalk.gray(` (${r.detail})`) : "";
    console.log(`  ${icon} ${r.name}${detail}`);
  }
  console.log(chalk.gray(`\n  Time: ${elapsed}s`));
  console.log();
}

globalThis.__startTime = Date.now();
main();
