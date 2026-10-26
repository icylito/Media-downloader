# Media Downloader

Grab any YouTube video or track in seconds — a clean desktop app with zero setup.

## Features

- 🎬 MP4 downloads from 144p up to 4K
- 🎧 Audio as MP3, FLAC, or Opus
- 📦 yt-dlp bundled — clone it and it just runs
- 🪟 Native Windows desktop app

## Screenshots

_Coming soon._

## Run it

```bash
git clone https://github.com/icylito/Media-downloader.git
cd Media-downloader
npm install
npm start
```

Plug and play — the yt-dlp binary ships in `resources/`, so a clone is all you need.

## How it's wired

| Folder | What it does |
|---|---|
| `main/` | Electron main process — runs the download engine |
| `renderer/` | The interface you see |
| `resources/` | Bundled yt-dlp binary, ready at runtime |

## Fair use

For personal use only — downloading YouTube content can violate YouTube's Terms of Service, so use it responsibly. Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
