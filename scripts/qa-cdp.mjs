/*
 * QA harness — drives the real renderer over the Chrome DevTools Protocol.
 *   node scripts/qa-cdp.mjs round1   normal end-to-end pass, every feature once
 *   node scripts/qa-cdp.mjs round2   adversarial pass: hostile opts, filesystem
 *                                    sabotage, corrupt state, tray lifecycle
 * Round 2 also attaches to the main process inspector to exercise the real
 * quit path. Exits nonzero when any vector fails.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(os.tmpdir(), `md-qa-${Date.now()}`);
const RDR_PORT = 9222;
const MAIN_PORT = 9229;
// dev userData: package.json "name", case-insensitive on Windows
const USER_DATA = path.join(process.env.APPDATA, 'media-downloader');
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const BBB = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const DEAD = 'https://www.youtube.com/watch?v=_________-___';
const ANY_MEDIA = /\.(mp4|webm|mkv|mp3|m4a|opus|flac)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.onTimeout?.(`CDP timeout: ${method}: ${String(params.expression || '').slice(0, 120)}`);
          reject(new Error(`CDP timeout: ${method}: ${String(params.expression || '').slice(0, 120)}`));
        }
      }, 45000);
    });
  }
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description || '')}`);
    }
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

function getJson(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

async function connect(port, titleMatch, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const targets = await getJson(port);
      const t = targets.find((x) => x.webSocketDebuggerUrl && x.title?.includes(titleMatch));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        return new Cdp(ws);
      }
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`no CDP target matching "${titleMatch}" on :${port}`);
}

class App {
  constructor() {
    this.proc = null;
    this.rdr = null;
    this.main = null;
    this.stdout = [];
  }
  async start(extraArgs = []) {
    this.proc = spawn(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'electron', 'cli.js'),
        '.',
        `--remote-debugging-port=${RDR_PORT}`,
        `--inspect=${MAIN_PORT}`,
        ...extraArgs,
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.stdout = [];
    this.proc.stdout.on('data', (d) => this.stdout.push(String(d)));
    this.proc.stderr.on('data', (d) => this.stdout.push(String(d)));
    this.rdr = await connect(RDR_PORT, 'Media downloader');
    this.targetId = (await getJson(RDR_PORT)).find((x) => x.title?.includes('Media downloader'))?.id;
    this.rdr.onTimeout = (msg) => this.diagnose(msg);
    try {
      this.main = await connect(MAIN_PORT, '');
    } catch {
      this.main = null;
    }
  }
  // called when the renderer stops answering: is main alive? did the page swap?
  async diagnose(msg) {
    const line = (t) => console.log(`[diagnose] ${t}`);
    line(msg);
    line(`electron alive: ${this.alive()}`);
    if (this.main) {
      try {
        line(`main responds: ${await this.main.eval('Date.now()')}`);
      } catch (e) {
        line(`main also stuck: ${e.message}`);
      }
    }
    try {
      const targets = await getJson(RDR_PORT);
      line(`live targets: ${targets.map((t) => `${t.id}:${t.title}`).join(' | ')}`);
      line(`bound target still listed: ${targets.some((t) => t.id === this.targetId)}`);
    } catch (e) {
      line(`target list unavailable: ${e.message}`);
    }
    try {
      const cpu = () =>
        execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process electron | Select-Object Id,CPU | ConvertTo-Json -Compress"], { encoding: 'utf8' });
      const s1 = cpu();
      await sleep(2500);
      const s2 = cpu();
      line(`cpu sample1: ${s1}`);
      line(`cpu sample2 (+2.5s): ${s2}`);
    } catch (e) {
      line(`cpu sample failed: ${e.message}`);
    }
    const tail = this.stdout.join('').split('\n').slice(-15).join('\n');
    line(`app stdout tail:\n${tail}`);
  }
  // wait until the boot IIFE has populated the UI
  async settled() {
    await this.eval(`(async () => {
      while (!window.api || !document.querySelectorAll('#quality option').length) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return true;
    })()`);
    await sleep(700);
  }
  async eval(expr) {
    return this.rdr.eval(expr);
  }
  alive() {
    return this.proc?.exitCode === null && this.proc?.signalCode === null;
  }
  async quitViaApp() {
    // the real quit path: before-quit -> quitCleanup; then release the
    // inspector, because a connected debugger holds the process open
    if (this.main) {
      const expr = `(() => {
        const electron = typeof require === 'function'
          ? require('electron')
          : process.mainModule.require('electron');
        electron.app.quit();
        return 'quit sent';
      })()`;
      try {
        const res = await this.main.eval(expr);
        console.log(`[quitViaApp] ${res}`);
      } catch (e) {
        console.log(`[quitViaApp] eval failed, killing: ${e.message}`);
      }
    }
    try {
      this.main?.close();
      this.rdr?.close();
    } catch {
      // sockets may already be gone
    }
    await this.waitForExit(25000);
  }
  async waitForExit(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && this.alive()) await sleep(200);
    if (this.alive()) {
      const tail = this.stdout.join('').split('\n').slice(-10).join('\n');
      console.log(`[waitForExit] app still alive after ${ms}ms; stdout tail:\n${tail}`);
      this.proc.kill();
      throw new Error('app did not exit in time');
    }
  }
  kill() {
    try {
      this.proc?.kill();
    } catch {
      // already dead
    }
  }
}

/* ---------- shared assertions ---------- */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function rows(app) {
  return app.eval(`(() => {
    return [...document.querySelectorAll('#list .row')].map((r) => ({
      title: r.querySelector('.row-title')?.textContent || '',
      meta: r.querySelector('.row-meta')?.textContent || '',
      side: r.querySelector('.row-side')?.textContent || '',
    }));
  })()`);
}

