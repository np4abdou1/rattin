#!/usr/bin/env node

import { checkDeps } from "../src/deps.js";
checkDeps();

import { Command } from "commander";
import chalk from "chalk";
import { searchTMDB, fetchTVDetails } from "../src/tmdb.js";
import { searchTorrents } from "../src/torrent.js";
import { fzfSelect } from "../src/fzf.js";
import { playWithMpv } from "../src/mpv.js";
import { formatTorrentLine, fmtBytes } from "../src/ui.js";

const VERSION = "1.0.0";

function printBanner() {
  console.log(
    chalk.yellow.bold("  ╔══════════════════════════════════╗") +
    chalk.yellow(" v" + VERSION) +
    chalk.gray("  streaming") +
    chalk.green(" ●") +
    chalk.gray(" ready")
  );
  console.log(chalk.yellow("  ╚══════════════════════════════════╝"));
  console.log();
}

async function promptSearch() {
  const inquirer = (await import("inquirer")).default;
  const { query } = await inquirer.prompt([
    {
      type: "input",
      name: "query",
      message: chalk.cyan("Search"),
      prefix: chalk.yellow("│\n│===>"),
    },
  ]);
  return query.trim();
}

async function handleTVSelection(item) {
  const inquirer = (await import("inquirer")).default;

  if (item.number_of_seasons > 1) {
    // Multiple seasons — show season list via fzf
    const seasons = Array.from({ length: item.number_of_seasons }, (_, i) => ({
      value: i + 1,
      label: `Season ${i + 1}`,
    }));

    const seasonChoices = seasons.map(
      (s) => ({
        name: chalk.white(s.label),
        value: s.value,
      })
    );

    const seasonInput = await fzfSelect(seasonChoices, "Select season");
    const seasonNum = Number(seasonInput);

    // Fetch season details
    const seasonData = await fetchTVDetails(item.id, seasonNum);
    if (!seasonData?.episodes?.length) {
      console.log(chalk.red("  No episodes found for this season."));
      return null;
    }

    // Show episode list via fzf
    const epChoices = seasonData.episodes.map((ep) => ({
      name: `${chalk.cyan(String(ep.episode_number).padStart(2, " "))} - ${chalk.white(ep.name.toUpperCase())} ${chalk.yellow("★" + (ep.vote_average / 2).toFixed(1))}`,
      value: ep,
    }));

    const epInput = await fzfSelect(epChoices, "Select episode");
    return {
      type: "tv",
      title: item.title || item.name,
      year: (item.first_air_date || "").slice(0, 4),
      season: seasonNum,
      episode: epInput.episode_number,
      episodeTitle: epInput.name,
      imdbId: null,
      tmdbId: item.id,
    };
  } else {
    // Single season — show episodes directly
    const seasonData = await fetchTVDetails(item.id, 1);
    if (!seasonData?.episodes?.length) {
      console.log(chalk.red("  No episodes found."));
      return null;
    }

    const epChoices = seasonData.episodes.map((ep) => ({
      name: `${chalk.cyan(String(ep.episode_number).padStart(2, " "))} - ${chalk.white(ep.name.toUpperCase())} ${chalk.yellow("★" + (ep.vote_average / 2).toFixed(1))}`,
      value: ep,
    }));

    const epInput = await fzfSelect(epChoices, "Select episode");
    return {
      type: "tv",
      title: item.title || item.name,
      year: (item.first_air_date || "").slice(0, 4),
      season: 1,
      episode: epInput.episode_number,
      episodeTitle: epInput.name,
      imdbId: null,
      tmdbId: item.id,
    };
  }
}

async function main() {
  const program = new Command();
  program
    .name("rattin")
    .description("Stream torrents from the terminal")
    .version(VERSION)
    .parse(process.argv);

  printBanner();

  // Step 1: Search TMDB
  const query = await promptSearch();
  if (!query) {
    console.log(chalk.gray("  No query entered. Exiting."));
    process.exit(0);
  }

  console.log(chalk.gray("  Searching TMDB..."));
  const results = await searchTMDB(query);

  if (!results.length) {
    console.log(chalk.red("  No results found."));
    process.exit(0);
  }

  // Format results for fzf
  const tmdbChoices = results.map((item) => {
    const title = item.title || item.name;
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    const rating = item.vote_average ? (item.vote_average / 2).toFixed(1) : "?";
    const type = item.media_type === "tv" ? "TV" : "MOVIE";
    return {
      name: `${chalk.yellow(title)} ${chalk.blue("(" + year + ")")} ${chalk.gray("[" + type + "]")} ${chalk.yellowBright("★" + rating)}`,
      value: item,
    };
  });

  const selectedItem = await fzfSelect(tmdbChoices, "Select content");

  // Step 2: Handle TV vs Movie
  let target;
  if (selectedItem.media_type === "tv") {
    target = await handleTVSelection(selectedItem);
    if (!target) process.exit(0);
  } else {
    target = {
      type: "movie",
      title: selectedItem.title || selectedItem.name,
      year: (selectedItem.release_date || "").slice(0, 4),
      imdbId: null,
      tmdbId: selectedItem.id,
    };
  }

  // Step 3: Search torrents
  console.log(chalk.gray("\n  Searching torrent sources..."));
  const torrents = await searchTorrents(target);

  if (!torrents.length) {
    console.log(chalk.red("  No torrents found."));
    process.exit(0);
  }

  // Format torrents for fzf
  const torrentChoices = torrents.map((t, i) => ({
    name: formatTorrentLine(t, i),
    value: t,
  }));

  const selectedTorrent = await fzfSelect(torrentChoices, "Select torrent");

  // Step 4: Launch with MPV
  console.log(chalk.gray("\n  Launching MPV..."));
  await playWithMpv(selectedTorrent);
}

main().catch((err) => {
  if (err.name === "ExitPromptError") {
    process.exit(0);
  }
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
