// Pure yt-dlp output parsing — no Electron imports so it is unit-testable.
const fs = require('fs');
const path = require('path');

const UNIT_BYTES = { KiB: 1024, MiB: 1048576, GiB: 1073741824 };

const fmtSpeed = (bytesPerSec) => `${(bytesPerSec / UNIT_BYTES.MiB).toFixed(2)} MB/s`;

const fmtSize = (bytes) => {
  const unit = bytes >= UNIT_BYTES.GiB ? 'GiB' : bytes >= UNIT_BYTES.MiB ? 'MiB' : 'KiB';
  return `${(bytes / UNIT_BYTES[unit]).toFixed(2)} ${unit}`;
};

// Windows-style duplicate name: returns a path that does not exist.
// "clip.mp4" taken -> "clip (1).mp4"; a free name comes back unchanged.
function nextFree(p) {
  if (!fs.existsSync(p)) return p;
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

// dotted version compare: true only when a is strictly newer than b
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

const ERRORS = [
  [/private video/i, 'Private video. Sign in if you have access.'],
  [/sign in to confirm|age.?restrict/i, 'YouTube wants a sign-in for this video (age or bot check).'],
  [/video unavailable/i, 'Video unavailable.'],
  [/not a valid URL|Unsupported URL/i, 'That does not look like a supported URL.'],
  [/requested format is not available/i, 'That quality is not available for this video. Try a lower one.'],
  [/unable to download webpage|getaddrinfo|timed out/i, 'Network error — check your connection.'],
  [/blocked it in your country/i, 'This video is blocked in your country.'],
];

function humanError(raw) {
  const msg = (raw || '').trim();
  const hit = ERRORS.find(([re]) => re.test(msg));
  return hit ? hit[1] : msg || 'Download failed.';
}

const { STATE } = require('./states');

const stripExt = (name) => name.replace(/\.[a-z0-9]+$/i, '');
const stripTitle = (file) => stripExt(path.basename(file)).replace(/\.f\d+$/i, '') || path.basename(file);

// Each rule mutates the item from one real yt-dlp line and returns the state
// the line moves it to (or null when the line only carries detail).
const LINE_RULES = [
  {
    re: /\[download\]\s+([\d.]+)% of\s+~?\s*([\d.]+)(KiB|MiB|GiB)(?: at\s+~?\s*([\d.]+)(KiB|MiB|GiB)\/s)?(?:\s+ETA (\S+))?/,
    phase: STATE.DOWNLOADING,
    apply(item, m) {
      item.progress = parseFloat(m[1]);
      item.size = `${m[2]} ${m[3]}`;
      item._totalBytes = parseFloat(m[2]) * (UNIT_BYTES[m[3]] || 1);
    },
  },
  {
    re: /\[download\] Destination: (.+)/,
    phase: STATE.DOWNLOADING,
    apply(item, m) {
      item.file = m[1].trim();
      item._partials = (item._partials || []).concat(item.file);
      item.title = stripTitle(item.file);
      item.progress = 0;
      item._totalBytes = 0;
      item._rate = null;
      item._sample = null;
    },
  },
  {
    re: /\[download\] (.+) has already been downloaded/,
    phase: null,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = stripTitle(item.file);
      item.progress = 100;
      item.skipped = true;
    },
  },
  {
    re: /\[(?:Merger|VideoRemuxer)\] Merging \S+ into "(.+)"/,
    phase: STATE.MUXING,
    apply(item, m) {
      item.file = m[1].trim();
      item.title = path.basename(item.file) || item.title;
    },
  },
  {
    re: /\[ExtractAudio\] Destination: (.+)/,
    phase: STATE.EXTRACTING,
    apply(item, m) {
      item.file = m[1].trim();
      // not a partial: this is the finished output a later stage must not delete
      item.title = stripTitle(item.file);
    },
  },
  {
    re: /\[ExtractAudio\] Not converting audio/,
    phase: STATE.EXTRACTING,
    apply(item) {},
  },
  {
    re: /\[(?:EmbedThumbnail|Metadata)\]/,
    phase: STATE.EMBEDDING,
    apply(item) {},
  },
  {
    // playlists restart per item: this line pulls the state back to downloading
    re: /\[download\] Downloading item (\d+) of (\d+)/,
    phase: STATE.DOWNLOADING,
    apply(item, m) {
      item.part = parseInt(m[1], 10);
      item.total = parseInt(m[2], 10);
      item.progress = 0;
      item._totalBytes = 0;
      item._rate = null;
      item._sample = null;
    },
  },
];

// returns the phase state the line moved the item to, or null
function applyLine(item, line) {
  for (const rule of LINE_RULES) {
    const m = line.match(rule.re);
    if (m) {
      rule.apply(item, m);
      return rule.phase;
    }
  }
  return null;
}

module.exports = {
  UNIT_BYTES,
  fmtSpeed,
  fmtSize,
  fmtEta,
  nextFree,
  stripStreamTag,
  isNewer,
  ERRORS,
  LINE_RULES,
  humanError,
  applyLine,
};