async function waitRows(app, pred, ms, poll = 600) {
  const deadline = Date.now() + ms;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = await rows(app);
    } catch (e) {
      console.log(`[waitRows] poll failed, retrying: ${String(e).slice(0, 100)}`);
      await sleep(poll);
      continue;
    }
    const hit = pred(last);
    if (hit) return { rows: last, matched: hit };
    await sleep(poll);
  }
  return { rows: last, matched: null };
}

const filesIn = (dir, re) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)) : [];

async function uiSettings(app) {
  return app.eval('window.api.getSettings()');
}

async function grabViaUi(app, url) {
  try {
    await app.eval(`(() => {
    const u = document.getElementById('url');
    u.value = ${JSON.stringify(url)};
    document.getElementById('btn-grab').click();
  })()`);
  } catch (e) {
    console.log(`[grabViaUi] eval failed, diagnosing: ${String(e).slice(0, 90)}`);
    await app.diagnose(String(e));
    throw e;
  }
}

// quality must go through the select the UI actually reads
async function setQuality(app, value) {
  await app.eval(`(() => {
    const q = document.getElementById('quality');
    q.value = ${JSON.stringify(String(value))};
    q.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
}

async function clickChip(app, mode) {
  await app.eval(`document.querySelector('.chip[data-mode="${mode}"]').click()`);
  await sleep(600);
}

/* ---------- round 1: everything once, the normal way ---------- */

async function round1() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const app = new App();
  await app.start();
  try {
    await app.settled();
    // the DOM is the source of truth for mode — click the chip, then align the store
    await clickChip(app, 'mp4');
    await app.eval(`(async () => {
      await window.api.setSettings({ outDir: ${JSON.stringify(OUT_DIR)}, format: 'mp4', bitrate: 0, withAudio: true, playlist: false, embedThumb: true });
    })()`);
    await setQuality(app, 360);

    // 1. happy path through the real UI
    await grabViaUi(app, ZOO);
    const done1 = await waitRows(app, (r) => r[0]?.side.includes('Done') || r[0]?.side.includes('Already downloaded'), 60000);
    check('r1/mp4 downloads to Done', !!done1.matched, JSON.stringify(done1.rows[0]));
    const vid = filesIn(OUT_DIR, /^Me at the zoo\./).filter((f) => ANY_MEDIA.test(f));
    check('r1/media file on disk', vid.length === 1, JSON.stringify(vid));
    check('r1/title resolved by pre-flight', !done1.rows[0].title.includes('Fetching'), done1.rows[0].title);
    check('r1/badge shows delivered height', done1.rows[0].meta.includes('240p'), done1.rows[0].meta);

    // 2. re-grab -> skip
    await grabViaUi(app, ZOO);
    const done2 = await waitRows(app, (r) => r[0]?.side.includes('Already downloaded'), 30000);
    check('r1/re-grab skipped with honest label', !!done2.matched, JSON.stringify(done2.rows[0]));
    check('r1/no duplicate file created', filesIn(OUT_DIR, /^Me at the zoo\./).length === 1, JSON.stringify(filesIn(OUT_DIR, /^Me at the zoo\./)));

    // 3. error path
    await grabViaUi(app, 'not a url at all');
    const err = await waitRows(app, (r) => r[0]?.side.includes('Retry'), 30000);
    check('r1/garbage url errors gracefully', !!err.matched, JSON.stringify(err.rows[0]));

    // 4. mode switch preserves the other mode's quality (settings.json truth)
    const before = await uiSettings(app);
    await clickChip(app, 'mp3');
    const afterMp3 = await uiSettings(app);
    check('r1/mp3 switch keeps saved height', afterMp3.format === 'mp3' && afterMp3.height === before.height,
      `before=${JSON.stringify(before)} after=${JSON.stringify(afterMp3)}`);
    await clickChip(app, 'mp4');
    const afterMp4 = await uiSettings(app);
    check('r1/mp4 switch restores height', afterMp4.format === 'mp4' && afterMp4.height === before.height, JSON.stringify(afterMp4));

    // 5. mp3 grab does not resurrect withAudio
    await app.eval(`(async () => { await window.api.setSettings({ withAudio: false }); })()`);
    await clickChip(app, 'mp3');
    await grabViaUi(app, ZOO);
    await waitRows(app, (r) => r[0]?.side.includes('Done') || r[0]?.side.includes('Already downloaded'), 60000);
    const afterMp3Grab = await uiSettings(app);
    check('r1/mp3 grab leaves withAudio alone', afterMp3Grab.withAudio === false, JSON.stringify(afterMp3Grab));
    check('r1/mp3 file exists, title clean', filesIn(OUT_DIR, /^Me at the zoo\.mp3$/).length === 1 &&
      (await rows(app))[0].title === 'Me at the zoo', (await rows(app))[0].title);

    // 6. escape closes the popover
    await app.eval(`document.getElementById('btn-settings').click()`);
    await sleep(300);
    await app.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);
    const popHidden = await app.eval(`document.getElementById('popover').hidden`);
    check('r1/escape closes popover', popHidden === true);

    // 7. url field precedes window controls in tab order
    const tabOk = await app.eval(`(() => {
      const order = [...document.querySelectorAll('button, input, select')]
        .map((e) => e.id + ' ' + e.className);
      const url = order.findIndex((x) => x.includes('url'));
      const win = order.findIndex((x) => x.includes('btn-min'));
      return url >= 0 && win >= 0 && url < win;
    })()`);
    check('r1/url precedes window controls in tab order', tabOk);

    // 8. opus
    await clickChip(app, 'opus');
    await grabViaUi(app, ZOO);
    const opus = await waitRows(app, (r) => r[0]?.side.includes('Done') || r[0]?.side.includes('Already downloaded'), 60000);
    check('r1/opus downloads', !!opus.matched && filesIn(OUT_DIR, /\.opus$/).length >= 1, JSON.stringify(opus.rows[0]));
  } finally {
    if (app.alive()) await app.quitViaApp().catch(() => app.kill());
  }
  console.log(`\nround1: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  return results;
}

/* ---------- round 2: sabotage ---------- */

async function round2() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const app = new App();
  await app.start();

  try {
    await app.settled();
    await app.eval(`(async () => {
      await window.api.setSettings({ outDir: ${JSON.stringify(OUT_DIR)}, format: 'mp4', withAudio: true, playlist: false, embedThumb: true });
    })()`);
    await setQuality(app, 144);

    // hostile IPC payloads straight through the bridge — each isolated; the
    // bridge itself rejecting a payload counts as graceful refusal
    const fire = (expr) => app.eval(expr).then(() => 'accepted').catch((e) => `refused: ${String(e.message).slice(0, 60)}`);
    const outcomes = [];
    outcomes.push(await fire(`window.api.grab({ url: 'x'.repeat(10000), mode: 'mp4' })`));
    outcomes.push(await fire(`window.api.grab({ url: { toString() { throw new Error('boom'); } } })`));
    outcomes.push(await fire(`window.api.grab({ url: '--exec=calc.exe' })`));
    outcomes.push(await fire(`window.api.grab({ url: '%(title)s%(ext)s %% %%d', mode: 'mp3' })`));
    outcomes.push(await fire(`window.api.grab(null)`));
    outcomes.push(await fire(`window.api.setSettings({ outDir: 123, format: 'wma', height: 'tall', withAudio: 'yes' })`));
    await sleep(1500);
    const hostile = await rows(app);
    const s = await uiSettings(app);
    check('r2/hostile ipc: no crash, rows sane', app.alive() && hostile.length <= 5, JSON.stringify(hostile.length));
    check('r2/hostile settings rejected', s.outDir === OUT_DIR && s.format === 'mp4' && s.withAudio === true, JSON.stringify(s));
    console.log(`[r2] hostile outcomes: ${outcomes.join(' | ')}`);

    // rapid-fire queue: 15 grabs of the same url
    for (let i = 0; i < 15; i++) await app.eval(`window.api.grab({ url: ${JSON.stringify(ZOO)}, mode: 'mp4', height: 144 })`);
    const terminal = (r) => r.side.includes('Done') || r.side.includes('Already downloaded') || r.side.includes('Retry');
    const queue = await waitRows(app, (r) => r.length >= 15 && r.every(terminal), 120000);
    check('r2/rapid 15: all terminal, one file', !!queue.matched && filesIn(OUT_DIR, /^Me at the zoo\./).length === 1, `${queue.rows.length} rows, files=${JSON.stringify(filesIn(OUT_DIR, /^Me at the zoo\./))}`);

    // cancel mid-download leaves nothing behind
    await app.eval(`window.api.grab({ url: ${JSON.stringify(BBB)}, mode: 'mp4', height: 1080 })`);
    await waitRows(app, (r) => r[0]?.meta.includes('%'), 90000);
    const id = await app.eval(`[...document.querySelectorAll('[data-act="cancel"]')].map((b) => b.dataset.id)[0] || ''`);
    if (id) {
      await app.eval(`window.api.cancel(${JSON.stringify(id)})`);
      await waitRows(app, (r) => r[0]?.side.includes('Retry'), 20000);
    }
    await sleep(1500);
    const parts = filesIn(OUT_DIR, /\.part$/);
    check('r2/cancel cleans partial files', parts.length === 0, JSON.stringify(parts));

    // dead url retry storm: retries pile up serially — wait for the queue to drain
    await app.eval(`window.api.grab({ url: ${JSON.stringify(DEAD)}, mode: 'mp4' })`);
    await waitRows(app, (r) => r[0]?.side.includes('Retry'), 45000);
    for (let i = 0; i < 5; i++) await app.eval(`document.querySelector('[data-act="retry"]')?.click()`);
    const drained = await waitRows(app, (r) => !r.some((x) => x.side.includes('Queued') || x.side.includes('Canceling')), 180000);
    const storm = drained.rows;
    check('r2/retry storm stays sane', app.alive() && storm.filter((r) => r.side.includes('Retry')).length >= 1, JSON.stringify(storm.map((r) => r.side).slice(0, 4)));

    // target name pre-created as a directory
    fs.mkdirSync(path.join(OUT_DIR, 'Me at the zoo.mp4'), { recursive: true });
    await app.eval(`window.api.grab({ url: ${JSON.stringify(ZOO)}, mode: 'mp4', height: 144 })`);
    const dirHit = await waitRows(app, (r) => r[0]?.side.includes('Retry') || r[0]?.side.includes('Done') || r[0]?.side.includes('Already downloaded'), 60000);
    check('r2/target-is-a-directory handled', !!dirHit.matched && app.alive(), JSON.stringify(dirHit.rows[0]));
    try { fs.rmdirSync(path.join(OUT_DIR, 'Me at the zoo.mp4')); } catch {}

    // close-to-tray mid-download, finish hidden, then real quit
    await app.eval(`window.api.grab({ url: ${JSON.stringify(BBB)}, mode: 'mp3', bitrate: 128 })`);
    await waitRows(app, (r) => r[0]?.meta.includes('%'), 90000);
    await app.eval(`window.api.close()`);
    await sleep(2000);
    check('r2/close during download keeps app alive (tray)', app.alive());
    await waitRows(app, (r) => r[0]?.side.includes('Done'), 180000);
    check('r2/download finished while hidden', filesIn(OUT_DIR, /\.mp3$/).length >= 1, JSON.stringify(filesIn(OUT_DIR, /\.mp3$/)));
    const beforeQuit = filesIn(OUT_DIR, /\.part$/).length;
    await app.quitViaApp();
    check('r2/quit after finish is clean', !app.alive() && filesIn(OUT_DIR, /\.part$/).length === beforeQuit);
  } catch (e) {
    check('r2/round2 sequence', false, String(e));
  } finally {
    if (app.alive()) await app.quitViaApp().catch(() => app.kill());
  }

  // tray-quit mid-download in a fresh instance: kill yt-dlp tree + partials
  const app2 = new App();
  await app2.start();
  try {
    await app2.settled();
    await app2.eval(`(async () => { await window.api.setSettings({ outDir: ${JSON.stringify(OUT_DIR)} }); })()`);
    await sleep(500);
    await app2.eval(`window.api.grab({ url: ${JSON.stringify(BBB)}, mode: 'mp4', height: 1080 })`);
    await waitRows(app2, (r) => r[0]?.meta.includes('%'), 90000);
    await app2.quitViaApp();
    await sleep(2000);
    const parts2 = filesIn(OUT_DIR, /\.part$/);
    let ytdlpRunning = false;
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq yt-dlp.exe'], { encoding: 'utf8' });
      ytdlpRunning = out.includes('yt-dlp.exe');
    } catch {
      // tasklist failed = cannot check
    }
    check('r2/tray-quit mid-download: no orphan process', !ytdlpRunning);
    check('r2/tray-quit mid-download: partials deleted', parts2.length === 0, JSON.stringify(parts2));
    check('r2/tray-quit: app exited', !app2.alive());
  } catch (e) {
    check('r2/tray-quit sequence', false, String(e));
    app2.kill();
  }

  // corrupt state files, relaunch, must boot with defaults
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(USER_DATA, 'settings.json'), '{ not json at all');
  fs.writeFileSync(path.join(USER_DATA, 'download-index.json'), '[[[');
  const app3 = new App();
  await app3.start();
  try {
    await app3.settled();
    const s = await app3.eval('window.api.getSettings()');
    check('r2/corrupt settings -> defaults, app boots', app3.alive() && s.format === 'mp4' && typeof s.outDir === 'string', JSON.stringify(s));
    await app3.eval(`(async () => { await window.api.setSettings({ outDir: ${JSON.stringify(OUT_DIR)} }); })()`);
    await grabViaUi(app3, ZOO);
    const rec = await waitRows(app3, (r) => r[0]?.side.includes('Done') || r[0]?.side.includes('Already downloaded') || r[0]?.side.includes('Retry'), 60000);
    check('r2/downloads after corrupt-state reboot', !!rec.matched && !rec.rows[0].side.includes('Retry'), JSON.stringify(rec.rows[0]));
  } finally {
    if (app3.alive()) await app3.quitViaApp().catch(() => app3.kill());
  }

  console.log(`\nround2: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  return results;
}

const mode = process.argv[2];
const run = mode === 'round1' ? round1 : mode === 'round2' ? round2 : null;
if (!run) {
  console.error('usage: node scripts/qa-cdp.mjs round1|round2');
  process.exit(2);
}
try {
  await run();
} catch (e) {
  console.log(`\n[harness] round aborted: ${String(e).slice(0, 200)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\ntotal: ${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
