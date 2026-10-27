/* Media downloader renderer — talks to the main process through window.api */
const $ = (id) => document.getElementById(id);

const QUALITY_OPTIONS = {
  mp4: [
    { v: 0, label: 'Best available' },
    { v: 2160, label: '4K · 2160p' },
    { v: 1440, label: '1440p' },
    { v: 1080, label: '1080p' },
    { v: 720, label: '720p' },
    { v: 480, label: '480p' },
    { v: 360, label: '360p' },
    { v: 240, label: '240p' },
    { v: 144, label: '144p' },
  ],
  mp3: [
    { v: 0, label: 'Best available' },
    { v: 320, label: '320 kbps' },
    { v: 256, label: '256 kbps' },
    { v: 192, label: '192 kbps' },
    { v: 128, label: '128 kbps' },
    { v: 96, label: '96 kbps' },
  ],
  flac: [{ v: 0, label: 'Lossless' }],
  opus: [{ v: 0, label: 'Best (Opus copy)' }],
};

const MODE_ICONS = {
  mp4: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5l5 2.5-5 2.5z"/></svg>',
  mp3: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
  flac: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
  opus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l2-6 3 12 2.5-8 1.5 4h6"/></svg>',
};
const MODE_BADGE = { mp4: 'MP4', mp3: 'MP3', flac: 'FLAC', opus: 'Opus' };

// mirrors main/states.js — presentation for every state the manager can send
const STATE_VIEW = {
  queued: { chip: 'Queued', kind: 'pending' },
  resolving: { chip: 'Fetching info…', kind: 'active' },
  downloading: { chip: 'Downloading', kind: 'active' },
  muxing: { chip: 'Merging video and audio', kind: 'active' },
  extracting: { chip: 'Processing audio…', kind: 'active' },
  embedding: { chip: 'Adding thumbnail…', kind: 'active' },
  done: { chip: 'Done', kind: 'ok' },
  skipped: { chip: 'Already downloaded', kind: 'ok' },
  canceling: { chip: 'Canceling…', kind: 'active' },
  canceled: { chip: 'Canceled', kind: 'error' },
  failed: { chip: 'Failed', kind: 'error' },
};

let settings = null;
let items = [];
let logOpen = false;
const logLines = [];

/* ---------- titlebar ---------- */
$('btn-min').addEventListener('click', () => window.api.minimize());
$('btn-max').addEventListener('click', () => window.api.maximize());
$('btn-close').addEventListener('click', () => window.api.close());

/* ---------- format / quality ---------- */
function currentMode() {
  const active = document.querySelector('.chip[data-mode][aria-pressed="true"]');
  return active ? active.dataset.mode : 'mp4';
}

function fillQuality(mode) {
  const sel = $('quality');
  sel.innerHTML = '';
  (QUALITY_OPTIONS[mode] || QUALITY_OPTIONS.mp4).forEach((o) => {
    const opt = document.createElement('option');
    opt.value = String(o.v);
    opt.textContent = o.label;
    sel.appendChild(opt);
  });
}

// remember each mode's quality so switching MP4 -> MP3 -> MP4 doesn't reset it
const lastQuality = {};

function qualityValue(mode) {
  if (lastQuality[mode]) return lastQuality[mode];
  return mode === 'mp4' ? '0' : String(QUALITY_OPTIONS[mode][0].v);
}

