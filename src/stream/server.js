/**
 * Stream HTTP Server
 *
 * Serves torrent file data to mpv via HTTP with range request support.
 * Integrates with PiecePrioritizer for intelligent piece fetching.
 * Handles edge cases: buffering, seeking, piece availability.
 */

import http from "http";

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".ogg": "video/ogg",
};

export class StreamServer {
  constructor(videoFile, torrent, prioritizer, log) {
    this.videoFile = videoFile;
    this.torrent = torrent;
    this.prioritizer = prioritizer;
    this.log = log || (() => {});

    this.server = null;
    this.port = 0;
    this.requestCount = 0;
    this.totalBytesServed = 0;
    this.activeStreams = new Set();

    // Extract extension for MIME type
    const name = videoFile.name;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    this.mimeType = MIME_TYPES[ext] || "video/mp4";
  }

  /**
   * Start the HTTP server on a random port
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this.server.on("error", reject);

      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        this.log(`StreamServer listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Handle incoming HTTP request from mpv
   */
  async _handleRequest(req, res) {
    const range = req.headers.range;
    const fileSize = this.videoFile.length;
    this.requestCount++;

    // Set CORS and common headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Connection", "close");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // HEAD request — just return headers
    if (req.method === "HEAD") {
      if (range) {
        const parts = this._parseRange(range, fileSize);
        res.writeHead(206, {
          "Content-Range": `bytes ${parts.start}-${parts.end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": parts.end - parts.start + 1,
          "Content-Type": this.mimeType,
        });
      } else {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": this.mimeType,
          "Accept-Ranges": "bytes",
        });
      }
      res.end();
      return;
    }

    // GET request — serve data
    try {
      if (range) {
        await this._serveRange(req, res, range, fileSize);
      } else {
        await this._serveFull(req, res, fileSize);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      this.log(`Request error: ${err.message}`);
    }
  }

  /**
   * Serve a byte range (most common — mpv uses range requests)
   */
  async _serveRange(req, res, range, fileSize) {
    const parts = this._parseRange(range, fileSize);
    const { start, end } = parts;
    const contentLength = end - start + 1;

    // Notify prioritizer about this request (triggers piece prioritization)
    const isSeek = this.prioritizer.onRequest(start, end);

    if (isSeek) {
      this.log(`Seek detected: byte ${start} (was at ${this.prioritizer.currentOffset})`);
    }

    // Map byte range to pieces
    const { startPiece, endPiece } = this.prioritizer.getPieceRange(start, end);

    // Check if pieces are available, wait if needed
    const ready = await this.prioritizer.waitForRange(start, end, 15000);
    if (!ready) {
      this.log(`Pieces not ready for range ${start}-${end}, serving anyway`);
    }

    // Verify pieces exist before attempting to read
    const allPiecesExist = this._checkPiecesExist(startPiece, endPiece);
    if (!allPiecesExist) {
      this.log(`Missing pieces for range ${startPiece}-${endPiece}, buffering...`);
      // Try to wait a bit more
      const retryReady = await this.prioritizer.waitForRange(start, end, 5000);
      if (!retryReady) {
        res.writeHead(503, { "Retry-After": "1" });
        res.end("Buffering");
        return;
      }
    }

    // Send response
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": this.mimeType,
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
    });

    // Stream data with timeout and error handling
    const stream = this.videoFile.createReadStream({ start, end });
    this.activeStreams.add(stream);

    let bytesSent = 0;
    const timeout = setTimeout(() => {
      this.log(`Stream timeout for range ${start}-${end}`);
      stream.destroy();
    }, 30000);

    stream.on("data", (chunk) => {
      bytesSent += chunk.length;
    });

    stream.on("end", () => {
      clearTimeout(timeout);
      this.activeStreams.delete(stream);
      this.totalBytesServed += bytesSent;
    });

    stream.on("error", (err) => {
      clearTimeout(timeout);
      this.activeStreams.delete(stream);
      if (!res.destroyed) {
        try { res.end(); } catch {}
      }
    });

    res.on("close", () => {
      clearTimeout(timeout);
      this.activeStreams.delete(stream);
      stream.destroy();
    });

    stream.pipe(res);
  }

  /**
   * Serve the entire file (no range header)
   */
  async _serveFull(req, res, fileSize) {
    this.prioritizer.onRequest(0, fileSize);

    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": this.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache, no-store",
    });

    const stream = this.videoFile.createReadStream();
    this.activeStreams.add(stream);

    let bytesSent = 0;
    stream.on("data", (chunk) => { bytesSent += chunk.length; });
    stream.on("end", () => {
      this.activeStreams.delete(stream);
      this.totalBytesServed += bytesSent;
    });
    stream.on("error", () => {
      this.activeStreams.delete(stream);
      try { res.end(); } catch {}
    });
    res.on("close", () => {
      this.activeStreams.delete(stream);
      stream.destroy();
    });

    stream.pipe(res);
  }

  /**
   * Parse Range header into { start, end }
   */
  _parseRange(range, fileSize) {
    const parts = range.replace(/bytes=/, "").split("-");
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Clamp to valid range
    start = Math.max(0, Math.min(start, fileSize - 1));
    end = Math.max(start, Math.min(end, fileSize - 1));

    return { start, end };
  }

  /**
   * Check if pieces covering a range exist and are complete
   */
  _checkPiecesExist(startPiece, endPiece) {
    for (let i = startPiece; i <= endPiece; i++) {
      const piece = this.torrent.pieces[i];
      if (!piece) return false;
      if (piece.missing > 0) return false;
    }
    return true;
  }

  /**
   * Get URL for mpv to connect to
   */
  getUrl() {
    return `http://127.0.0.1:${this.port}/`;
  }

  /**
   * Get server stats
   */
  getStats() {
    return {
      port: this.port,
      requestCount: this.requestCount,
      totalBytesServed: this.totalBytesServed,
      activeStreams: this.activeStreams.size,
    };
  }

  /**
   * Stop the server and close all streams
   */
  stop() {
    // Close all active streams
    for (const stream of this.activeStreams) {
      try { stream.destroy(); } catch {}
    }
    this.activeStreams.clear();

    // Close the server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}
