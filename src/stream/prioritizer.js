/**
 * Adaptive Piece Prioritizer
 *
 * Smart piece prioritization engine that makes torrent streaming feel like
 * YouTube. Detects seeks, reprioritizes pieces on-the-fly, and manages
 * bandwidth efficiently.
 *
 * Priority levels (WebTorrent):
 *   0 = dont-download
 *   1 = normal
   2 = high
 *   3 = highest
 */

const PIECE_PRIORITY = {
  DONT_DOWNLOAD: 0,
  NORMAL: 1,
  HIGH: 2,
  HIGHEST: 3,
};

const PREFETCH_AHEAD_SEC = 30;
const STALL_TIMEOUT_MS = 3000;

/**
 * Safely check if a piece is downloaded (guards against null)
 */
function isPieceReady(pieces, index) {
  if (!pieces || index < 0 || index >= pieces.length) return false;
  const piece = pieces[index];
  return piece != null && piece.missing === 0;
}

/**
 * Safely get piece missing count (guards against null)
 */
function getPieceMissing(pieces, index) {
  if (!pieces || index < 0 || index >= pieces.length) return Infinity;
  const piece = pieces[index];
  if (piece == null) return Infinity;
  return piece.missing;
}

export class PiecePrioritizer {
  constructor(torrent, pieceLength, fileSize) {
    this.torrent = torrent;
    this.pieceLength = pieceLength;
    this.fileSize = fileSize;

    // State tracking
    this.currentOffset = 0;
    this.lastPrioritizationTime = 0;
    this.isSeeking = false;
    this.seekTarget = null;

    // Piece range for this file
    this.fileStartPiece = 0;
    this.fileEndPiece = Math.floor((fileSize - 1) / pieceLength);

    // Playback tracking
    this.playbackSpeed = 0;

    // Priority state
    this._lastPriorityMap = null;
  }

  /**
   * Safe accessor for torrent.pieces
   */
  get pieces() {
    return this.torrent?.pieces || [];
  }

  get maxPieceIndex() {
    return this.pieces.length - 1;
  }

  /**
   * Check if enough data is available using file-level tracking
   * (works even when piece array is corrupted by WebTorrent crash)
   */
  isDataAvailable(startByte, endByte) {
    try {
      // Use safe download tracking if available (works after piece corruption)
      const downloaded = this.torrent?._safeDownloaded?.() ?? this.torrent?.downloaded ?? 0;
      return downloaded >= endByte;
    } catch {
      return false;
    }
  }

  /**
   * Get file-level progress (safe, works after crashes)
   */
  getFileProgress() {
    try {
      const downloaded = this.torrent?.downloaded || 0;
      return {
        downloaded,
        total: this.fileSize,
        percent: this.fileSize > 0 ? (downloaded / this.fileSize * 100).toFixed(1) : "0.0",
      };
    } catch {
      return { downloaded: 0, total: this.fileSize, percent: "0.0" };
    }
  }

  /**
   * Get all piece indices that cover a byte range [startByte, endByte]
   */
  getPieceRange(startByte, endByte) {
    const startPiece = Math.max(
      this.fileStartPiece,
      Math.floor(startByte / this.pieceLength)
    );
    const endPiece = Math.min(
      this.fileEndPiece,
      Math.floor(endByte / this.pieceLength),
      this.maxPieceIndex
    );
    return { startPiece, endPiece: Math.max(startPiece, endPiece) };
  }

  /**
   * Get pieces needed for a byte range (with lookahead)
   */
  getNeededPieces(startByte, endByte, lookaheadBytes = 0) {
    const { startPiece, endPiece } = this.getPieceRange(startByte, endByte);
    const lookaheadPieces = Math.ceil(lookaheadBytes / this.pieceLength);
    return {
      startPiece,
      endPiece: Math.min(endPiece + lookaheadPieces, this.fileEndPiece, this.maxPieceIndex),
      criticalStart: startPiece,
      criticalEnd: endPiece,
    };
  }

  /**
   * Called when player requests a byte range via HTTP.
   * Returns true if a seek was detected.
   */
  onRequest(startByte, endByte) {
    const now = Date.now();

    // Detect seek: large gap from last served position
    const byteGap = Math.abs(startByte - this.currentOffset);
    const isSeek = byteGap > this.pieceLength * 10 && this.currentOffset > 0;

    if (isSeek) {
      this.isSeeking = true;
      this.seekTarget = startByte;
      this._onSeek(startByte, endByte);
    } else if (now - this.lastPrioritizationTime > 500) {
      this.currentOffset = startByte;
      this._onPlayback(startByte, endByte);
    }

    this.currentOffset = endByte;
    this.lastPrioritizationTime = now;

    return isSeek;
  }

  /**
   * Handle seek: aggressively reprioritize pieces around seek target
   */
  _onSeek(startByte, endByte) {
    const pieces = this.getNeededPieces(startByte, endByte, PREFETCH_AHEAD_SEC * this._getBytesPerSec());
    const { startPiece, endPiece, criticalStart, criticalEnd } = pieces;

    const priorities = new Map();

    // Critical pieces → HIGHEST
    for (let i = criticalStart; i <= criticalEnd; i++) {
      priorities.set(i, PIECE_PRIORITY.HIGHEST);
    }

    // Prefetch → HIGH
    for (let i = criticalEnd + 1; i <= endPiece; i++) {
      priorities.set(i, PIECE_PRIORITY.HIGH);
    }

    // Far from seek target → DONT_DOWNLOAD
    const deadZone = 50;
    for (let i = this.fileStartPiece; i <= this.fileEndPiece && i <= this.maxPieceIndex; i++) {
      if (!priorities.has(i)) {
        if (Math.abs(i - startPiece) > deadZone + (endPiece - startPiece)) {
          priorities.set(i, PIECE_PRIORITY.DONT_DOWNLOAD);
        } else {
          priorities.set(i, PIECE_PRIORITY.NORMAL);
        }
      }
    }

    this._applyPriorities(priorities);
    this.isSeeking = false;
  }

