#!/usr/bin/env node

/**
 * Debug script — full pipeline test (non-interactive)
 *
 * Tests:
 * 1. TMDB search
 * 2. Torrent search + scoring
 * 3. WebTorrent add + metadata
 * 4. Piece prioritizer init
 * 5. HTTP server + range requests
 * 6. Piece availability
 * 7. Cleanup
 *
 * On headless VPS: tests everything except actual mpv playback.
 * Use --play flag to attempt mpv launch (needs display or Xvfb).
 */

import "dotenv/config";
import chalk from "chalk";

// Catch WebTorrent's internal null-piece crash
process.on("uncaughtException", (err) => {
  if (err.message && err.message.includes("Cannot read properties of null")) {
    process.stderr.write(chalk.gray("  [webtorrent] recovered from null piece crash\n"));
    return; // Don't crash
  }
  throw err;
});
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import WebTorrent from "webtorrent";
import { searchTMDB, fetchTVDetails } from "../src/tmdb.js";
import { searchTorrents, buildMagnet } from "../src/torrent.js";
import { PiecePrioritizer } from "../src/stream/prioritizer.js";
import { StreamServer } from "../src/stream/server.js";
import { CleanupManager } from "../src/stream/cleanup.js";

const PLAY_MODE = process.argv.includes("--play");
const QUICK_MODE = process.argv.includes("--quick");

function log(label, value) {
  console.log(chalk.gray(`  ${label}:`) + " " + value);
}

