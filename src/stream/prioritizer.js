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
 *   2 = high
 *   3 = highest
 */

const PIECE_PRIORITY = {
  DONT_DOWNLOAD: 0,
  NORMAL: 1,
  HIGH: 2,
  HIGHEST: 3,
};

const SEEK_DETECT_THRESHOLD_SEC = 5;
const PREFETCH_AHEAD_SEC = 30;
const PREFETCH_DISTANCE_SEC = 120;
const STALL_TIMEOUT_MS = 3000;

export class PiecePrioritizer {
  constructor(torrent, pieceLength, fileSize) {
    this.torrent = torrent;
    this.pieceLength = pieceLength;
    this.fileSize = fileSize;

    // State tracking
    this.currentOffset = 0;          // last byte position served to player
    this.lastPrioritizationTime = 0;
    this.isSeeking = false;
    this.seekTarget = null;

    // Piece range for this file
    this.fileStartPiece = 0;
    this.fileEndPiece = Math.floor((fileSize - 1) / pieceLength);

    // Playback tracking
    this.playbackSpeed = 0;          // bytes/sec estimate
    this.lastSpeedSample = 0;
    this.lastSpeedTime = 0;

    // Priority state
    this._lastPriorityMap = null;
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
      Math.floor(endByte / this.pieceLength)
    );
    return { startPiece, endPiece };
  }

  /**
   * Get pieces needed for a byte range (with lookahead)
   */
  getNeededPieces(startByte, endByte, lookaheadBytes = 0) {
    const { startPiece, endPiece } = this.getPieceRange(startByte, endByte);
    const lookaheadPieces = Math.ceil(lookaheadBytes / this.pieceLength);
    return {
      startPiece,
      endPiece: Math.min(endPiece + lookaheadPieces, this.fileEndPiece),
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
    const timeSinceLast = now - this.lastPrioritizationTime;

    // Detect seek: large gap from last served position
    const byteGap = Math.abs(startByte - this.currentOffset);
    const isSeek = byteGap > this.pieceLength * 10 && this.currentOffset > 0;

    if (isSeek) {
      this.isSeeking = true;
      this.seekTarget = startByte;
      this._onSeek(startByte, endByte);
    } else if (timeSinceLast > 500) {
      // Normal playback — update position
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

    // Find current playback position pieces
    const currentPiece = Math.floor(this.currentOffset / this.pieceLength);

    console.log(`[prioritizer] SEEK: byte ${startByte} → piece ${startPiece}-${endPiece} (was at piece ${currentPiece})`);

    // Build priority map
    const priorities = new Map();

    // 1. Critical pieces (what mpv needs RIGHT NOW) → HIGHEST
    for (let i = criticalStart; i <= criticalEnd; i++) {
      priorities.set(i, PIECE_PRIORITY.HIGHEST);
    }

    // 2. Prefetch pieces (ahead of current request) → HIGH
    for (let i = criticalEnd + 1; i <= endPiece; i++) {
      priorities.set(i, PIECE_PRIORITY.HIGH);
    }

    // 3. Pieces far from seek target → DONT_DOWNLOAD (save bandwidth)
    const deadZone = 50; // pieces
    for (let i = this.fileStartPiece; i <= this.fileEndPiece; i++) {
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
   * Handle normal sequential playback: prioritize ahead, deprioritize behind
   */
  _onPlayback(startByte, endByte) {
    const pieces = this.getNeededPieces(startByte, endByte, PREFETCH_AHEAD_SEC * this._getBytesPerSec());
    const { startPiece, endPiece, criticalEnd } = pieces;

    const priorities = new Map();

    // 1. Next 10 seconds → HIGH
    const nearAhead = Math.ceil(10 * this._getBytesPerSec() / this.pieceLength);
    for (let i = startPiece; i <= Math.min(criticalEnd + nearAhead, this.fileEndPiece); i++) {
      priorities.set(i, PIECE_PRIORITY.HIGH);
    }

    // 2. Next 30 seconds → NORMAL
    const midAhead = Math.ceil(PREFETCH_AHEAD_SEC * this._getBytesPerSec() / this.pieceLength);
    for (let i = criticalEnd + nearAhead + 1; i <= Math.min(criticalEnd + midAhead, this.fileEndPiece); i++) {
      priorities.set(i, PIECE_PRIORITY.NORMAL);
    }

    // 3. Far ahead → LOW priority (WebTorrent can fetch opportunistically)
    for (let i = criticalEnd + midAhead + 1; i <= this.fileEndPiece; i++) {
      priorities.set(i, PIECE_PRIORITY.NORMAL);
    }

    // 4. Already played pieces → DONT_DOWNLOAD (we've already served them)
    for (let i = this.fileStartPiece; i < startPiece - 5; i++) {
      if (!priorities.has(i)) {
        priorities.set(i, PIECE_PRIORITY.DONT_DOWNLOAD);
      }
    }

    this._applyPriorities(priorities);
  }

  /**
   * Apply priority map to torrent pieces (batched, efficient)
   */
  _applyPriorities(priorities) {
    // Avoid redundant updates
    const key = this._priorityMapKey(priorities);
    if (key === this._lastPriorityMap) return;
    this._lastPriorityMap = key;

    // Batch by priority level for fewer API calls
    const batches = new Map();
    for (const [piece, priority] of priorities) {
      if (!batches.has(priority)) batches.set(priority, []);
      batches.get(priority).push(piece);
    }

    for (const [priority, pieces] of batches) {
      if (priority === PIECE_PRIORITY.DONT_DOWNLOAD) {
        // Deselect ranges
        for (let i = 0; i < pieces.length; i++) {
          const start = pieces[i];
          let end = start;
          while (i + 1 < pieces.length && pieces[i + 1] === end + 1) {
            end = pieces[i + 1];
            i++;
          }
          try {
            this.torrent.select(start, end, 0);
          } catch {}
        }
      } else {
        // Select ranges with priority
        for (let i = 0; i < pieces.length; i++) {
          const start = pieces[i];
          let end = start;
          while (i + 1 < pieces.length && pieces[i + 1] === end + 1) {
            end = pieces[i + 1];
            i++;
          }
          try {
            this.torrent.select(start, end, priority);
          } catch {}
        }
      }
    }
  }

  /**
   * Wait until a byte range is available on disk
   */
  async waitForRange(startByte, endByte, timeoutMs = STALL_TIMEOUT_MS) {
    const { startPiece, endPiece } = this.getPieceRange(startByte, endByte);
    const deadline = Date.now() + timeoutMs;

    // Re-prioritize this range as highest
    for (let i = startPiece; i <= endPiece; i++) {
      try {
        this.torrent.select(i, i, PIECE_PRIORITY.HIGHEST);
      } catch {}
    }

    return new Promise((resolve) => {
      const check = () => {
        if (Date.now() > deadline) {
          resolve(false); // timeout — let server try anyway
          return;
        }

        let allReady = true;
        for (let i = startPiece; i <= endPiece; i++) {
          const piece = this.torrent.pieces[i];
          if (!piece || piece.missing > 0) {
            allReady = false;
            break;
          }
        }

        if (allReady) {
          resolve(true);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /**
   * Estimate bytes per second based on current download speed
   */
  _getBytesPerSec() {
    try {
      const speed = this.torrent.downloadSpeed;
      if (speed > 0) {
        this.playbackSpeed = speed;
        return speed;
      }
    } catch {}
    return this.playbackSpeed || 1024 * 1024; // fallback: 1 MB/s
  }

  /**
   * Generate a compact key for deduplicating priority updates
   */
  _priorityMapKey(priorities) {
    // Only track HIGHEST and DONT_DOWNLOAD for key (most important)
    const critical = [];
    const blocked = [];
    for (const [piece, priority] of priorities) {
      if (priority === PIECE_PRIORITY.HIGHEST) critical.push(piece);
      if (priority === PIECE_PRIORITY.DONT_DOWNLOAD) blocked.push(piece);
    }
    return `${critical.join(",")}|${blocked.join(",")}`;
  }

  /**
   * Get stats about current state
   */
  getStats() {
    const totalPieces = this.fileEndPiece - this.fileStartPiece + 1;
    let downloaded = 0;
    let missing = 0;

    for (let i = this.fileStartPiece; i <= this.fileEndPiece; i++) {
      const piece = this.torrent.pieces[i];
      if (piece && piece.missing === 0) downloaded++;
      else missing++;
    }

    return {
      totalPieces,
      downloaded,
      missing,
      percent: ((downloaded / totalPieces) * 100).toFixed(1),
      currentOffset: this.currentOffset,
      isSeeking: this.isSeeking,
    };
  }
}
