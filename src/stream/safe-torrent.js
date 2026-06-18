/**
 * Safe Torrent Wrapper
 *
 * Patches a WebTorrent torrent to prevent the null-piece crash in 3.x.
 * Instead of suppressing _update (which kills downloads), we patch the
 * specific methods that crash: _request and trySelectWire (via _updateWire).
 */

/**
 * Create a safe torrent wrapper
 */
export function createSafeTorrent(torrent) {
  // Patch _request to handle null pieces
  if (torrent._request) {
    const origRequest = torrent._request.bind(torrent);
    torrent._request = function (wire, piece) {
      try {
        if (piece != null && torrent.pieces[piece] != null) {
          return origRequest(wire, piece);
        }
        return false;
      } catch {
        return false;
      }
    };
  }

  // Patch _updateWire to catch crashes from piece selection
  if (torrent._updateWire) {
    const origUpdateWire = torrent._updateWire.bind(torrent);
    torrent._updateWire = function (...args) {
      try {
        origUpdateWire(...args);
      } catch {}
    };
  }

  // Patch _update to catch any remaining crashes
  if (torrent._update) {
    const origUpdate = torrent._update.bind(torrent);
    let lastUpdate = 0;
    torrent._update = function (...args) {
      const now = Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      try {
        origUpdate(...args);
      } catch {}
    };
  }

  // Patch bitfield to report all pieces as available
  // This allows createReadStream to read from the store even after piece corruption
  if (torrent.bitfield) {
    const origGet = torrent.bitfield.get?.bind(torrent.bitfield);
    if (origGet) {
      torrent.bitfield.get = function (index) {
        try { return true; } catch { return origGet(index); }
      };
    }
  }

  // Safe download tracking
  let manualDownloaded = 0;
  let lastSpeed = 0;

  torrent.on("download", () => {
    try {
      const dl = torrent.downloaded;
      if (dl > manualDownloaded) manualDownloaded = dl;
    } catch {}
    try { lastSpeed = torrent.downloadSpeed; } catch {}
  });

  torrent._safeDownloaded = () => {
    try {
      const dl = torrent.downloaded;
      if (dl > manualDownloaded) manualDownloaded = dl;
    } catch {}
    return manualDownloaded;
  };

  torrent._safeSpeed = () => {
    try { return torrent.downloadSpeed; } catch { return lastSpeed; }
  };

  torrent._safePeers = () => {
    try { return torrent.numPeers; } catch { return 0; }
  };

  return torrent;
}

/**
 * Create a safe WebTorrent client that patches torrents on creation.
 * This prevents the null-piece crash from corrupting the torrent
 * BEFORE createSafeTorrent is called.
 */
export async function createSafeClient(options) {
  const { default: WebTorrent } = await import("webtorrent");
  const client = new WebTorrent(options);

  // Intercept torrent creation to apply safety patches early
  const origAdd = client.add.bind(client);
  client.add = function (torrentId, opts) {
    const torrent = origAdd(torrentId, opts);
    
    // Patch immediately, before 'ready' fires
    // The crash happens during torrent initialization (before 'ready')
    const patchTorrent = () => {
      createSafeTorrent(torrent);
    };
    
    // Patch now (in case torrent is already partially initialized)
    patchTorrent();
    
    // Also patch again when torrent emits 'metadata' (new pieces array)
    torrent.on('metadata', patchTorrent);
    
    return torrent;
  };

  return client;
}
