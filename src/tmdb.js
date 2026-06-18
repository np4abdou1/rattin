import chalk from "chalk";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p";

let API_KEY = process.env.TMDB_API_KEY || null;

async function tmdbFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error(
      "TMDB API key not set. Set TMDB_API_KEY env variable.\n" +
        "  Get a free key at: https://www.themoviedb.org/settings/api"
    );
  }

  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "rattin-cli/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`TMDB API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function searchTMDB(query) {
  const data = await tmdbFetch("/search/multi", {
    query,
    include_adult: "false",
    page: "1",
  });

  // Filter to movies and TV shows, take top 15
  return (data.results || [])
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .slice(0, 15);
}

export async function fetchTVDetails(tvId, season) {
  try {
    return await tmdbFetch(`/tv/${tvId}/season/${season}`);
  } catch {
    return null;
  }
}

export async function fetchMovieDetails(movieId) {
  try {
    return await tmdbFetch(`/movie/${movieId}`);
  } catch {
    return null;
  }
}

export function posterUrl(path, size = "w342") {
  if (!path) return null;
  return `${TMDB_IMG}/${size}${path}`;
}
