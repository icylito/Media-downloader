const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { applyLine, humanError, nextFree, stripStreamTag, fmtSpeed, fmtSize, fmtEta } = require('./parse');
const { STATE, STATES, canGo, isActive, isTerminal } = require('./states');

const VIDEO_FORMAT = (h, withAudio) => {
  const v = h ? `bv*[height<=${h}]` : 'bv*';
  return withAudio ? (h ? `${v}+ba/b[height<=${h}]` : `${v}+ba/b`) : v;
};

const AUDIO_ARGS = {
  mp3: (bitrate) => ['-x', '--audio-format', 'mp3', '--audio-quality', bitrate ? `${bitrate}K` : '0'],
  opus: () => ['-x', '--audio-format', 'opus'],
  flac: () => ['-x', '--audio-format', 'flac'],
};

// yt-dlp leaves the source thumbnail on disk after embedding it
const THUMB_EXTS = ['webp', 'jpg', 'jpeg', 'png'];

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
    this.dying = false;
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

  hasActive() {
    return !!this.activeId;
  }

  // single transition point: guarded, and keeps item.stage in sync with the table
  setState(item, key) {
    if (item.state === key) return;
    if (!canGo(item.state, key)) return; // late cancel racing a done, straggler lines, etc.
    item.state = key;
    item.stage = STATES[key].label;
  }

  // Tear down the running yt-dlp tree and its partials before the app quits.
  quitCleanup(done) {
    this.dying = true;
    if (this.proc && this.activeId) {
      const item = this.items.get(this.activeId);
      execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {
        if (item) this.cleanupPartials(item);
        done();
      });
    } else {
      done();
    }
  }

  cleanupPartials(item) {
    const targets = [];
    for (const p of item._partials || []) targets.push(p, `${p}.part`);
    // the killed process's handles can outlive the kill for seconds on Windows:
    // retry in the background instead of blocking quit on a locked file
    const attempt = (remaining) => {
      const locked = [];
      for (const f of targets) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          if (e.code === 'EBUSY' || e.code === 'EPERM') locked.push(f);
        }
      }
      if (locked.length && remaining > 0) setTimeout(() => attempt(remaining - 1), 500);
    };
    attempt(20);
  }

  cleanupThumbs(file) {
    const base = file.slice(0, -path.extname(file).length);
    for (const ext of THUMB_EXTS) {
      try {
        fs.unlinkSync(`${base}.${ext}`);
      } catch {
        // no thumbnail sibling — fine
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
      const { _sample, _rate, _totalBytes, _partials, ...clean } = this.items.get(id);
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
      title: 'Fetching info…',
      stage: STATES[STATE.QUEUED].label,
      progress: 0,
      speed: '',
      eta: '',
      size: '',
      state: STATE.QUEUED,
      error: '',
      file: '',
      part: 0,
      total: 0,
      vid: '',
      actualHeight: 0,
      skipped: false,
      _partials: [],
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
    if (id === this.activeId && !isTerminal(item.state)) {
      this.setState(item, STATE.CANCELING);
      this.emit(true);
      if (this.proc) {
        // /T kills the ffmpeg child process too
        execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
    } else if (item.state === STATE.QUEUED) {
      this.items.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this.emit(true);
    }
  }

  pump() {
    if (this.activeId || this.dying) return;
    const id = this.order.find((x) => this.items.get(x)?.state === STATE.QUEUED);
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

  // Resolve what yt-dlp would write (stream name + final name + title + height)
  // without downloading, so an existing file can either skip the grab or shift
  // the new one to "name (1)".
  resolveTarget(item) {
    return new Promise((resolve) => {
      const args = [
        ...this.formatArgs(item),
        '-P', this.outDir,
        '-o', '%(title)s.%(ext)s',
        '--simulate', '--no-warnings', '--ignore-config', '--windows-filenames',
        '--print', 'id', '--print', 'filename', '--print', 'title', '--print', 'height',
        '--', item.url,
      ];
      const proc = spawn(this.ytDlp, args, { windowsHide: true });
      this.proc = proc; // tracked so cancel/quit can kill the pre-flight too
      let out = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.stderr.on('data', () => {});
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (this.proc === proc) this.proc = null; // no longer killable, pid is stale
        if (code !== 0) return resolve(null);
        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
        const [vid, streamName, title, height] = lines;
        if (!vid || !streamName) return resolve(null);
        // --simulate prints the pre-extraction name; audio modes finish under a different ext
        const finalName =
          item.mode === 'mp4' ? streamName : streamName.replace(/\.[a-z0-9]+$/i, `.${item.mode}`);
        resolve({ vid, streamName, finalName, title: title || '', height: parseInt(height, 10) || 0 });
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
      finalName.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').replace(/\.f\d+$/i, '') || item.title;
    item.progress = 100;
    item.state = STATE.SKIPPED;
    item.stage = STATES[STATE.SKIPPED].label;
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
    this.setState(item, STATE.RESOLVING);
    this.emit(true);

    if (!item.playlist) {
      const target = await this.resolveTarget(item);
      // only a still-resolving item may proceed: a cancel or quit during the
      // await must not spawn the real download
      if (this.dying || this.activeId !== id || item.state !== STATE.RESOLVING) {
        this.setState(item, STATE.CANCELED);
        if (this.activeId === id) this.activeId = null;
        this.emit(true);
        this.pump();
        return;
      }
      if (target) {
        item.vid = target.vid;
        if (target.title) item.title = target.title;
        item.actualHeight = target.height;
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
      this.setState(item, STATE.DOWNLOADING);
      this.emit(true);
    } else {
      this.setState(item, STATE.DOWNLOADING);
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
        if (!isActive(item.state)) return;
        if (/^\[?ERROR\]?:?/i.test(t)) {
          item.error = humanError(t.replace(/^\[?ERROR\]?:?/i, ''));
          return;
        }
        const phase = applyLine(item, t);
        if (phase) {
          this.setState(item, phase);
          this.updateRate(item);
        }
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
      if (item.state === STATE.CANCELING || (signal && !isTerminal(item.state))) {
        this.setState(item, STATE.CANCELED);
        item.error = item.error || 'Canceled.';
        this.cleanupPartials(item);
      } else if (item.error && !isTerminal(item.state)) {
        this.setState(item, STATE.FAILED);
        this.cleanupPartials(item);
      } else if (code === 0 && !isTerminal(item.state)) {
        this.setState(item, STATE.DONE);
        item.progress = 100;
        item.speed = '';
        item.eta = '';
        if (item.file) {
          try {
            item.size = fmtSize(fs.statSync(item.file).size);
          } catch {
            // final file missing — keep whatever size text the progress lines left
          }
          if (item.embedThumb) this.cleanupThumbs(item.file);
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
      } else if (!isTerminal(item.state)) {
        this.setState(item, STATE.FAILED);
        item.error = item.error || `yt-dlp exited with code ${code}`;
        this.cleanupPartials(item);
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
    // --force-overwrites only on a name the pre-flight verified free; unresolved
    // grabs and playlists lean on yt-dlp's own already-downloaded skip instead
    if (!item.playlist && item.vid) a.push('--force-overwrites');
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
