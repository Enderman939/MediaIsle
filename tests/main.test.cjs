const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaisle-main-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const handlers = new Map();
  const timers = new Set();
  const registered = new Set();
  const owner = { isDestroyed: () => false };
  const windows = [];
  class MockWindow {
    constructor(options) { this.options = options; this.events = {}; this.messages = []; this.webContents = { on() {}, send: (...args) => this.messages.push(args) }; windows.push(this); }
    static fromWebContents() { return owner; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    setAlwaysOnTop() {}
    focus() { this.focused = true; }
    loadFile(file) { this.file = file; }
    on(event, fn) { this.events[event] = fn; }
  }
  const electron = {
    app: { isPackaged: false, getPath: () => dir, getVersion: () => '1.2.0', getLoginItemSettings: () => ({ openAtLogin: false }), requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (k, fn) => handlers.set(k, fn), on() {} },
    globalShortcut: { unregisterAll: () => registered.clear(), register: (v) => { if (v === 'Ctrl+Alt+Z') return false; registered.add(v); return true; } },
    BrowserWindow: MockWindow,
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
  };
  const localRequire = createRequire(path.join(root, 'main.js'));
  const sandbox = {
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: root, Buffer, URL, AbortController, AbortSignal,
    process: { env: {}, on() {} }, console: { log() {}, error() {} },
    setInterval: () => 0,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    fetch: async () => { throw new Error('Simulated offline'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8') + `
    this.subject = { fetchLyrics, measuredSource, httpJson, LYRIC_SOURCES, cfg, lyrCache, lyrPicks,
      setMedia: (value) => { lastMediaState = value; },
      setLyricByKey: (fn) => { fetchLyricByKey = fn; },
      setIsland: (value) => { win = value; },
      savingLyrics: () => islandSavingLyrics,
      diagnostics: () => JSON.parse(JSON.stringify(lyricDiagnostic)),
      run: () => lyricRun };
  `, sandbox);
  return { s: sandbox.subject, handlers, sandbox, electron, owner, windows, dir, close() { for (const t of timers) clearTimeout(t); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('diagnostics preserve network failure vs no match and elapsed time', async () => {
  const h = harness();
  try {
    h.s.cfg.lyrSources = ['netease'];
    h.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = async () => {
      try { await h.s.httpJson('https://music.163.com/test', {}, undefined); } catch {}
      return null;
    };
    const result = await h.s.fetchLyrics({ title: 'Song', artist: '', duration: 0 });
    assert.equal(result.lines.length, 0);
    const row = h.s.diagnostics().sources.netease;
    assert.equal(row.state, 'error');
    assert.match(row.error, /music.163.com: Simulated offline/);
    assert.ok(row.elapsedMs >= 0);
  } finally { h.close(); }
});

test('netease search falls back to POST when GET is rejected with API 405', async () => {
  const h = harness();
  try {
    h.sandbox.fetch = async (url, init = {}) => {
      let body;
      if (String(url).includes('/api/search/get/web') && init.method !== 'POST') body = JSON.stringify({ code: 405 });
      else if (String(url).includes('song/lyric')) body = JSON.stringify({ lrc: { lyric: '[00:01.00]Line' }, tlyric: { lyric: '' } });
      else body = JSON.stringify({ result: { songs: [{ id: 9, name: 'Song', artists: [{ name: 'A' }], duration: 1000 }] } });
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    };
    h.s.cfg.lyrSources = ['netease'];
    const r = await h.s.fetchLyrics({ title: 'Song', artist: '', duration: 1 });
    assert.equal(r.lines.length, 1);
    assert.equal(r.src, 'netease');
    const row = h.s.diagnostics().sources.netease;
    assert.equal(row.state, 'hit');
    assert.equal(row.error, '');
  } finally { h.close(); }
});

test('source race takes first valid result and reports cache without stale request status', async () => {
  const h = harness();
  try {
    h.s.cfg.lyrSources = ['netease', 'qq'];
    h.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = () => new Promise((r) => setTimeout(() => r(null), 35));
    h.s.LYRIC_SOURCES.find((s) => s.id === 'qq').fn = async () => ({ lines: [{ t: 1, x: 'Line' }], dur: 2, trans: [] });
    const r = await h.s.fetchLyrics({ title: 'Song', artist: '', duration: 2 });
    assert.equal(r.src, 'qq');
    const cached = await h.s.fetchLyrics({ title: 'Song', artist: '', duration: 2 });
    assert.equal(cached.src, 'qq');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.s.diagnostics().cache, true);
    assert.equal(Object.keys(h.s.diagnostics().sources).length, 0);
  } finally { h.close(); }
});

test('configuration replies are consistent and shortcut conflicts roll back', () => {
  const h = harness();
  try {
    const before = h.handlers.get('cfg-get')();
    const after = h.handlers.get('cfg-set')(null, 'lyrOffset', 1.3);
    assert.deepEqual(Object.keys(before), Object.keys(after));
    assert.equal(after.lyrOffset, 1.3);
    const failed = h.handlers.get('shortcut-set')(null, 'toggle', 'Ctrl+Alt+Z');
    assert.equal(failed.ok, false);
    assert.equal(h.s.cfg.shortcuts.toggle, 'Ctrl+Alt+Space');
    assert.equal(h.handlers.get('shortcut-set')(null, 'toggle', 'Ctrl+Alt+X').ok, true);
    assert.equal(h.handlers.get('shortcut-set')(null, 'next', 'Ctrl+Alt+X').ok, false);
  } finally { h.close(); }
});

test('saved manual choice is reused after cache clearing', async () => {
  const h = harness();
  try {
    h.s.lyrPicks['song|a'] = { src: 'netease', key: '9' };
    h.s.setLyricByKey(async () => ({ lines: [{ t: 1, x: 'Selected' }], trans: [{ t: 1, x: '选择' }] }));
    const result = await h.s.fetchLyrics({ title: 'Song', artist: 'A' });
    assert.equal(result.src, 'netease · 手动');
    assert.equal(result.lines[0].x, 'Selected');
    assert.equal(h.s.lyrCache.get('song|a'), result);
  } finally { h.close(); }
});

test('manual selection wins over an automatic lookup already in flight', async () => {
  const h = harness();
  try {
    h.s.cfg.lyrSources = ['netease'];
    let finishAutomatic;
    h.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = () => new Promise((resolve) => { finishAutomatic = resolve; });
    const automatic = h.s.fetchLyrics({ title: 'Song', artist: 'A' });
    await new Promise((resolve) => setImmediate(resolve));
    h.s.setLyricByKey(async () => ({ lines: [{ t: 2, x: 'Manual' }] }));
    assert.equal((await h.handlers.get('lyr-pick')(null, { songKey: 'Song|A', src: 'netease', key: '10' })).ok, true);
    finishAutomatic({ lines: [{ t: 1, x: 'Automatic' }] });
    assert.equal((await automatic).lines[0].x, 'Manual');
    assert.equal(h.s.lyrCache.get('song|a').lines[0].x, 'Manual');
  } finally { h.close(); }
});

test('download exports cached manual lyrics and appends the selected extension', async () => {
  const h = harness();
  try {
    h.s.setMedia({ hasSession: true, title: 'Song', artist: 'A' });
    h.s.cfg.lyrOffset = 10;
    h.s.lyrCache.set('song|a', { lines: [{ t: 1.25, x: 'Manual' }], trans: [{ t: 1.25, x: '手动' }], src: 'netease · 手动' });
    const info = h.handlers.get('lyrics-download-info')();
    assert.equal(info.ready, true);
    assert.equal(info.hasTranslation, true);
    assert.match(info.source, /手动/);
    h.electron.dialog.showSaveDialog = async (owner, options) => {
      assert.equal(owner, h.owner);
      assert.equal(path.basename(options.defaultPath), 'Song - A.bilingual.lrc');
      return { canceled: false, filePath: path.join(h.dir, '歌词') };
    };
    const result = await h.handlers.get('lyrics-download')({ sender: {} }, { format: 'lrc', language: 'bilingual' });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.path, path.join(h.dir, '歌词.lrc'));
    assert.equal(result.translatedRows, 1);
    assert.match(fs.readFileSync(result.path, 'utf8'), /\[00:01\.25\]Manual\r\n\[00:01\.25\]手动/);
  } finally { h.close(); }
});

test('download preserves displayed lyrics and locks concurrent dialogs until cancel', async () => {
  const h = harness();
  try {
    h.s.setIsland(h.owner);
    h.s.lyrCache.set('song|a', { lines: [{ t: 5, x: 'New version' }] });
    let cancel;
    h.electron.dialog.showSaveDialog = () => new Promise((resolve) => { cancel = resolve; });
    const request = { title: 'Song', artist: 'A', format: 'lrc', lyrics: { lines: [{ t: 1, x: 'Displayed' }] } };
    const pending = h.handlers.get('lyrics-download')({ sender: {} }, request);
    assert.equal(h.s.savingLyrics(), true);
    assert.equal((await h.handlers.get('lyrics-download')({ sender: {} }, request)).ok, false);
    cancel({ canceled: true });
    assert.equal((await pending).canceled, true);
    assert.equal(h.s.savingLyrics(), false);
    h.electron.dialog.showSaveDialog = async () => {
      h.s.setMedia({ hasSession: true, title: 'Other song', artist: 'B' });
      request.lyrics.lines[0].x = 'Changed during dialog';
      return { canceled: false, filePath: path.join(h.dir, 'snapshot.lrc') };
    };
    const result = await h.handlers.get('lyrics-download')({ sender: {} }, request);
    assert.equal(result.ok, true);
    assert.match(fs.readFileSync(result.path, 'utf8'), /\[00:01\.00\]Displayed/);
    assert.equal(h.s.savingLyrics(), false);
  } finally { h.close(); }
});

test('download handles missing lyrics, translation, bad paths and canceled windows', async () => {
  const h = harness();
  try {
    const download = (request) => h.handlers.get('lyrics-download')({ sender: {} }, request);
    assert.match((await download(null)).message, /没有歌曲/);
    h.s.lyrCache.set('empty|', { lines: [] });
    assert.match((await download({ title: 'Empty' })).message, /没有可下载/);
    h.s.lyrCache.set('song|', { lines: [{ t: 1, x: 'Line' }] });
    assert.match((await download({ title: 'Song', language: 'bilingual' })).message, /没有译文/);
    h.electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(h.dir, 'missing', 'song.lrc') });
    assert.equal((await download({ title: 'Song' })).ok, false);
    h.electron.dialog.showSaveDialog = async () => ({ canceled: true });
    assert.equal((await download({ title: 'Song' })).canceled, true);
    h.electron.BrowserWindow.fromWebContents = () => null;
    assert.equal((await download({ title: 'Song' })).canceled, true);
  } finally { h.close(); }
});

test('download window holds a snapshot, previews languages and reuses a single window', async () => {
  const h = harness();
  try {
    const lyrics = { lines: [{ t: 1, x: 'Hello' }], trans: [{ t: 1, x: '你好' }], src: 'netease · 手动' };
    const open = h.handlers.get('lyrics-download-open');
    assert.equal(open(null, { title: 'Song', artist: 'A', lyrics }).ok, true);
    assert.equal(h.windows.length, 1);
    assert.ok(h.windows[0].file.endsWith('lyrics-download.html'));
    lyrics.lines[0].x = 'Changed';
    const info = await h.handlers.get('lyrics-download-context')();
    assert.equal(info.ok, true);
    assert.equal(info.source, 'netease · 手动');
    assert.ok(info.languages.includes('chinese'));
    const request = { contextId: info.id, format: 'md', language: 'chinese' };
    const preview = await h.handlers.get('lyrics-download-preview')(null, request);
    assert.equal(preview.ok, true);
    assert.match(preview.content, /你好/);
    assert.doesNotMatch(preview.content, /Hello|Changed/);
    h.s.lyrCache.set('song|a', { lines: [{ t: 1, x: 'Other version' }] });
    h.electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(h.dir, preview.filename) });
    const saved = await h.handlers.get('lyrics-download')({ sender: {} }, request);
    assert.equal(saved.ok, true, saved.message);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), preview.content);
    assert.equal(open(null, { title: 'Other', lyrics: { lines: [{ t: 1, x: 'New song' }] } }).ok, true);
    assert.equal(h.windows.length, 1);
    assert.equal(h.windows[0].focused, true);
    assert.equal(h.windows[0].messages[0][0], 'lyrics-download-changed');
    assert.equal((await h.handlers.get('lyrics-download')({ sender: {} }, request)).ok, false);
    assert.equal((await h.handlers.get('lyrics-download-preview')(null, request)).ok, false);
    h.windows[0].events.closed();
    assert.equal((await h.handlers.get('lyrics-download-context')()).ok, false);
  } finally { h.close(); }
});