  /**
   * Handle normal sequential playback
   */
  _onPlayback(startByte, endByte) {
    const pieces = this.getNeededPieces(startByte, endByte, PREFETCH_AHEAD_SEC * this._getBytesPerSec());
    const { startPiece, criticalEnd } = pieces;

    const priorities = new Map();

    // Next 10 seconds → HIGH
    const nearAhead = Math.ceil(10 * this._getBytesPerSec() / this.pieceLength);
    for (let i = startPiece; i <= Math.min(criticalEnd + nearAhead, this.fileEndPiece, this.maxPieceIndex); i++) {
      priorities.set(i, PIECE_PRIORITY.HIGH);
    }

    // Next 30 seconds → NORMAL
    const midAhead = Math.ceil(PREFETCH_AHEAD_SEC * this._getBytesPerSec() / this.pieceLength);
    for (let i = criticalEnd + nearAhead + 1; i <= Math.min(criticalEnd + midAhead, this.fileEndPiece, this.maxPieceIndex); i++) {
      priorities.set(i, PIECE_PRIORITY.NORMAL);
    }

    // Already played → DONT_DOWNLOAD
    for (let i = this.fileStartPiece; i < startPiece - 5 && i <= this.maxPieceIndex; i++) {
      if (!priorities.has(i)) {
        priorities.set(i, PIECE_PRIORITY.DONT_DOWNLOAD);
      }
    }

    this._applyPriorities(priorities);
  }

  /**
   * Apply priority map to torrent pieces (batched, safe)
   */
  _applyPriorities(priorities) {
    const pieces = this.pieces;
    if (pieces.length === 0) return;

    const maxPiece = this.maxPieceIndex;

    const key = this._priorityMapKey(priorities);
    if (key === this._lastPriorityMap) return;
    this._lastPriorityMap = key;

    // Batch by priority level
    const batches = new Map();
    for (const [piece, priority] of priorities) {
      if (piece < 0 || piece > maxPiece) continue;
      if (!batches.has(priority)) batches.set(priority, []);
      batches.get(priority).push(piece);
    }

    for (const [priority, pieceList] of batches) {
      for (let i = 0; i < pieceList.length; i++) {
        const start = pieceList[i];
        let end = start;
        while (i + 1 < pieceList.length && pieceList[i + 1] === end + 1) {
          end = pieceList[i + 1];
          i++;
        }
        end = Math.min(end, maxPiece);
        try {
          this.torrent.select(start, end, priority);
        } catch {}
      }
    }
  }

  /**
   * Wait until a byte range is available on disk
   */
  async waitForRange(startByte, endByte, timeoutMs = STALL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    // Try to prioritize this range (catch crashes from torrent.select)
    try {
      const { startPiece, endPiece } = this.getPieceRange(startByte, endByte);
      const maxPiece = this.maxPieceIndex;
      const clampedEnd = Math.min(endPiece, maxPiece);
      for (let i = startPiece; i <= clampedEnd; i++) {
        try {
          this.torrent.select(i, i, PIECE_PRIORITY.HIGHEST);
        } catch {}
      }
    } catch {}

    return new Promise((resolve) => {
      const check = () => {
        if (Date.now() > deadline) {
          resolve(false);
          return;
        }

        // Use file-level progress (safe, works after piece corruption)
        if (this.isDataAvailable(startByte, endByte)) {
          resolve(true);
          return;
        }

        setTimeout(check, 200);
      };
      check();
    });
  }

  /**
   * Count ready pieces for the video file (safe)
   */
  countReadyPieces() {
    const pieces = this.pieces;
    if (pieces.length === 0) return { ready: 0, total: 0 };

    let ready = 0;
    const total = this.fileEndPiece - this.fileStartPiece + 1;
    for (let i = this.fileStartPiece; i <= this.fileEndPiece && i <= this.maxPieceIndex; i++) {
      if (isPieceReady(pieces, i)) ready++;
    }
    return { ready, total };
  }

  /**
   * Estimate bytes per second
   */
  _getBytesPerSec() {
    try {
      const speed = this.torrent.downloadSpeed;
      if (speed > 0) {
        this.playbackSpeed = speed;
        return speed;
      }
    } catch {}
    return this.playbackSpeed || 1024 * 1024;
  }

  _priorityMapKey(priorities) {
    const critical = [];
    const blocked = [];
    for (const [piece, priority] of priorities) {
      if (priority === PIECE_PRIORITY.HIGHEST) critical.push(piece);
      if (priority === PIECE_PRIORITY.DONT_DOWNLOAD) blocked.push(piece);
    }
    return `${critical.length}:${blocked.length}`;
  }

  /**
   * Get stats about current state (safe)
   */
  getStats() {
    const { ready, total } = this.countReadyPieces();
    return {
      totalPieces: total,
      downloaded: ready,
      missing: total - ready,
      percent: total > 0 ? ((ready / total) * 100).toFixed(1) : "0.0",
      currentOffset: this.currentOffset,
      isSeeking: this.isSeeking,
    };
  }
}

// Export safe helpers for use by other modules
export { isPieceReady, getPieceMissing };
