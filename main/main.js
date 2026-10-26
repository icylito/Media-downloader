const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { getBinaries } = require('./binaries');
const { Settings } = require('./settings');
const { DownloadManager } = require('./download-manager');

let win = null;
let manager = null;
let settings = null;
let bins = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  bins = getBinaries();
  settings = new Settings(app.getPath('userData'));
  if (!settings.get().outDir) {
    settings.set({ outDir: app.getPath('downloads') });
  }

  manager = new DownloadManager({
    ytDlp: bins.ytDlp,
    ffmpegDir: bins.ffmpegDir,
    outDir: settings.get().outDir,
    onItems: (items) => send('dl:items', items),
    onLog: (line) => send('dl:log', line),
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = settings.set(patch);
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
    const s = settings.get();
    manager.grab({
      url: String(opts.url || '').trim(),
      mode: opts.mode || s.format,
      height: opts.height ?? s.height,
      playlist: opts.playlist ?? s.playlist,
      embedThumb: opts.embedThumb ?? s.embedThumb,
    });
  });
  ipcMain.handle('download:cancel', (_e, id) => manager.cancel(id));
  ipcMain.handle('download:retry', (_e, id) => manager.retry(id));
  ipcMain.handle('download:openFolder', (_e, id) => {
    const item = manager.snapshot().find((x) => x.id === id);
    if (item && item.file) shell.showItemInFolder(item.file);
    else shell.openPath(settings.get().outDir);
  });
  ipcMain.handle('ytdlp:version', async () => {
    return new Promise((resolve) => {
      const proc = spawn(bins.ytDlp, ['--version'], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => (out += String(d)));
      proc.on('close', () => resolve(out.trim()));
      proc.on('error', () => resolve(''));
    });
  });
  ipcMain.handle('update:ytdlp', async () => {
    return new Promise((resolve) => {
      const proc = spawn(bins.ytDlp, ['-U'], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', (d) => {
        out += String(d);
      });
      proc.stderr.on('data', (d) => {
        out += String(d);
      });
      proc.on('close', (code) => {
        const lines = out.split(/\r?\n/).filter((l) => l.trim());
        resolve({ ok: code === 0, message: lines.slice(-3).join(' ') || (code === 0 ? 'Up to date.' : 'Update failed.') });
      });
    });
  });
  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
