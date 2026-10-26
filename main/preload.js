const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  grab: (opts) => ipcRenderer.invoke('download:grab', opts),
  cancel: (id) => ipcRenderer.invoke('download:cancel', id),
  retry: (id) => ipcRenderer.invoke('download:retry', id),
  openFolder: (id) => ipcRenderer.invoke('download:openFolder', id),
  updateYtdlp: () => ipcRenderer.invoke('update:ytdlp'),
  ytdlpVersion: () => ipcRenderer.invoke('ytdlp:version'),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  onItems: (cb) => ipcRenderer.on('dl:items', (_e, items) => cb(items)),
  onLog: (cb) => ipcRenderer.on('dl:log', (_e, line) => cb(line)),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, flag) => cb(flag)),
});