document.querySelectorAll('.chip[data-mode]').forEach((chip) => {
  chip.addEventListener('click', async () => {
    const prev = $('quality').value;
    if (prev) lastQuality[currentMode()] = prev;
    document.querySelectorAll('.chip[data-mode]').forEach((c) => c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'));
    const mode = chip.dataset.mode;
    const q = parseInt(qualityValue(mode), 10) || 0;
    fillQuality(mode);
    $('quality').value = qualityValue(mode);
    $('btn-audio').hidden = mode !== 'mp4';
    // persist the switch without zeroing the other mode's saved quality
    const patch = { format: mode };
    if (mode === 'mp4') patch.height = q;
    if (mode === 'mp3') patch.bitrate = q;
    settings = await window.api.setSettings(patch);
  });
});

$('btn-audio').addEventListener('click', async () => {
  const on = $('btn-audio').getAttribute('aria-pressed') === 'true';
  $('btn-audio').setAttribute('aria-pressed', on ? 'false' : 'true');
  settings = await window.api.setSettings({ withAudio: !on });
});

$('quality').addEventListener('change', async () => {
  const mode = currentMode();
  const v = parseInt($('quality').value, 10) || 0;
  // each mode persists only its own quality field
  settings = await window.api.setSettings(mode === 'mp4' ? { height: v } : { bitrate: v });
});

/* ---------- grab ---------- */
function readOpts() {
  const mode = currentMode();
  return {
    url: $('url').value.trim(),
    mode,
    height: mode === 'mp4' ? parseInt($('quality').value, 10) || 0 : 0,
    bitrate: mode === 'mp3' ? parseInt($('quality').value, 10) || 0 : 0,
    withAudio: mode === 'mp4' ? $('btn-audio').getAttribute('aria-pressed') === 'true' : true,
    playlist: $('btn-playlist').getAttribute('aria-pressed') === 'true',
    embedThumb: settings ? settings.embedThumb : true,
  };
}

$('btn-grab').addEventListener('click', () => {
  const opts = readOpts();
  if (!opts.url) {
    $('url').focus();
    return;
  }
  const patch = { format: opts.mode, playlist: opts.playlist };
  if (opts.mode === 'mp4') patch.height = opts.height;
  if (opts.mode === 'mp3') patch.bitrate = opts.bitrate;
  window.api.setSettings(patch);
  window.api.grab(opts);
  $('url').value = '';
});

$('btn-paste').addEventListener('click', pasteClipboard);

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $('url').value = text.trim();
      $('url').focus();
    }
  } catch {
    $('url').focus();
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && document.activeElement !== $('url')) {
    pasteClipboard();
  }
});

/* ---------- playlist / settings popover ---------- */
$('btn-playlist').addEventListener('click', async () => {
  const on = $('btn-playlist').getAttribute('aria-pressed') === 'true';
  $('btn-playlist').setAttribute('aria-pressed', on ? 'false' : 'true');
  settings = await window.api.setSettings({ playlist: !on });
  syncPopover();
});

$('btn-settings').addEventListener('click', () => {
  const pop = $('popover');
  const open = pop.hidden;
  pop.hidden = !open;
  $('btn-settings').classList.toggle('on', open);
  $('btn-settings').setAttribute('aria-expanded', String(open));
});

function closePopover() {
  $('popover').hidden = true;
  $('btn-settings').classList.remove('on');
  $('btn-settings').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  const pop = $('popover');
  if (pop.hidden) return;
  if (pop.contains(e.target) || $('btn-settings').contains(e.target)) return;
  closePopover();
});

// Escape walks out one layer at a time: popover first, then the log drawer
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('popover').hidden) {
    closePopover();
    $('btn-settings').focus();
    return;
  }
  if (logOpen) setLogOpen(false);
});

function syncPopover() {
  if (!settings) return;
  $('pop-folder-path').textContent = settings.outDir;
  $('sw-playlist').classList.toggle('on', !!settings.playlist);
  $('sw-embed').classList.toggle('on', !!settings.embedThumb);
  $('btn-playlist').setAttribute('aria-pressed', settings.playlist ? 'true' : 'false');
}

$('pop-folder').addEventListener('click', async () => {
  const dir = await window.api.pickFolder();
  if (dir) {
    settings = { ...settings, outDir: dir };
    $('outdir-label').textContent = shorten(dir);
    syncPopover();
  }
});
$('pop-playlist').addEventListener('click', async () => {
  settings = await window.api.setSettings({ playlist: !settings.playlist });
  syncPopover();
});
$('pop-embed').addEventListener('click', async () => {
  settings = await window.api.setSettings({ embedThumb: !settings.embedThumb });
  syncPopover();
});
$('pop-log').addEventListener('click', () => {
  setLogOpen(true);
  closePopover();
});

/* ---------- log drawer ---------- */
function setLogOpen(open) {
  logOpen = open;
  $('log').hidden = !open;
}
$('strip-log').addEventListener('click', () => setLogOpen(!logOpen));

