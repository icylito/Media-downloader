const { app } = require('electron');
const path = require('path');

// Bundled binaries live in resources/ during development and
// resources/binaries/ inside the packaged app (extraResources mapping).
function getBinaries() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'binaries')
    : path.join(__dirname, '..', 'resources');
  return {
    ytDlp: path.join(base, 'yt-dlp.exe'),
    ffmpegDir: base,
  };
}

module.exports = { getBinaries };
