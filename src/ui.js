import chalk from "chalk";

export function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function formatTorrentLine(t, index) {
  const tags = (t.tags || []).map((tag) => {
    if (tag === "4K") return chalk.magenta(tag);
    if (tag === "1080p") return chalk.cyan(tag);
    if (tag === "720p") return chalk.blue(tag);
    if (tag === "BluRay") return chalk.green(tag);
    if (tag === "WEB-DL") return chalk.green(tag);
    if (tag === "WEBRip") return chalk.green(tag);
    if (tag === "HEVC") return chalk.magenta(tag);
    if (tag === "x264") return chalk.blue(tag);
    if (tag === "AV1") return chalk.magenta(tag);
    if (tag === "DTS") return chalk.yellow(tag);
    if (tag === "5.1") return chalk.yellow(tag);
    if (tag === "Atmos") return chalk.yellow(tag);
    if (tag === "HDR") return chalk.magenta(tag);
    if (tag === "HDR10+") return chalk.magenta(tag);
    if (tag === "Remux") return chalk.green(tag);
    if (tag === "MKV") return chalk.gray(tag);
    if (tag === "MP4") return chalk.gray(tag);
    if (tag === "CAM") return chalk.red(tag);
    return chalk.gray(tag);
  });

  const tagStr = tags.length > 0 ? " " + tags.join(chalk.gray(" · ")) : "";
  const sizeStr = t.sizeStr || fmtBytes(t.size);
  const seedersStr = chalk.yellow(`▲${t.seeders}`);
  const sourceStr = chalk.gray(`[${t.source}]`);

  // Truncate name to fit
  const maxNameLen = 50;
  let name = t.name;
  if (name.length > maxNameLen) {
    name = name.slice(0, maxNameLen - 3) + "...";
  }

  return `${chalk.white(name)}${tagStr} ${chalk.gray(sizeStr)} ${seedersStr} ${sourceStr}`;
}
