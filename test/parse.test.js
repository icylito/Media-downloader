'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyLine, humanError, nextFree, fmtSpeed, fmtSize, fmtEta, isNewer } = require('../main/parse');

// fresh item shaped like DownloadManager's
const item = () => ({ title: 'placeholder', progress: 0, part: 0, total: 0, _partials: [] });
/* ---------- formatters ---------- */

test('fmtSize picks the right unit', () => {
  assert.equal(fmtSize(1536), '1.50 KiB');
  assert.equal(fmtSize(3 * 1048576), '3.00 MiB');
  assert.equal(fmtSize(2.5 * 1073741824), '2.50 GiB');
});

test('fmtSpeed reports MB/s', () => {
  assert.equal(fmtSpeed(1.5 * 1048576), '1.50 MB/s');
});

test('fmtEta formats minutes and hours', () => {
  assert.equal(fmtEta(95), '1:35');
  assert.equal(fmtEta(3725), '1:02:05');
  assert.equal(fmtEta(-4), '0:00');
});

test('isNewer compares dotted versions strictly', () => {
  assert.equal(isNewer('2026.10.26', '2026.10.21'), true);
  assert.equal(isNewer('2026.10.26', '2026.10.26'), false);
  assert.equal(isNewer('2026.1', '2026.1.1'), false);
  assert.equal(isNewer('2026.1.1', '2026.1'), true);
});

/* ---------- nextFree ---------- */

test('nextFree walks the (n) ladder and leaves free names alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-parse-'));
  const clip = path.join(dir, 'clip.mp4');
  fs.writeFileSync(clip, 'x');
  fs.writeFileSync(path.join(dir, 'clip (1).mp4'), 'x');
  assert.equal(nextFree(clip), path.join(dir, 'clip (2).mp4'));
  const free = path.join(dir, 'other.mp4');
  assert.equal(nextFree(free), free);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- humanError ---------- */

test('humanError maps known yt-dlp errors to plain language', () => {
  assert.equal(humanError('ERROR: [youtube] dQw4: Private video. Sign in if you have been granted access to this video'), 'Private video. Sign in if you have access.');
  assert.equal(humanError('ERROR: Sign in to confirm you are not a bot'), 'YouTube wants a sign-in for this video (age or bot check).');
  assert.equal(humanError('ERROR: Unsupported URL: ftp://x'), 'That does not look like a supported URL.');
  assert.equal(humanError('ERROR: Requested format is not available'), 'That quality is not available for this video. Try a lower one.');
  assert.equal(humanError('ERROR: unable to download webpage'), 'Network error — check your connection.');
});

test('humanError passes unknown text through and never returns empty', () => {
  assert.equal(humanError('ERROR: something novel'), 'ERROR: something novel');
  assert.equal(humanError(''), 'Download failed.');
});

/* ---------- LINE_RULES (real captured yt-dlp lines) ---------- */

test('progress line fills percent, size and downloading phase', () => {
  const it = item();
  assert.equal(applyLine(it, '[download]  23.4% of   12.55MiB at    2.51MiB/s ETA 00:04'), 'downloading');
  assert.equal(it.progress, 23.4);
  assert.equal(it.size, '12.55 MiB');
  assert.equal(it._totalBytes, 12.55 * 1048576);
});

test('progress line without speed or ETA still parses', () => {
  const it = item();
  assert.equal(applyLine(it, '[download]   1.0% of    ~ 3.20GiB'), 'downloading');
  assert.equal(it.progress, 1.0);
  assert.equal(it.size, '3.20 GiB');
});

test('destination tracks the partial and strips the stream tag from the title', () => {
  const it = item();
  assert.equal(applyLine(it, '[download] Destination: C:/dl/Some title.f137.mp4'), 'downloading');
  assert.equal(it.file, 'C:/dl/Some title.f137.mp4');
  assert.ok(it._partials.includes('C:/dl/Some title.f137.mp4'));
  assert.equal(it.title, 'Some title');
});

test('playlist position restarts the download state for the next item', () => {
  const it = item();
  assert.equal(applyLine(it, '[download] Downloading item 2 of 5'), 'downloading');
  assert.equal(it.part, 2);
  assert.equal(it.total, 5);
  applyLine(it, '[download] Destination: C:/dl/Song A.f137.mp4');
  applyLine(it, '[download] Destination: C:/dl/Song A.f251.webm');
  assert.equal(it.part, 2); // unchanged by the second stream destination
});

test('already-downloaded line flags the skip without leaving the state machine', () => {
  const it = item();
  assert.equal(applyLine(it, '[download] C:/dl/Me at the zoo.mp4 has already been downloaded'), null);
  assert.equal(it.skipped, true);
  assert.equal(it.progress, 100);
  assert.equal(it.title, 'Me at the zoo');
});

test('merger line captures the final file and moves to muxing', () => {
  const it = item();
  assert.equal(applyLine(it, '[Merger] Merging formats into "C:/dl/Me at the zoo.mp4"'), 'muxing');
  assert.equal(it.file, 'C:/dl/Me at the zoo.mp4');
});

test('audio extraction strips the extension from the title', () => {
  const it = item();
  assert.equal(applyLine(it, '[ExtractAudio] Destination: C:/dl/Song.mp3'), 'extracting');
  assert.equal(it.file, 'C:/dl/Song.mp3');
  assert.equal(it.title, 'Song');
});

test('thumbnail and metadata lines move to embedding', () => {
  const it = item();
  assert.equal(applyLine(it, '[EmbedThumbnail] mp4: embedding thumbnail'), 'embedding');
});

test('no-conversion audio still reports extracting', () => {
  const it = item();
  assert.equal(applyLine(it, '[ExtractAudio] Not converting audio'), 'extracting');
});

test('unknown lines are not consumed', () => {
  assert.equal(applyLine(item(), '[info] 1234fps available'), null);
  assert.equal(applyLine(item(), 'random garbage'), null);
});
