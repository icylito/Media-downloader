const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const VIDEO_FORMAT = (h, withAudio) => {
  const v = h ? `bv*[height<=${h}]` : 'bv*';
  return withAudio ? (h ? `${v}+ba/b[height<=${h}]` : `${v}+ba/b`) : v;
};

const AUDIO_ARGS = {
  mp3: (bitrate) => ['-x', '--audio-format', 'mp3', '--audio-quality', bitrate ? `${bitrate}K` : '0'],
  opus: () => ['-x', '--audio-format', 'opus'],
  flac: () => ['-x', '--audio-format', 'flac'],
};

const UNIT_BYTES = { KiB: 1024, MiB: 1048576, GiB: 1073741824 };

const fmtSpeed = (bytesPerSec) => `${(bytesPerSec / UNIT_BYTES.MiB).toFixed(2)} MB/s`;

const fmtSize = (bytes) => {
  const unit = bytes >= UNIT_BYTES.GiB ? 'GiB' : bytes >= UNIT_BYTES.MiB ? 'MiB' : 'KiB';
  return `${(bytes / UNIT_BYTES[unit]).toFixed(2)} ${unit}`;
};

// Windows-style duplicate name: "clip.mp4" taken -> "clip (1).mp4"
function nextFree(p) {
  const ext = path.extname(p);
  const base = path.join(path.dirname(p), path.basename(p, ext));
  let n = 1;
  while (fs.existsSync(`${base} (${n})${ext}`)) n += 1;
  return `${base} (${n})${ext}`;
}

const stripStreamTag = (p) => p.replace(/\.f\d+(?=\.)/, '');

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
  constructor({ ytDlp, ffmpegDir, outDir, stateDir, onItems, onLog }) {
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
    // maps an absolute output path to { vid, mode, height, withAudio } so a
    // re-grab of the identical media can be skipped instead of re-downloaded
    this.indexPath = stateDir ? path.join(stateDir, 'download-index.json') : '';
    this.index = {};
    if (this.indexPath) {
      try {
        this.index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) || {};
      } catch {
        this.index = {};
      }
    }
  }

  saveIndex() {
    if (!this.indexPath) return;
    try {
      for (const file of Object.keys(this.index)) {
        if (!fs.existsSync(file)) delete this.index[file];
      }
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch {
      // the index is best-effort; a write failure must not break a download
    }
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
      bitrate: opts.bitrate || 0,
      withAudio: opts.withAudio !== false,
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
    item.noAudio = item.mode === 'mp4' && !item.withAudio;
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
    this.grab({
      url: old.url,
      mode: old.mode,
      height: old.height,
      bitrate: old.bitrate,
      withAudio: old.withAudio,
      playlist: old.playlist,
      embedThumb: old.embedThumb,
    });
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

  formatArgs(item) {
    const f = [];
    if (item.mode === 'mp4') {
      f.push('-f', VIDEO_FORMAT(item.height, item.withAudio));
    } else {
      f.push('-f', 'ba/b', ...AUDIO_ARGS[item.mode](item.bitrate));
      if (item.embedThumb) f.push('--embed-thumbnail', '--embed-metadata');
    }
    return f;
  }

  // Resolve what yt-dlp would write (stream name + final name) without downloading,
  // so an existing file can either skip the grab or shift the new one to "name (1)".
  resolveTarget(item) {
    return new Promise((resolve) => {
      const args = [
        ...this.formatArgs(item),
        '-P', this.outDir,
        '-o', '%(title)s.%(ext)s',
        '--simulate', '--no-warnings', '--ignore-config', '--windows-filenames',
        '--print', 'id', '--print', 'filename',
        '--', item.url,
      ];
      const proc = spawn(this.ytDlp, args, { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.stderr.on('data', () => {});
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
        const [vid, streamName] = lines;
        if (!vid || !streamName) return resolve(null);
        // --simulate prints the pre-extraction name; audio modes finish under a different ext
        const finalName =
          item.mode === 'mp4' ? streamName : streamName.replace(/\.[a-z0-9]+$/i, `.${item.mode}`);
        resolve({ vid, streamName, finalName });
      });
    });
  }

  // A file downloaded before with the same identity (video id + format settings)
  // that is still on disk — that exact grab is a repeat and can be skipped.
  findByIdentity(item, vid) {
    for (const [file, rec] of Object.entries(this.index)) {
      if (
        rec.vid === vid &&
        rec.mode === item.mode &&
        (rec.height || 0) === (item.height || 0) &&
        (rec.bitrate || 0) === (item.bitrate || 0) &&
        (rec.withAudio !== false) === item.withAudio &&
        fs.existsSync(file)
      ) {
        return file;
      }
    }
    return '';
  }

  finishSkipped(item, finalName) {
    item.file = finalName;
    item.title =
      path.basename(finalName).replace(/\.[a-z0-9]+$/i, '').replace(/\.f\d+$/i, '') || item.title;
    item.progress = 100;
    item.state = 'done';
    item.stage = item.playlist ? `Playlist · ${item.total || item.part} items` : 'Already on disk';
    try {
      item.size = fmtSize(fs.statSync(finalName).size);
    } catch {
      item.size = '';
    }
    this.activeId = null;
    this.emit(true);
    this.pump();
  }

  async start(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.activeId = id;
    item.state = 'active';
    item.stage = 'Starting…';
    this.emit(true);

    if (!item.playlist) {
      item.stage = 'Checking library…';
      this.emit(true);
      const target = await this.resolveTarget(item);
      if (this.activeId !== id || item.state !== 'active') {
        item.state = 'error';
        item.stage = 'Canceled';
        item.error = 'Canceled.';
        if (this.activeId === id) this.activeId = null;
        this.emit(true);
        this.pump();
        return;
      }
      if (target) {
        item.vid = target.vid;
        const have = this.findByIdentity(item, target.vid);
        if (have) {
          this.finishSkipped(item, have);
          return;
        }
        const streamTaken =
          target.streamName &&
          (fs.existsSync(target.streamName) || fs.existsSync(stripStreamTag(target.streamName)));
        if (fs.existsSync(target.finalName) || streamTaken) item.outName = nextFree(target.finalName);
      }
      item.stage = 'Starting…';
      this.emit(true);
    }

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
        if (item.file) {
          try {
            item.size = fmtSize(fs.statSync(item.file).size);
          } catch {
            // final file missing — keep whatever size text the progress lines left
          }
        }
        if (item.vid && item.file && !item.playlist) {
          this.index[item.file] = {
            vid: item.vid,
            mode: item.mode,
            height: item.height || 0,
            bitrate: item.bitrate || 0,
            withAudio: item.withAudio,
          };
          this.saveIndex();
        }
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
      '--newline', '--no-colors', '--ignore-config', '--windows-filenames',
      '--ffmpeg-location', this.ffmpegDir,
      '-P', this.outDir,
      item.playlist ? '--yes-playlist' : '--no-playlist',
    ];
    if (!item.playlist && item.vid) {
      // target was resolved up front and is fresh — never clobber anything
    } else {
      a.push('--force-overwrites');
    }
    a.push('-o', item.outName ? item.outName.replace(/%/g, '%%') : '%(title)s.%(ext)s');
    a.push(...this.formatArgs(item));
    a.push('--', item.url);
    return a;
  }

  setOutDir(dir) {
    this.outDir = dir;
  }
}

module.exports = { DownloadManager };
