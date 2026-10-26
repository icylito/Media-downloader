const { spawn, execFile } = require('child_process');
const path = require('path');

const VIDEO_FORMAT = (h) => (h ? `bv*[height<=${h}]+ba/b[height<=${h}]` : 'bv*+ba/b');

const AUDIO_ARGS = {
  mp3: ['-x', '--audio-format', 'mp3', '--audio-quality', '320K'],
  opus: ['-x', '--audio-format', 'opus'],
  flac: ['-x', '--audio-format', 'flac'],
};

const UNIT_BYTES = { KiB: 1024, MiB: 1048576, GiB: 1073741824 };

const fmtSpeed = (bytesPerSec) => `${(bytesPerSec / UNIT_BYTES.MiB).toFixed(2)} MB/s`;

const fmtEta = (s) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const ERRORS = [
  [/private video/i, 'Private video. Sign in if you have access.'],
  [/sign in to confirm|age.?restrict/i, 'YouTube wants a sign-in for this video (age or bot check).'],
  [/video unavailable/i, 'Video unavailable.'],
  [/not a valid URL|Unsupported URL/i, 'That does not look like a supported URL.'],
  [/requested format is not available/i, 'That quality is not available for this video. Try a lower one.'],
  [/unable to download webpage|getaddrinfo|timed out/i, 'Network error — check your connection.'],
  [/blocked it in your country/i, 'This video is blocked in your country.'],
];

const LINE_RULES = [
  {
    re: /\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+)(KiB|MiB|GiB)(?: at\s+~?\s*([\d.]+)(KiB|MiB|GiB)\/s)?(?:\s+ETA (\S+))?/,
    apply(item, m) {
      item.progress = parseFloat(m[1]);
      item.size = `${m[2]} ${m[3]}`;
      item._totalBytes = parseFloat(m[2]) * (UNIT_BYTES[m[3]] || 1);
      item.stage = 'Downloading';
    },
  },
  {
    re: /\[download\] Destination: (.+)/,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = path.basename(item.file).replace(/\.[a-z0-9]+$/i, '').replace(/\.f\d+$/i, '') || item.title;
      item.progress = 0;
      item._totalBytes = 0;
      item._rate = null;
      item._sample = null;
      if (item.playlist) item.part += 1;
      item.stage = item.playlist && item.total ? `Item ${item.part} of ${item.total}` : 'Downloading';
    },
  },
  {
    re: /\[download\] (.+) has already been downloaded/,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = path.basename(item.file).replace(/\.[a-z0-9]+$/i, '').replace(/\.f\d+$/i, '') || item.title;
      item.progress = 100;
      item.stage = 'Already on disk';
    },
  },
  {
    re: /\[(?:Merger|VideoRemuxer)\] Merging \S+ into "(.+)"/,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = path.basename(item.file) || item.title;
      item.stage = 'Muxing video + audio';
    },
  },
  {
    re: /\[ExtractAudio\] Destination: (.+)/,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = path.basename(item.file) || item.title;
      item.stage = 'Extracting audio';
    },
  },
  {
    re: /\[ExtractAudio\] Not converting audio/,
    apply(item) {
      item.stage = 'Extracting audio';
    },
  },
  {
    re: /\[(?:EmbedThumbnail|Metadata)\]/,
    apply(item) {
      item.stage = 'Embedding thumbnail';
    },
  },
  {
    re: /\[download\] Downloading item (\d+) of (\d+)/,
    apply(item, m) {
      item.total = parseInt(m[2], 10);
      item.stage = `Item ${m[1]} of ${m[2]}`;
      item.progress = 0;
    },
  },
];

function humanError(raw) {
  const msg = (raw || '').trim();
  const hit = ERRORS.find(([re]) => re.test(msg));
  return hit ? hit[1] : msg || 'Download failed.';
}

function applyLine(item, line) {
  for (const rule of LINE_RULES) {
    const m = line.match(rule.re);
    if (m) {
      rule.apply(item, m);
      return true;
    }
  }
  return false;
}

class DownloadManager {
  constructor({ ytDlp, ffmpegDir, outDir, onItems, onLog }) {
    this.ytDlp = ytDlp;
    this.ffmpegDir = ffmpegDir;
    this.outDir = outDir;
    this.onItems = onItems;
    this.onLog = onLog;
    this.items = new Map();
    this.order = [];
    this.activeId = null;
    this.proc = null;
    this.nextId = 1;
  }

  snapshot() {
    return this.order.map((id) => {
      const { _sample, _rate, _totalBytes, ...clean } = this.items.get(id);
      return clean;
    });
  }

