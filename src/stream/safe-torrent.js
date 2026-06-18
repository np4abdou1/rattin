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
        // Check if piece exists before calling original
        if (piece != null && torrent.pieces[piece] != null) {
          return origRequest(wire, piece);
        }
        // Piece is null — skip this request
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
      } catch {
        // Swallow the null-piece crash in wire update
      }
    };
  }

  // Patch _update to catch any remaining crashes
  if (torrent._update) {
    const origUpdate = torrent._update.bind(torrent);
    let lastUpdate = 0;
    torrent._update = function (...args) {
      // Throttle to prevent crash loops
      const now = Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;
      try {
        origUpdate(...args);
      } catch {
        // Swallow — will retry on next tick
      }
    };
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