/* ---------- yt-dlp update (bottom-left) ---------- */
let updateInfo = null;
let updateBusy = null;

function renderUpdate() {
  const btn = $('strip-update');
  const label = $('strip-update-text');
  if (updateBusy) {
    btn.dataset.state = updateBusy;
    label.textContent = updateBusy === 'installing' ? 'Updating yt-dlp…' : 'Checking yt-dlp…';
    return;
  }
  if (updateInfo?.available) {
    btn.dataset.state = 'available';
    label.textContent = `Update yt-dlp → ${updateInfo.latest}`;
    btn.dataset.tip = `yt-dlp ${updateInfo.current} installed · ${updateInfo.latest} available`;
  } else {
    btn.dataset.state = 'idle';
    label.textContent = `yt-dlp ${updateInfo?.current || '…'}`;
    btn.dataset.tip = 'Check for yt-dlp updates';
  }
}

window.api.onYtdlpUpdate((info) => {
  updateInfo = info;
  renderUpdate();
});

$('strip-update').addEventListener('click', async () => {
  if (updateBusy) return;
  if (updateInfo?.available) {
    updateBusy = 'installing';
    renderUpdate();
    const res = await window.api.updateYtdlp();
    updateBusy = res.ok ? null : 'failed';
    if (!res.ok) {
      renderUpdate();
      $('strip-update').dataset.tip = res.message;
      setTimeout(() => {
        updateBusy = null;
        renderUpdate();
      }, 5000);
      return;
    }
    renderUpdate();
  } else {
    updateBusy = 'checking';
    renderUpdate();
    updateInfo = await window.api.checkYtdlpUpdate();
    updateBusy = null;
    renderUpdate();
  }
});

/* ---------- items rendering ---------- */
function shorten(p) {
  if (!p) return '…';
  const parts = p.split(/[\\/]/);
  return parts.length > 3 ? parts.slice(-3).join('\\') : p;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rowThumb(mode, state) {
  const view = STATE_VIEW[state] || STATE_VIEW.failed;
  const cls = view.kind === 'error' ? 'row-thumb err' : view.kind === 'pending' ? 'row-thumb dim' : mode === 'mp4' ? 'row-thumb' : 'row-thumb audio';
  const icon = view.kind === 'error'
    ? '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'
    : MODE_ICONS[mode] || MODE_ICONS.mp4;
  return `<span class="${cls}">${icon}</span>`;
}

function render() {
  const list = $('list');
  const empty = $('empty');
  list.hidden = items.length === 0;
  empty.style.display = items.length ? 'none' : 'flex';

  list.innerHTML = items
    .map((it) => {
      const view = STATE_VIEW[it.state] || STATE_VIEW.failed;
      const meta = [];
      if (view.kind === 'active' || view.kind === 'ok') {
        const h = it.actualHeight || it.height;
        if (h) meta.push(`${h >= 2160 ? '4K' : h + 'p'}`);
        meta.push(MODE_BADGE[it.mode] || it.mode);
        if (it.noAudio) meta.push('no audio');
        if (it.total) meta.push(view.kind === 'ok' ? `Playlist · ${it.total} items` : `Item ${it.part} of ${it.total}`);
      }
      let statusHtml = '';
      if (view.kind === 'active') {
        if (it.state !== 'downloading') meta.unshift(view.chip);
        meta.push(
          `${it.progress.toFixed(0)}%${it.speed ? ' · ' + it.speed : ''}${it.eta ? ' · ' + it.eta + ' left' : ''}`,
        );
        statusHtml = `<span class="badge">${MODE_BADGE[it.mode] || ''}</span>
          <button class="ibtn" data-act="cancel" data-id="${it.id}" data-tip="Cancel" aria-label="Cancel download">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
          </button>`;
      } else if (view.kind === 'ok') {
        if (it.state !== 'skipped' && !it.skipped) meta.push(it.size || '');
        const chipText = it.state === 'skipped' || it.skipped ? STATE_VIEW.skipped.chip : view.chip;
        statusHtml = `<span class="state ok"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>${chipText}</span>
          <button class="ibtn" data-act="open" data-id="${it.id}" data-tip="Open folder" aria-label="Open folder">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 8h18l-1.5 10a2 2 0 0 1-2 1.7H6.5a2 2 0 0 1-2-1.7z"/></svg>
          </button>`;
      } else if (view.kind === 'error') {
        statusHtml = `<button class="ghostbtn err" data-act="retry" data-id="${it.id}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>Retry
          </button>`;
      } else {
        statusHtml = `<span class="state">${view.chip}</span>`;
      }

      const bar =
        it.state === 'downloading' || it.state === 'canceling'
          ? `<div class="bar"><i data-w="${Math.max(2, it.progress)}"></i></div>`
          : '';
      const errMeta =
        view.kind === 'error' ? `<span class="row-meta err">${esc(it.error || view.chip)}</span>` : '';
      const dim = view.kind === 'pending' ? ' dimmed' : '';

      return `<div class="row${dim}">
        ${rowThumb(it.mode, it.state)}
        <div class="row-main">
          <span class="row-title">${esc(it.title)}</span>
          ${errMeta || `<span class="row-meta">${meta.filter(Boolean).map(esc).join('<span class="sep">·</span>')}</span>`}
          ${bar}
        </div>
        <div class="row-side">${statusHtml}</div>
      </div>`;
    })
    .join('');

  // widths go through CSSOM — the CSP forbids inline style attributes
  list.querySelectorAll('.bar i').forEach((el) => {
    el.style.width = `${el.dataset.w}%`;
  });

  renderStrip();
}

function renderStrip() {
  const active = items.find((x) => STATE_VIEW[x.state]?.kind === 'active');
  const text = $('strip-text');
  const track = $('strip-track');
  const fill = $('strip-fill');
  const cancel = $('strip-cancel');
  if (active) {
    text.textContent = `${active.title} · ${active.progress.toFixed(0)}%${active.speed ? ' · ' + active.speed : ''}${active.eta ? ' · ' + active.eta + ' left' : ''}`;
    track.hidden = false;
    fill.style.width = `${Math.max(2, active.progress)}%`;
    cancel.hidden = false;
  } else {
    text.textContent = items.length ? 'Idle' : 'Ready';
    track.hidden = true;
    cancel.hidden = true;
  }
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'cancel') window.api.cancel(id);
  if (act === 'retry') window.api.retry(id);
  if (act === 'open') window.api.openFolder(id);
});

$('strip-cancel').addEventListener('click', () => {
  const active = items.find((x) => STATE_VIEW[x.state]?.kind === 'active');
  if (active) window.api.cancel(active.id);
});

/* ---------- events from main ---------- */
window.api.onItems((next) => {
  items = next;
  render();
});

window.api.onLog((line) => {
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  const box = $('log-lines');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.textContent = logLines.join('\n');
  if (atBottom) $('log').scrollTop = $('log').scrollHeight;
});

window.api.onMaximized((flag) => {
  $('btn-max').setAttribute('aria-label', flag ? 'Restore' : 'Maximize');
  $('btn-max').innerHTML = flag
    ? '<svg viewBox="0 0 24 24"><path d="M9 6.5h9A1.5 1.5 0 0 1 19.5 8v9"/><rect x="4.5" y="9" width="10.5" height="10.5" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
});

/* ---------- boot ---------- */
(async () => {
  settings = await window.api.getSettings();
  $('outdir-label').textContent = shorten(settings.outDir);
  renderUpdate();
  // each mode remembers its own quality
  if (settings.height) lastQuality.mp4 = String(settings.height);
  if (settings.format === 'mp3' && settings.bitrate) lastQuality.mp3 = String(settings.bitrate);
  document.querySelector(`.chip[data-mode="${settings.format}"]`)?.click();
  if (settings.format !== 'mp4') {
    // .click() already persisted; just make sure UI matches
    document.querySelectorAll('.chip[data-mode]').forEach((c) => c.setAttribute('aria-pressed', c.dataset.mode === settings.format ? 'true' : 'false'));
    fillQuality(settings.format);
  }
  if (!$('quality').value) $('quality').value = qualityValue(settings.format);
  $('btn-audio').setAttribute('aria-pressed', settings.withAudio === false ? 'false' : 'true');
  syncPopover();
  render();
})();
