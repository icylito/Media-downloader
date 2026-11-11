# Media Downloader

Hey. This is the Windows app that grabs a YouTube video, or just the audio, and saves it in the folder you picked.

Want the app, not the source? Get **Setup** or **Portable** from [Releases](https://github.com/icylito/Media-downloader/releases). Open it, paste a link, pick a format, hit download. SmartScreen may complain once. The exe is unsigned. That is normal.

Close the window while something is downloading and it keeps going in the tray. If YouTube changes and a grab fails, the yt-dlp update is in the app (bottom left). It needs a writable install, so dev and Portable are fine. The Setup build tells you if the write fails.

What it saves: MP4 from 144p up to 4K, audio as MP3 320k, Opus, or FLAC, and a video-only toggle when you want a silent clip. Progress shows speed and ETA. 4K and 1080p often arrive as VP9 or AV1 in WebM. A normal player opens that.

## If you are building it

Node 22+, npm, Windows 10/11 64-bit. yt-dlp and ffmpeg are not in git. Put these in `resources/` once:

| File | From | Tested with |
|---|---|---|
| `yt-dlp.exe` | [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) | 2026.10.26 |
| `ffmpeg.exe` | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) essentials build | 9.0.2 |
| `ffprobe.exe` | same zip as ffmpeg | 9.0.2 |

Any recent build is fine. The app only uses stable flags.

```bash
npm install
npm start        # dev
npm test         # parser unit tests
npm run dist     # installers in dist/
```

Publishing is a tag push. Actions builds both installers on a Windows runner and publishes the release (`.github/workflows/release.yml`). A local build never publishes.

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

One download is one yt-dlp process. The window talks to the main process over IPC (contextIsolation on, preload bridge, input sanitized on every handler). `main/download-manager.js` runs the job through the state machine in `main/states.js` (queued, checking library, downloading, muxing or extracting or embedding, then done, with skipped, canceled, and failed as terminals). Format selectors are `bv*[height<=H]+ba` for video and `-x --audio-format` for audio. `main/parse.js` reads the `--newline` output. Cancel and quit kill the yt-dlp tree and delete partial files.

Before each download the manager does a quiet `--simulate` pass to get the filename. Same video id, format, and quality already on disk (tracked in `download-index.json` under userData) means skip. Same name, different content, gets a Windows-style `(1)` suffix.

| Path | What lives there |
|---|---|
| `main/main.js` | Window, tray, single instance, IPC, input sanitization |
| `main/download-manager.js` | Download lifecycle, duplicate index, partial-file cleanup |
| `main/states.js` | The state machine |
| `main/parse.js` | yt-dlp output parser (unit-tested) |
| `main/settings.js` | `userData/settings.json` |
| `main/preload.js` | contextBridge API |
| `renderer/` | HTML/CSS/JS, no framework, CSP blocks inline styles |
| `test/` | `node --test` for the parser and state machine |
| `scripts/qa-cdp.mjs` | Dev-only QA harness over CDP |
| `resources/` | The three exes above (gitignored) |

Personal use. YouTube's rules still apply to what you download. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
