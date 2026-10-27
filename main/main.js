const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { getBinaries } = require('./binaries');
const { Settings } = require('./settings');
const { DownloadManager } = require('./download-manager');
const { isNewer } = require('./parse');
const { isActive } = require('./states');

const APP_NAME = 'Media downloader';

let win = null;
let tray = null;
let manager = null;
let settings = null;
let bins = null;
let isQuitting = false;
let trayBalloonShown = false;
const rowStates = new Map();

// the app was renamed from "Media-downloader" to "Media downloader", which moved
// the userData folder — carry settings and the download index across once
function migrateOldUserData() {
  const dir = app.getPath('userData');
  const old = path.join(path.dirname(dir), 'Media-downloader');
  if (!fs.existsSync(old)) return;
  for (const file of ['settings.json', 'download-index.json']) {
    const from = path.join(old, file);
    const to = path.join(dir, file);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    } catch {
      // migration is best-effort — a fresh profile beats a crashed launch
    }
  }
}

function balloon(title, content) {
  try {
    tray?.displayBalloon({ title, content });
  } catch {
    // tray can be gone during teardown
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (channel !== 'dl:items' || !Array.isArray(payload)) return;
  for (const it of payload) {
    if (isActive(rowStates.get(it.id)) && it.state === 'done' && (!win || win.isDestroyed() || !win.isVisible())) {
      balloon('Download complete', it.title);
    }
    rowStates.set(it.id, it.state);
  }
  for (const id of rowStates.keys()) {
    if (!payload.some((it) => it.id === id)) rowStates.delete(id);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#090D14',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  // closing mid-download hides to the tray so the download finishes
  win.on('close', (e) => {
    if (!isQuitting && manager && manager.hasActive()) {
      e.preventDefault();
      win.hide();
      if (!trayBalloonShown) {
        trayBalloonShown = true;
        balloon(APP_NAME, 'Still downloading. The app keeps running in the tray.');
      }
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

const YTDLPCHECK = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

function ytdlpVersion() {
  return new Promise((resolve) => {
    const proc = spawn(bins.ytDlp, ['--version'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => (out += String(d)));
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(out.trim()));
  });
}

async function checkYtdlpUpdate() {
  const current = await ytdlpVersion();
  let latest = null;
  try {
    const res = await fetch(YTDLPCHECK, { headers: { 'User-Agent': APP_NAME } });
    if (res.ok) latest = ((await res.json()).tag_name || '').replace(/^v/, '') || null;
  } catch {
    // offline — the button just stays quiet
  }
  const update = { current, latest, available: !!(current && latest && isNewer(latest, current)) };
  send('ytdlp:update', update);
  return update;
}

const MODES = ['mp4', 'mp3', 'flac', 'opus'];
const HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360, 240, 144];
const BITRATES = [0, 320, 256, 192, 128, 96];

// number coercion that cannot throw, whatever the renderer passes
function safeInt(v) {
  try {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string') return parseInt(v, 10);
    return NaN;
  } catch {
    return NaN;
  }
}

// the renderer is treated as untrusted input: unknown modes, throwing
// toStrings or nonsense numbers fall back to stored settings instead of throwing
function sanitizeGrabOpts(opts) {
  const s = settings.get();
  const o = opts || {};
  const ladder = (v, ladder, fallback) => {
    const n = safeInt(v);
    return ladder.includes(n) ? n : ladder.includes(fallback) ? fallback : 0;
  };
  return {
    url: typeof o.url === 'string' ? o.url.trim().slice(0, 2000) : '',
    mode: MODES.includes(o.mode) ? o.mode : s.format,
    height: ladder(o.height, HEIGHTS, s.height),
    bitrate: ladder(o.bitrate, BITRATES, s.bitrate),
    withAudio: typeof o.withAudio === 'boolean' ? o.withAudio : s.withAudio,
    playlist: typeof o.playlist === 'boolean' ? o.playlist : s.playlist,
    embedThumb: typeof o.embedThumb === 'boolean' ? o.embedThumb : s.embedThumb,
  };
}

// settings:set is also renderer-fed — only known keys with sane values pass
function sanitizeSettingsPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object') return clean;
  if (typeof patch.outDir === 'string') {
    const dir = patch.outDir.trim();
    if (dir && path.isAbsolute(dir) && dir.length < 500) clean.outDir = dir;
  }
  if (MODES.includes(patch.format)) clean.format = patch.format;
  if (patch.height !== undefined && HEIGHTS.includes(safeInt(patch.height))) clean.height = safeInt(patch.height);
  if (patch.bitrate !== undefined && BITRATES.includes(safeInt(patch.bitrate))) clean.bitrate = safeInt(patch.bitrate);
  for (const key of ['withAudio', 'playlist', 'embedThumb']) {
    if (typeof patch[key] === 'boolean') clean[key] = patch[key];
  }
  return clean;
}

app.whenReady().then(() => {
  app.setAccessibilitySupportEnabled(true);
  migrateOldUserData();
  bins = getBinaries();
  settings = new Settings(app.getPath('userData'));
  if (!settings.get().outDir) {
    settings.set({ outDir: app.getPath('downloads') });
  }

  manager = new DownloadManager({
    ytDlp: bins.ytDlp,
    ffmpegDir: bins.ffmpegDir,
    outDir: settings.get().outDir,
    stateDir: app.getPath('userData'),
    onItems: (items) => send('dl:items', items),
    onLog: (line) => send('dl:log', line),
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.set(sanitizeSettingsPatch(patch));
    manager.setOutDir(next.outDir);
    return next;
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get().outDir,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = res.filePaths[0];
    settings.set({ outDir: dir });
    manager.setOutDir(dir);
    return dir;
  });
  ipcMain.handle('download:grab', (_e, opts) => {
    const clean = sanitizeGrabOpts(opts);
    if (clean.url) manager.grab(clean);
  });
  ipcMain.handle('download:cancel', (_e, id) => manager.cancel(String(id)));
  ipcMain.handle('download:retry', (_e, id) => manager.retry(String(id)));
  ipcMain.handle('download:openFolder', (_e, id) => {
    const item = manager.snapshot().find((x) => x.id === id);
    if (item && item.file) shell.showItemInFolder(item.file);
    else shell.openPath(settings.get().outDir);
  });
  ipcMain.handle('ytdlp:version', () => ytdlpVersion());
  ipcMain.handle('update:check', () => checkYtdlpUpdate());
  ipcMain.handle('update:ytdlp', async () => {
    const fail = await new Promise((resolve) => {
      const proc = spawn(bins.ytDlp, ['-U'], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.stderr.on('data', (d) => (out += String(d)));
      proc.on('error', (e) => resolve(String(e)));
      proc.on('close', (code) => resolve(code === 0 ? '' : out.trim() || 'Update failed.'));
    });
    await checkYtdlpUpdate();
    if (fail && app.isPackaged) {
      return { ok: false, message: 'Update failed. The installed build cannot update in place; use the Portable build or reinstall.' };
    }
    return { ok: !fail, message: fail || 'Up to date.' };
  });
  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());

  createWindow();
  createTray();
  win.webContents.on('did-finish-load', () => checkYtdlpUpdate());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// quitting while a download runs: kill the process tree and clean partials first
app.on('before-quit', (e) => {
  if (isQuitting || !manager || !manager.hasActive()) return;
  e.preventDefault();
  isQuitting = true;
  manager.quitCleanup(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});
