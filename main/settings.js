const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  outDir: '',
  format: 'mp4',
  height: 0, // 0 = best available
  bitrate: 0, // 0 = best available (mp3 kbps otherwise)
  withAudio: true, // mp4 mode: mux audio into the video
  playlist: false,
  embedThumb: true,
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch {
      // first launch or unreadable file — defaults apply
    }
  }
  get() {
    return { ...this.data };
  }
  set(patch) {
    this.data = { ...this.data, ...patch };
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      // settings are best-effort; a write failure must not break a download
    }
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS };
