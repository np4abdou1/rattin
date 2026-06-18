import { spawn } from "child_process";
import http from "http";
import chalk from "chalk";
import WebTorrent from "webtorrent";
import { buildMagnet } from "./torrent.js";

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

function waitForPieces(wt, videoFile, minPieces = 4, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      if (Date.now() > deadline) {
        // Start anyway with whatever we have
        resolve();
        return;
      }
      // Count how many pieces of this file are downloaded
      try {
        const startPiece = Math.floor(videoFile.offset / wt.pieceLength);
        const endPiece = Math.floor((videoFile.offset + videoFile.length - 1) / wt.pieceLength);
        let ready = 0;
        for (let i = startPiece; i <= endPiece; i++) {
          if (wt.pieces[i] && wt.pieces[i].missing === 0) ready++;
        }
        if (ready >= minPieces) {
          resolve();
          return;
        }
      } catch {}
      setTimeout(check, 500);
    }

    check();
  });
}

export function playWithMpv(torrent) {
  return new Promise((resolve, reject) => {
    const client = new WebTorrent();
    const magnet = buildMagnet(torrent);

    console.log(chalk.gray("  Adding torrent..."));

    const wt = client.add(magnet, { deselect: true });

    const timeout = setTimeout(() => {
      console.log(chalk.red("  Timed out waiting for torrent metadata."));
      client.destroy();
      reject(new Error("Timeout"));
    }, 30000);

    wt.on("ready", () => {
      clearTimeout(timeout);

      const files = wt.files;
      console.log(chalk.gray(`  ${files.length} file(s) in torrent`));

      let videoFile;
      if (torrent.fileIdx !== undefined && torrent.fileIdx >= 0 && torrent.fileIdx < files.length) {
        videoFile = files[torrent.fileIdx];
      } else {
        videoFile = findLargestVideo(files);
      }

      if (!videoFile) {
        console.log(chalk.red("  No video files found in torrent."));
        client.destroy();
        reject(new Error("No video file"));
        return;
      }

      // Select only this file
      for (const f of files) {
        if (f === videoFile) f.select();
        else f.deselect();
      }

      console.log(chalk.green(`  Playing: ${videoFile.name}`));
      console.log(chalk.gray(`  Size: ${fmtBytes(videoFile.length)}`));
      console.log(chalk.gray(`  Waiting for pieces...`));

      // Wait for a few pieces before serving (prevents WebTorrent null crash)
      waitForPieces(wt, videoFile, 4, 20000).then(() => {
        startServer();
      });

      function startServer() {
        console.log(chalk.gray(`  Peers: ${wt.numPeers}`));

        const server = http.createServer((req, res) => {
          // Guard: check pieces exist before serving
          try {
            const startPiece = Math.floor(videoFile.offset / wt.pieceLength);
            const endPiece = Math.floor((videoFile.offset + videoFile.length - 1) / wt.pieceLength);
            for (let i = startPiece; i <= endPiece; i++) {
              if (!wt.pieces[i]) {
                res.writeHead(503);
                res.end("Buffering...");
                return;
              }
            }
          } catch {}

          const range = req.headers.range;
          const fileSize = videoFile.length;

          if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${fileSize}`,
              "Accept-Ranges": "bytes",
              "Content-Length": end - start + 1,
              "Content-Type": "video/x-matroska",
            });

            const stream = videoFile.createReadStream({ start, end });
            stream.pipe(res);
            stream.on("error", () => { try { res.destroy(); } catch {} });
            res.on("close", () => { try { stream.destroy(); } catch {} });
          } else {
            res.writeHead(200, {
              "Content-Length": fileSize,
              "Content-Type": "video/x-matroska",
              "Accept-Ranges": "bytes",
            });

            const stream = videoFile.createReadStream();
            stream.pipe(res);
            stream.on("error", () => { try { res.destroy(); } catch {} });
            res.on("close", () => { try { stream.destroy(); } catch {} });
          }
        });

        server.listen(0, "127.0.0.1", () => {
          const port = server.address().port;
          const streamUrl = `http://127.0.0.1:${port}/`;

          console.log(chalk.gray(`  HTTP server on port ${port}`));
          console.log(chalk.gray("  Launching MPV..."));

          const mpv = spawn("mpv", [
            "--no-terminal",
            "--force-seekable=yes",
            "--cache=yes",
            "--demuxer-max-bytes=75MiB",
            "--demuxer-readahead-secs=60",
            "--hr-seek=yes",
            "--cache-secs=60",
            streamUrl,
          ], {
            stdio: ["ignore", "inherit", "inherit"],
          });

          // Progress — track downloaded bytes of the selected file
          let lastDl = 0;
          const progressInterval = setInterval(() => {
            try {
              const dl = videoFile.downloaded || 0;
              const total = videoFile.length || 1;
              const pct = ((dl / total) * 100).toFixed(1);
              const speed = fmtBytes(wt.downloadSpeed) + "/s";
              const peers = wt.numPeers;
              if (dl !== lastDl) {
                lastDl = dl;
                process.stdout.write(
                  `\r${chalk.gray("  Downloading:")} ${chalk.cyan(pct + "%")} ${chalk.gray("|")} ${chalk.green(speed)} ${chalk.gray("|")} ${chalk.yellow(peers + " peers")}`
                );
              }
            } catch {}
          }, 1000);

          mpv.on("close", () => {
            clearInterval(progressInterval);
            process.stdout.write("\r" + " ".repeat(80) + "\r");
            console.log(chalk.gray("  MPV closed."));
            server.close();
            client.destroy();
            resolve();
          });

          mpv.on("error", (err) => {
            clearInterval(progressInterval);
            console.error(chalk.red(`  MPV error: ${err.message}`));
            server.close();
            client.destroy();
            reject(err);
          });
        });
      }
    });

    wt.on("error", (err) => {
      clearTimeout(timeout);
      console.error(chalk.red(`  Torrent error: ${err.message}`));
      client.destroy();
      reject(err);
    });

    wt.on("warning", () => {});
  });
}
