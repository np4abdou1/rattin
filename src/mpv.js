import { spawn } from "child_process";
import chalk from "chalk";
import WebTorrent from "webtorrent";
import { buildMagnet } from "./torrent.js";

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://public.popcorn-tracker.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://exodus.desync.com:6969",
  "udp://open.demonii.com:1337/announce",
];

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
      console.log(chalk.gray(`  Peers: ${wt.numPeers}`));
      console.log();

      // Create a readable stream and pipe it to mpv via stdin
      const stream = videoFile.createReadStream();

      const mpv = spawn("mpv", [
        "--no-terminal",
        "--force-seekable=yes",
        "--cache=yes",
        "--demuxer-max-bytes=50MiB",
        "--demuxer-readahead-secs=30",
        "--hr-seek=yes",
        "-",
      ], {
        stdio: ["pipe", "inherit", "inherit"],
      });

      stream.pipe(mpv.stdin);
      mpv.stdin.on("error", () => {});

      // Progress reporter — use wt.progress (torrent-level, safe)
      let lastProgress = 0;
      const progressInterval = setInterval(() => {
        try {
          const pctNum = wt.progress || 0;
          if (pctNum !== lastProgress) {
            lastProgress = pctNum;
            const pct = (pctNum * 100).toFixed(1);
            const dl = fmtBytes(wt.downloadSpeed) + "/s";
            const peers = wt.numPeers;
            process.stdout.write(
              `\r${chalk.gray("  Downloading:")} ${chalk.cyan(pct + "%")} ${chalk.gray("|")} ${chalk.green(dl)} ${chalk.gray("|")} ${chalk.yellow(peers + " peers")}`
            );
          }
        } catch {}
      }, 1000);

      mpv.on("close", () => {
        clearInterval(progressInterval);
        process.stdout.write("\r" + " ".repeat(80) + "\r");
        console.log(chalk.gray("  MPV closed."));
        client.destroy();
        resolve();
      });

      mpv.on("error", (err) => {
        clearInterval(progressInterval);
        console.error(chalk.red(`  MPV error: ${err.message}`));
        client.destroy();
        reject(err);
      });

      stream.on("error", (err) => {
        clearInterval(progressInterval);
        console.error(chalk.red(`  Stream error: ${err.message}`));
        mpv.kill();
        client.destroy();
        reject(err);
      });
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
