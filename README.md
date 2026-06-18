# rattin

Stream torrents from the terminal. Search TMDB, pick a torrent, watch with MPV.

```
rattin
```

![cli](https://img.shields.io/badge/cli-interactive-blue) ![node](https://img.shields.io/badge/node-%3E%3D20-green) ![license](https://img.shields.io/badge/license-GPL--3.0-red)

## Install

```bash
git clone https://github.com/np4abdou1/rattin.git
cd rattin
pnpm install
```

### Dependencies

- **Node.js** >= 20
- **mpv** — video player
- **fzf** — fuzzy finder

```bash
# Ubuntu/Debian
sudo apt install mpv fzf

# macOS
brew install mpv fzf

# Arch
sudo pacman -S mpv fzf
```

## Setup

Set your TMDB API key (free at [themoviedb.org](https://www.themoviedb.org/settings/api)):

```bash
export TMDB_API_KEY="your_key_here"
```

## Usage

```bash
pnpm start
# or
npx rattin
```

1. **Search** — type a movie or TV show name
2. **Select** — pick from TMDB results via fzf
3. **For TV shows** — select season, then episode
4. **Pick torrent** — scored and sorted by quality, seeders, size
5. **Watch** — streams via WebTorrent into MPV

### Global install

```bash
pnpm link --global
rattin
```

## How it works

- **TMDB** for metadata (search, seasons, episodes, ratings)
- **Torrentio** as primary source (best curated results)
- **TPB, EZTV, YTS, Nyaa** as fallback providers
- **WebTorrent** for P2P streaming
- **MPV** for playback (hardware-accelerated, all formats)
- **fzf** for fuzzy selection UI

Torrents are scored by title match, resolution, source quality, seeders, and file size — same algorithm as the [rattin desktop app](https://github.com/np4abdou1/rattin).

## License

GPL-3.0
