// Torrent search — mirrors the rattin website's multi-provider approach
// Providers: Torrentio, The Pirate Bay, EZTV, YTS, Nyaa

const TORRENTIO_BASE = "https://torrentio.strem.fun";
const TORRENTIO_TIMEOUT = 8000;

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

// ── Torrentio ──────────────────────────────────────────────────────

function parseTorrentioTitle(title) {
  const lines = title.split("\n");
  const torrentName = lines[0] || "";
  const seedersMatch = title.match(/👤\s*(\d+)/);
  const sizeMatch = title.match(/💾\s*([\d.]+\s*[KMGT]?i?B)/i);
  const sourceMatch = title.match(/⚙️\s*(.+)/);
  return {
    name: torrentName,
    seeders: seedersMatch ? parseInt(seedersMatch[1], 10) : 0,
    sizeStr: sizeMatch ? sizeMatch[1].trim() : "",
    size: parseSizeStr(sizeMatch ? sizeMatch[1].trim() : ""),
    source: sourceMatch ? sourceMatch[1].trim() : "torrentio",
  };
}

function parseSizeStr(sizeStr) {
  if (!sizeStr) return 0;
  const m = sizeStr.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase().replace("I", "");
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(num * (mult[unit] || 1));
}

export async function searchTorrentio(imdbId, type, season, episode) {
  const url =
    type === "tv" && season !== undefined && episode !== undefined
      ? `${TORRENTIO_BASE}/stream/series/${imdbId}:${season}:${episode}.json`
      : `${TORRENTIO_BASE}/stream/movie/${imdbId}.json`;

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "rattin-cli/1.0" },
      signal: AbortSignal.timeout(TORRENTIO_TIMEOUT),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.streams?.length) return [];

    return data.streams
      .filter((s) => s.infoHash)
      .map((s) => {
        const parsed = parseTorrentioTitle(s.title || "");
        return {
          name: parsed.name,
          infoHash: s.infoHash.toLowerCase(),
          size: parsed.size,
          sizeStr: parsed.sizeStr,
          seeders: parsed.seeders,
          leechers: 0,
          source: parsed.source,
          fileIdx: s.fileIdx,
          tags: parseTags(parsed.name),
        };
      });
  } catch {
    return [];
  }
}

// ── The Pirate Bay ─────────────────────────────────────────────────

async function searchTPB(query) {
  try {
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "rattin-cli/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (Array.isArray(data) ? data : [])
      .filter((r) => r.id !== "0" && r.name !== "No results returned")
      .map((r) => ({
        name: r.name,
        infoHash: (r.info_hash || "").toLowerCase(),
        size: parseInt(r.size, 10) || 0,
        sizeStr: fmtBytes(parseInt(r.size, 10) || 0),
        seeders: parseInt(r.seeders, 10) || 0,
        leechers: parseInt(r.leechers, 10) || 0,
        source: "tpb",
        tags: parseTags(r.name),
      }));
  } catch {
    return [];
  }
}

// ── EZTV ───────────────────────────────────────────────────────────

