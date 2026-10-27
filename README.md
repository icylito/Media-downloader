# Media Downloader

A Windows desktop app that downloads YouTube video and audio. Electron shell, plain JavaScript, yt-dlp and ffmpeg bundled at runtime.

**Just want the app?** Grab an exe from [Releases](https://github.com/icylito/Media-downloader/releases): the Setup installer or the Portable build. No Node, no npm.

## Features

- MP4 from 144p up to 4K (2160p)
- Audio as MP3 320k, bit-perfect Opus, or lossless FLAC
- Video-only toggle for silent clips
- Live progress with smoothed speed and ETA
- In-app yt-dlp update check, one click to install
- Closes to the tray while a download runs and finishes it there

## Build from source

### Requirements

- Node.js 22+ and npm
- Windows 10/11 64-bit

### Native binaries

yt-dlp and ffmpeg do the downloading. They are not tracked in git, so fetch them once into `resources/`:

| File | From | Tested with |
|---|---|---|
| `yt-dlp.exe` | [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) | 2026.10.26 |
| `ffmpeg.exe` | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) essentials build | 9.0.2 |
| `ffprobe.exe` | same zip as ffmpeg | 9.0.2 |

Any recent build works; the app calls them with stable flags only.

### Run and build

```bash
npm install
npm start        # dev
npm test         # parser unit tests
npm run dist     # build installers into dist/
```

### Release

Publishing is a tag push. GitHub Actions builds the installers and publishes the release:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

GitHub Actions builds both installers on a Windows runner and publishes the release (see `.github/workflows/release.yml`). Local builds never publish.

## How it works

One download is one yt-dlp process. The renderer talks to the main process over IPC (contextIsolation on, preload bridge; renderer input is sanitized on every handler). `main/download-manager.js` owns the download lifecycle through the state machine in `main/states.js` (queued → checking library → downloading → muxing/extracting/embedding → done, with skipped/canceled/failed terminals and guarded transitions), spawns the bundled yt-dlp with format selectors (`bv*[height<=H]+ba` for video, `-x --audio-format` for audio), and `main/parse.js` turns the `--newline` output into progress. Cancellation and quitting kill the yt-dlp tree and remove partial files.

Duplicate handling: before every single download the manager runs a silent `--simulate` pass to resolve the target filename. If a file with the same video id, format, and quality is already on disk (tracked in `download-index.json` under the app's userData folder), the grab skips. If the name is taken by different content, the new file gets a Windows-style `(1)` suffix.

## Layout

| Path | What lives there |
|---|---|
| `main/main.js` | Window, tray, single instance, IPC handlers, input sanitization |
| `main/download-manager.js` | Download lifecycle, duplicate index, partial-file cleanup |
| `main/states.js` | The state machine every download moves through |
| `main/parse.js` | Pure yt-dlp output parser (unit-tested) |
| `main/settings.js` | Persisted settings (`userData/settings.json`) |
| `main/preload.js` | contextBridge API |
| `renderer/` | Plain HTML/CSS/JS, no framework, CSP forbids inline styles |
| `test/` | `node --test` suite for the parser and state machine |
| `scripts/qa-cdp.mjs` | Dev-only QA harness that drives the app over CDP |
| `resources/` | The three exes above (gitignored) |

## Good to know

- Executables are not code signed. Windows SmartScreen may ask for confirmation on first run.
- 4K and 1080p streams use VP9 or AV1 video in a WebM container. Modern players open it natively.
- yt-dlp updates from inside the app (pill in the bottom left) or by swapping `resources/yt-dlp.exe`. The in-place update needs a writable install location, so it works in dev and Portable builds; the Setup install explains itself if the write fails.
- Closing the window while a download runs hides the app to the tray and the download finishes there. Quitting from the tray cancels the active download and removes its partial files.

## Fair use

Personal use only. Downloading YouTube content can violate YouTube's Terms of Service, so use it responsibly. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