  emit(force = false) {
    if (force) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
      this.onItems(this.snapshot());
      return;
    }
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.onItems(this.snapshot());
    }, 500);
  }

  // Speed and ETA are averaged over recent samples so the display never jumps
  updateRate(item) {
    const total = item._totalBytes;
    if (!total) return;
    const done = (item.progress / 100) * total;
    const now = Date.now();
    if (item._sample && now - item._sample.t >= 400) {
      const inst = ((done - item._sample.b) / (now - item._sample.t)) * 1000;
      item._rate = item._rate ? 0.3 * inst + 0.7 * item._rate : inst;
      item.speed = fmtSpeed(item._rate);
      item.eta = fmtEta((total - done) / Math.max(item._rate, 1024));
      item._sample = { t: now, b: done };
    } else if (!item._sample) {
      item._sample = { t: now, b: done };
    }
  }

  log(line) {
    if (this.onLog) this.onLog(String(line).trimEnd());
  }

  grab(opts) {
    const id = String(this.nextId++);
    const item = {
      id,
      url: opts.url,
      mode: opts.mode || 'mp4',
      height: opts.height || 0,
      playlist: !!opts.playlist,
      embedThumb: !!opts.embedThumb,
      title: 'Fetching title…',
      stage: 'Queued',
      progress: 0,
      speed: '',
      eta: '',
      size: '',
      state: 'queued',
      error: '',
      file: '',
      part: 0,
      total: 0,
    };
    this.items.set(id, item);
    this.order.unshift(id);
    if (this.order.length > 60) {
      const dropped = this.order.pop();
      if (dropped !== id) this.items.delete(dropped);
    }
    this.emit(true);
    this.pump();
    return id;
  }

  retry(id) {
    const old = this.items.get(id);
    if (!old) return;
    this.items.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.grab({ url: old.url, mode: old.mode, height: old.height, playlist: old.playlist, embedThumb: old.embedThumb });
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (id === this.activeId && this.proc) {
      item.state = 'canceling';
      item.stage = 'Canceling…';
      this.emit(true);
      // /T kills the ffmpeg child process too
      execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], () => {});
    } else if (item.state === 'queued') {
      this.items.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.emit(true);
    }
  }

  pump() {
    if (this.activeId) return;
    const id = this.order.find((x) => this.items.get(x)?.state === 'queued');
    if (id) this.start(id);
  }

  start(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.activeId = id;
    item.state = 'active';
    item.stage = 'Starting…';
    this.emit(true);

    const args = this.buildArgs(item);
    this.log(`$ yt-dlp ${args.join(' ')}`);
    const proc = spawn(this.ytDlp, args, { windowsHide: true });
    this.proc = proc;

    const onLine = (buf) => {
      String(buf).split(/\r?\n/).forEach((line) => {
        const t = line.trim();
        if (!t) return;
        this.log(t);
        if (item.state !== 'active') return;
        if (/^\[?ERROR\]?:?/i.test(t)) {
          item.error = humanError(t.replace(/^\[?ERROR\]?:?/i, ''));
          return;
        }
        if (applyLine(item, t)) this.updateRate(item);
      });
      this.emit();
    };

    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);

    proc.on('close', (code, signal) => {
      if (this.activeId === id) {
        this.activeId = null;
        this.proc = null;
      }
      if (item.state === 'canceling' || signal) {
        item.state = 'error';
        item.stage = 'Canceled';
        item.error = 'Canceled.';
      } else if (item.error) {
        item.state = 'error';
        item.stage = 'Failed';
      } else if (code === 0) {
        item.state = 'done';
        item.progress = 100;
        item.stage = item.playlist ? `Playlist · ${item.total || item.part} items` : 'Done';
        item.speed = '';
        item.eta = '';
      } else {
        item.state = 'error';
        item.stage = 'Failed';
        item.error = item.error || `yt-dlp exited with code ${code}`;
      }
      this.emit(true);
      this.pump();
    });
  }

  buildArgs(item) {
    const a = [
      '--newline', '--no-colors', '--ignore-config', '--windows-filenames', '--force-overwrites',
      '--ffmpeg-location', this.ffmpegDir,
      '-P', this.outDir,
      '-o', '%(title)s.%(ext)s',
      item.playlist ? '--yes-playlist' : '--no-playlist',
    ];
    if (item.mode === 'mp4') {
      a.push('-f', VIDEO_FORMAT(item.height));
    } else {
      a.push('-f', 'ba/b', ...AUDIO_ARGS[item.mode]);
      if (item.embedThumb) a.push('--embed-thumbnail', '--embed-metadata');
    }
    a.push('--', item.url);
    return a;
  }

  setOutDir(dir) {
    this.outDir = dir;
  }
}

module.exports = { DownloadManager };
