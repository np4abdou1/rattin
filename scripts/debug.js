#!/usr/bin/env node

/**
 * Debug script — runs the full pipeline non-interactively.
 * Searches for "death note", picks first TMDB result, first torrent, prints magnet.
 */

import "dotenv/config";
import chalk from "chalk";
import { searchTMDB, fetchTVDetails } from "../src/tmdb.js";
import { searchTorrents, buildMagnet } from "../src/torrent.js";

function log(label, value) {
  console.log(chalk.gray(`  ${label}:`) + " " + value);
}

async function main() {
  console.log(chalk.yellow.bold("\n  ╔══════════════════════════════╗"));
  console.log(chalk.yellow.bold("  ║   rattin debug               ║"));
  console.log(chalk.yellow.bold("  ╚══════════════════════════════╝\n"));

  // Step 1: Search TMDB for "death note"
  console.log(chalk.cyan("  [1] Searching TMDB for 'death note'..."));
  const results = await searchTMDB("death note");

  if (!results.length) {
    console.log(chalk.red("  No TMDB results."));
    process.exit(1);
  }

  // Pick first result
  const item = results[0];
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const type = item.media_type === "tv" ? "TV" : "MOVIE";
  const rating = item.vote_average ? (item.vote_average / 2).toFixed(1) : "?";

  log("Title", chalk.yellow(title));
  log("Year", chalk.blue(year));
  log("Type", chalk.gray(type));
  log("Rating", chalk.yellow("★" + rating));
  log("TMDB ID", item.id);
  console.log();

  // Step 2: If TV, get first episode info
  let target;
  if (item.media_type === "tv") {
    console.log(chalk.cyan("  [2] Fetching TV details..."));
    const seasonData = await fetchTVDetails(item.id, 1);
    const firstEp = seasonData?.episodes?.[0];

    if (firstEp) {
      log("Season", "1");
      log("Episode", `${firstEp.episode_number} - ${firstEp.name}`);
      target = {
        type: "tv",
        title,
        year,
        season: 1,
        episode: firstEp.episode_number,
        episodeTitle: firstEp.name,
        tmdbId: item.id,
      };
    } else {
      target = { type: "tv", title, year, season: 1, episode: 1, tmdbId: item.id };
    }
  } else {
    target = { type: "movie", title, year, tmdbId: item.id };
  }
  console.log();

  // Step 3: Search torrents
  console.log(chalk.cyan("  [3] Searching torrents..."));
  const torrents = await searchTorrents(target);

  if (!torrents.length) {
    console.log(chalk.red("  No torrents found."));
    process.exit(1);
  }

  // Pick first torrent
  const t = torrents[0];
  log("Torrent", chalk.white(t.name));
  log("Seeders", chalk.yellow(t.seeders));
  log("Size", t.sizeStr || "unknown");
  log("Source", chalk.gray(t.source));
  log("Score", chalk.green(t.score));
  console.log();

  // Step 4: Build and print magnet
  console.log(chalk.cyan("  [4] Magnet link:"));
  const magnet = buildMagnet(t);
  console.log(chalk.green(magnet));
  console.log();

  // Summary
  console.log(chalk.yellow("  ─── Summary ───"));
  log("Found", `${results.length} TMDB results`);
  log("Picked", `${title} (${year}) [${type}]`);
  log("Torrents", `${torrents.length} available`);
  log("Selected", t.name);
  console.log();
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