async function searchEZTV(query, imdbId) {
  if (!imdbId) return [];
  const numericId = imdbId.replace(/\D/g, "");
  if (!numericId) return [];

  try {
    const results = [];
    for (let page = 1; page <= 3; page++) {
      const url = `https://eztvx.to/api/get-torrents?imdb_id=${numericId}&limit=100&page=${page}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "rattin-cli/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) break;
      const data = await resp.json();
      if (!data.torrents?.length) break;
      for (const t of data.torrents) {
        results.push({
          name: t.title || t.filename,
          infoHash: (t.hash || "").toLowerCase(),
          size: parseInt(t.size_bytes, 10) || 0,
          sizeStr: fmtBytes(parseInt(t.size_bytes, 10) || 0),
          seeders: parseInt(t.seeds, 10) || 0,
          leechers: parseInt(t.peers, 10) || 0,
          source: "eztv",
          tags: parseTags(t.title || t.filename),
        });
      }
      if (data.torrents.length < 100) break;
    }
    // Filter by query terms
    const terms = query.toLowerCase().split(/\s+/);
    return results.filter((r) => {
      const name = r.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    });
  } catch {
    return [];
  }
}

// ── YTS ────────────────────────────────────────────────────────────

async function searchYTS(query) {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "rattin-cli/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.data?.movies) return [];

    const results = [];
    for (const movie of data.data.movies) {
      for (const torrent of movie.torrents || []) {
        results.push({
          name: `${movie.title_long} ${torrent.quality} ${torrent.type}`.trim(),
          infoHash: (torrent.hash || "").toLowerCase(),
          size: parseInt(torrent.size_bytes, 10) || 0,
          sizeStr: torrent.size,
          seeders: parseInt(torrent.seeds, 10) || 0,
          leechers: parseInt(torrent.peers, 10) || 0,
          source: "yts",
          tags: parseTags(`${movie.title_long} ${torrent.quality} ${torrent.type}`),
        });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ── Nyaa (anime) ──────────────────────────────────────────────────

function parseNyaaSize(sizeStr) {
  const m = sizeStr.trim().match(/^([\d.]+)\s*(KiB|MiB|GiB|TiB|B)$/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "tib") return val * 1024 ** 4;
  if (unit === "gib") return val * 1024 ** 3;
  if (unit === "mib") return val * 1024 ** 2;
  if (unit === "kib") return val * 1024;
  return val;
}

async function searchNyaa(query) {
  try {
    const url = `https://nyaa.si/?f=0&c=1_0&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results = [];
    const rows = html.split("<tr").slice(1);
    for (const row of rows) {
      const nameM = row.match(/<a[^>]+href="\/view\/\d+"[^>]+title="([^"]+)"/);
      if (!nameM) continue;
      const name = nameM[1].replace(/&#?\w+;/g, "").trim();
      if (!name) continue;

      const magnetM = row.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/);
      if (!magnetM) continue;
      const hashM = magnetM[1].match(/xt=urn:btih:([a-fA-F0-9]{40})/);
      if (!hashM) continue;

      const numericCells = [];
      for (const c of row.matchAll(/<td class="text-center">\s*([\d.]+)\s*<\/td>/gi)) {
        numericCells.push(parseInt(c[1].replace(/\./g, ""), 10));
      }
      const sizeM = row.match(/<td class="text-center">\s*([\d.]+\s*(?:KiB|MiB|GiB|TiB|B))\s*<\/td>/i);
      const size = sizeM ? parseNyaaSize(sizeM[1]) : 0;

      results.push({
        name,
        infoHash: hashM[1].toLowerCase(),
        size,
        sizeStr: sizeM ? sizeM[1].trim() : fmtBytes(size),
        seeders: numericCells.length >= 2 ? numericCells[numericCells.length - 2] : 0,
        leechers: numericCells.length >= 1 ? numericCells[numericCells.length - 1] : 0,
        source: "nyaa",
        tags: parseTags(name),
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Scoring (from rattin website) ─────────────────────────────────

export function scoreTorrent(result, title, year, type) {
  let score = 0;
  const name = result.name.toLowerCase();
  const titleLower = title.toLowerCase();

  if (!name.includes(titleLower.split(" ")[0])) return -1;

  const titleWords = titleLower.split(/\s+/);
  const matchedWords = titleWords.filter((w) => name.includes(w)).length;
  score += (matchedWords / titleWords.length) * 50;

  if (year && type === "movie" && name.includes(String(year))) score += 8;

  if (/1080p/.test(name)) score += 20;
  else if (/2160p|4k/i.test(name)) score += 15;
  else if (/720p/.test(name)) score += 10;

  if (/blu-?ray|bdremux/i.test(name)) score += 3;
  else if (/web-?dl/i.test(name)) score += 3;
  else if (/webrip|\bweb\b/i.test(name)) score += 2;
  else if (/bdrip/i.test(name)) score += 2;

  if (/\bcam\b|hdcam|telecine|\bts\b|hdts|telesync/i.test(name)) score -= 50;

  if (result.seeders === 0) return -1;

  const seederScore = Math.min(70, Math.log2(result.seeders + 1) * 5 + result.seeders / 100);
  score += seederScore;

  if (result.size && result.size > 0) {
    const gb = result.size / 1024 ** 3;
    if (type === "tv") {
      if (gb < 0.3) score -= 10;
      else if (gb < 0.5) score -= 3;
      else if (gb <= 1.5) score += 8;
      else if (gb <= 3) score += 3;
      else score -= Math.round(Math.min(8, (gb - 3) * 2));
    } else {
      if (gb < 1) score -= 15;
      else if (gb < 1.5) score -= 8;
      else if (gb < 3) score -= 2;
      else if (gb <= 10) score += 10;
      else if (gb <= 20) score += 4;
      else score -= Math.round(Math.min(10, (gb - 20) * 1.5));
    }
  }

  return score;
}

// ── Tag parsing ───────────────────────────────────────────────────

function parseTags(name) {
  const tags = [];
  if (/2160p/i.test(name)) tags.push("4K");
  else if (/1080p/i.test(name)) tags.push("1080p");
  else if (/720p/i.test(name)) tags.push("720p");
  else if (/480p/i.test(name)) tags.push("480p");

  if (/blu-?ray|bdremux/i.test(name)) tags.push("BluRay");
  else if (/web-?dl/i.test(name)) tags.push("WEB-DL");
  else if (/webrip/i.test(name)) tags.push("WEBRip");
  else if (/bdrip/i.test(name)) tags.push("BDRip");
  else if (/hdtv/i.test(name)) tags.push("HDTV");
  else if (/\bcam\b|hdcam/i.test(name)) tags.push("CAM");

  if (/\bx265\b|\bhevc\b/i.test(name)) tags.push("HEVC");
  else if (/\bx264\b|\bavc\b/i.test(name)) tags.push("x264");
  else if (/\bav1\b/i.test(name)) tags.push("AV1");

  if (/atmos/i.test(name)) tags.push("Atmos");
  else if (/\bdts\b/i.test(name)) tags.push("DTS");
  else if (/ddp?\s?5\.1|dd\+?\s?5\.1|eac3/i.test(name)) tags.push("5.1");

  if (/\.mp4\b/i.test(name)) tags.push("MP4");
  else if (/\.mkv\b/i.test(name)) tags.push("MKV");

  if (/remux/i.test(name)) tags.push("Remux");
  if (/hdr10\+/i.test(name)) tags.push("HDR10+");
  else if (/hdr/i.test(name)) tags.push("HDR");

  return tags;
}

// ── Multi-provider search ─────────────────────────────────────────

export async function searchTorrents(target) {
  const { type, title, year, season, episode, imdbId } = target;
  const query = year ? `${title} ${year}` : title;

  let results = [];

  // Try Torrentio first (best results)
  if (imdbId) {
    try {
      const torrentioResults = await searchTorrentio(
        imdbId,
        type,
        season,
        episode
      );
      if (torrentioResults.length > 0) {
        results = torrentioResults;
      }
    } catch {}
  }

  // Fallback to multi-provider search
  if (results.length === 0) {
    const searchQueries =
      type === "tv" && season && episode
        ? [
            `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
            `${title} S${String(season).padStart(2, "0")}`,
            query,
            `${title} - ${episode}`,
          ]
        : [query];

    const searches = searchQueries.map((q) =>
      Promise.allSettled([searchTPB(q), searchYTS(q), searchEZTV(q, imdbId)])
    );

    const allResults = [];
    for (const settled of await Promise.all(searches)) {
      for (const r of settled) {
        if (r.status === "fulfilled") allResults.push(...r.value);
      }
    }

    // Add Nyaa for anime-style queries
    if (type === "tv") {
      try {
        const nyaaResults = await searchNyaa(`${title} - ${episode}`);
        allResults.push(...nyaaResults);
      } catch {}
    }

    results = allResults;
  }

  // Deduplicate by infoHash
  const seen = new Map();
  for (const r of results) {
    if (!r.infoHash) continue;
    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      seen.set(r.infoHash, r);
    }
  }

  // Score and sort
  return [...seen.values()]
    .map((r) => ({
      ...r,
      score: scoreTorrent(r, title, year, type),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.seeders - a.seeders)
    .slice(0, 30);
}

// ── Helpers ───────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

export function buildMagnet(torrent) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}${trackers}`;
}