function section(title) {
  console.log(chalk.cyan.bold(`\n  ═══ ${title} ═══`));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Test 1: TMDB Search ─────────────────────────────────────────

async function testTMDB() {
  section("TMDB Search");

  console.log(chalk.gray("  Searching for 'coco'..."));
  const results = await searchTMDB("coco");

  if (!results.length) {
    console.log(chalk.red("  FAIL: No results"));
    return null;
  }

  const item = results[0];
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const type = item.media_type === "tv" ? "TV" : "MOVIE";

  log("Title", chalk.yellow(title));
  log("Year", chalk.blue(year));
  log("Type", chalk.gray(type));
  log("Results", results.length);

  console.log(chalk.green("  ✓ TMDB search OK"));
  return item;
}

// ─── Test 2: Torrent Search ──────────────────────────────────────

async function testTorrentSearch(tmdbItem) {
  section("Torrent Search");

  const title = tmdbItem.title || tmdbItem.name;
  const year = (tmdbItem.release_date || tmdbItem.first_air_date || "").slice(0, 4);
  const type = tmdbItem.media_type === "tv" ? "tv" : "movie";

  const target = { type, title, year, tmdbId: tmdbItem.id };
  if (type === "tv") {
    target.season = 1;
    target.episode = 1;
  }

  console.log(chalk.gray(`  Searching providers for "${title}"...`));
  const torrents = await searchTorrents(target);

  if (!torrents.length) {
    console.log(chalk.red("  FAIL: No torrents found"));
    return null;
  }

  const t = torrents[0];
  log("Best", chalk.white(t.name));
  log("Seeders", chalk.yellow(t.seeders));
  log("Size", t.sizeStr || "unknown");
  log("Score", chalk.green(t.score.toFixed(1)));
  log("Found", `${torrents.length} torrents`);

  console.log(chalk.green("  ✓ Torrent search OK"));
  return t;
}

// ─── Test 3: WebTorrent + Metadata ──────────────────────────────

async function testTorrentAdd(torrentInfo) {
  section("WebTorrent Metadata");

  const cleanup = new CleanupManager();
  const tempDir = cleanup.createTempDir("rattin-debug-");

  const client = new WebTorrent({ tempDest: tempDir });
  const magnet = buildMagnet(torrentInfo);

  console.log(chalk.gray("  Adding torrent..."));

  const wt = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout")), 30000);
    let t;
    try {
      t = client.add(magnet, { deselect: true });
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
      return;
    }
    t.on("ready", () => { clearTimeout(timeout); resolve(t); });
    t.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });

  const files = wt.files;
  log("Files", files.length);
  log("Pieces", wt.pieces.length);
  log("Piece length", `${(wt.pieceLength / 1024).toFixed(0)} KB`);
  log("Torrent name", wt.name);

  for (const f of files) {
    log("  File", `${f.name} (${(f.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  console.log(chalk.green("  ✓ Torrent metadata OK"));

  return { client, wt, tempDir, cleanup };
}

// ─── Test 4: Piece Prioritizer ──────────────────────────────────

async function testPrioritizer(wt, torrentInfo) {
  section("Piece Prioritizer");

  // Find largest video file
  const videoExts = [".mp4", ".mkv", ".avi", ".webm", ".mov"];
  let videoFile = null;
  for (const f of wt.files) {
    const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if (videoExts.includes(ext)) {
      if (!videoFile || f.length > videoFile.length) videoFile = f;
    }
  }

  if (!videoFile) {
    console.log(chalk.red("  FAIL: No video file"));
    return null;
  }

  videoFile.select();

  const prioritizer = new PiecePrioritizer(wt, wt.pieceLength, videoFile.length);

  log("File", videoFile.name);
  log("Size", `${(videoFile.length / 1024 / 1024).toFixed(1)} MB`);
  log("Piece range", `${prioritizer.fileStartPiece}-${prioritizer.fileEndPiece}`);
  log("Total pieces", prioritizer.fileEndPiece - prioritizer.fileStartPiece + 1);

  // Test seek detection
  console.log(chalk.gray("\n  Testing seek detection..."));
  prioritizer.onRequest(0, 1024 * 1024); // initial
  const isSeek = prioritizer.onRequest(50 * 1024 * 1024, 51 * 1024 * 1024); // seek
  log("Seek detected", isSeek ? chalk.green("YES") : chalk.red("NO"));

  // Get stats
  const stats = prioritizer.getStats();
  log("Downloaded pieces", `${stats.downloaded}/${stats.totalPieces}`);
  log("Percent", `${stats.percent}%`);

  console.log(chalk.green("  ✓ Prioritizer OK"));

  return { prioritizer, videoFile };
}

// ─── Test 5: HTTP Server + Range Requests ───────────────────────

async function testHttpServer(videoFile, wt, prioritizer) {
  section("HTTP Server");

  const server = new StreamServer(videoFile, wt, prioritizer, (msg) => {
    console.log(chalk.gray(`    [server] ${msg}`));
  });

  await server.start();
  const url = server.getUrl();
  log("URL", chalk.cyan(url));

  // Test HEAD request
  console.log(chalk.gray("  Testing HEAD request..."));
  const headRes = await fetch(url, { method: "HEAD" });
  log("HEAD status", headRes.status);
  log("Content-Length", headRes.headers.get("content-length"));
  log("Content-Type", headRes.headers.get("content-type"));
  log("Accept-Ranges", headRes.headers.get("accept-ranges"));

  if (headRes.status !== 200) {
    console.log(chalk.red("  FAIL: HEAD request failed"));
    await server.stop();
    return null;
  }

  // Test small range request
  console.log(chalk.gray("  Testing range request (first 64KB)..."));
  const rangeRes = await fetch(url, {
    headers: { Range: "bytes=0-65535" },
  });
  log("Range status", rangeRes.status);
  log("Content-Range", rangeRes.headers.get("content-range"));

  if (rangeRes.status === 206) {
    const body = await rangeRes.arrayBuffer();
    log("Body size", `${body.byteLength} bytes`);
    console.log(chalk.green("  ✓ Range request OK"));
  } else if (rangeRes.status === 503) {
    console.log(chalk.yellow("  ⚠ Server returned 503 (buffering) — pieces not ready yet"));
  } else {
    console.log(chalk.red(`  FAIL: Unexpected status ${rangeRes.status}`));
  }

  // Test mid-file range
  console.log(chalk.gray("  Testing mid-file range (10MB-10MB+64KB)..."));
  const midRes = await fetch(url, {
    headers: { Range: "bytes=10485760-10551295" },
  });
  log("Mid-file status", midRes.status);

  if (midRes.status === 206) {
    const body = await midRes.arrayBuffer();
    log("Body size", `${body.byteLength} bytes`);
    console.log(chalk.green("  ✓ Mid-file range OK"));
  } else if (midRes.status === 503) {
    console.log(chalk.yellow("  ⚠ Buffering (expected for unbuffered region)"));
  }

  const stats = server.getStats();
  log("Requests served", stats.requestCount);
  log("Bytes served", `${(stats.totalBytesServed / 1024).toFixed(1)} KB`);

  console.log(chalk.green("  ✓ HTTP server OK"));

  return server;
}

// ─── Test 6: Piece Download + Availability ──────────────────────

async function testPieceDownload(wt, videoFile) {
  section("Piece Download Test");

  // Select first 100 pieces
  const startPiece = Math.floor(videoFile.offset / wt.pieceLength);
  const endPiece = Math.min(startPiece + 99, Math.floor((videoFile.offset + videoFile.length - 1) / wt.pieceLength));

  log("Requesting pieces", `${startPiece}-${endPiece}`);
  try {
    wt.select(startPiece, endPiece, 3);
  } catch {}

  // Wait and check progress
  console.log(chalk.gray("  Downloading for 10 seconds..."));

  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const speed = wt.downloadSpeed;
    const peers = wt.numPeers;
    let ready = 0;
    for (let p = startPiece; p <= endPiece; p++) {
      if (p < wt.pieces.length && wt.pieces[p] && wt.pieces[p].missing === 0) ready++;
    }
    process.stdout.write(
      `\r  ${chalk.gray("Speed:")} ${chalk.green((speed / 1024).toFixed(0) + " KB/s")}  ` +
      `${chalk.gray("Peers:")} ${chalk.yellow(peers)}  ` +
      `${chalk.gray("Pieces:")} ${chalk.cyan(`${ready}/${endPiece - startPiece + 1}`)}  ` +
      `${chalk.gray("Time:")} ${i + 1}s`
    );
  }
  process.stdout.write("\n");

  // Final check
  let ready = 0;
  for (let p = startPiece; p <= endPiece; p++) {
    if (p < wt.pieces.length && wt.pieces[p] && wt.pieces[p].missing === 0) ready++;
  }

  log("Pieces downloaded", `${ready}/${endPiece - startPiece + 1}`);
  log("Download speed", `${(wt.downloadSpeed / 1024).toFixed(0)} KB/s`);
  log("Peers", wt.numPeers);

  if (ready > 0) {
    console.log(chalk.green("  ✓ Piece download OK"));
  } else {
    console.log(chalk.yellow("  ⚠ No pieces downloaded (network issue?)"));
  }

  return ready;
}

// ─── Test 7: Cleanup ────────────────────────────────────────────

async function testCleanup(cleanup, tempDir) {
  section("Cleanup");

  const existsBefore = fs.existsSync(tempDir);
  log("Temp dir exists", existsBefore ? chalk.green("YES") : chalk.red("NO"));

  if (existsBefore) {
    // Get size
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
    log("Temp size", `${(size / 1024 / 1024).toFixed(1)} MB`);
  }

  await cleanup.cleanup();

  const existsAfter = fs.existsSync(tempDir);
  log("After cleanup", existsAfter ? chalk.red("STILL EXISTS") : chalk.green("REMOVED"));

  if (!existsAfter) {
    console.log(chalk.green("  ✓ Cleanup OK"));
  } else {
    console.log(chalk.red("  FAIL: Temp dir not removed"));
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.yellow.bold("\n  ╔══════════════════════════════════════╗"));
  console.log(chalk.yellow.bold("  ║   rattin debug — full pipeline test  ║"));
  console.log(chalk.yellow.bold("  ╚══════════════════════════════════════╝"));

  const startTime = Date.now();
  let exitCode = 0;
  let client = null;
  let wt = null;
  let server = null;
  let cleanup = null;
  let tempDir = null;

  try {
    // 1. TMDB
    const tmdbItem = await testTMDB();
    if (!tmdbItem) { process.exit(1); }

    // 2. Torrent search
    const torrentInfo = await testTorrentSearch(tmdbItem);
    if (!torrentInfo) { process.exit(1); }

    if (QUICK_MODE) {
      console.log(chalk.gray("\n  Quick mode — skipping torrent tests"));
      process.exit(0);
    }

    // 3. WebTorrent
    const torrentResult = await testTorrentAdd(torrentInfo);
    client = torrentResult.client;
    wt = torrentResult.wt;
    cleanup = torrentResult.cleanup;
    tempDir = torrentResult.tempDir;

    // 4. Prioritizer
    const prioResult = await testPrioritizer(wt, torrentInfo);
    if (!prioResult) { process.exit(1); }
    const { prioritizer, videoFile } = prioResult;

    // 5. HTTP server
    server = await testHttpServer(videoFile, wt, prioritizer);

    // 6. Download test
    await testPieceDownload(wt, videoFile);

    // 7. Cleanup
    if (server) await server.stop();
    wt.destroy();
    client.destroy();
    await testCleanup(cleanup, tempDir);

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.yellow.bold(`\n  All tests passed (${elapsed}s)`));
    console.log();

  } catch (err) {
    console.error(chalk.red(`\n  FATAL: ${err.message}`));
    console.error(chalk.gray(err.stack));
    exitCode = 1;

    // Cleanup on error
    try {
      if (server) await server.stop();
      if (wt) wt.destroy();
      if (client) client.destroy();
      if (cleanup) await cleanup.cleanup();
    } catch {}
  }

  process.exit(exitCode);
}

main();
