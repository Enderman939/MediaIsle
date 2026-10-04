const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

function harness(initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaisle-main-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(initial.config || {}));
  if (initial.custom) fs.writeFileSync(path.join(dir, 'lyrics-custom.json'), JSON.stringify(initial.custom));
  const handlers = new Map();
  const listeners = new Map();
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
    ipcMain: { handle: (k, fn) => handlers.set(k, fn), on: (k, fn) => listeners.set(k, fn) },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    globalShortcut: { unregisterAll: () => registered.clear(), register: (v) => { if (v === 'Ctrl+Alt+Z') return false; registered.add(v); return true; } },
    BrowserWindow: MockWindow,
    dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
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
  return { s: sandbox.subject, handlers, listeners, sandbox, electron, owner, windows, dir, close() { for (const t of timers) clearTimeout(t); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('hover keeps the detached search capsule and crossing gap interactive only when expanded', () => {
  const h = harness();
  try {
    let point = { x: 540, y: 290 };
    const messages = [];
    h.electron.screen.getCursorScreenPoint = () => point;
    h.s.setIsland({ isDestroyed: () => false, isVisible: () => true, getPosition: () => [100, 50],
      setIgnoreMouseEvents() {}, webContents: { send: (_channel, value) => messages.push(value) } });
    const state = (value) => h.listeners.get('island-state')(null, value);
    state('expanded');
    assert.equal(messages.at(-1), true, 'The search capsule below the island receives pointer events');
    point = { x: 540, y: 270 }; state('expanded');
    assert.equal(messages.at(-1), true, 'The gap between island and search does not collapse the island');
    point = { x: 200, y: 290 }; state('expanded');
    assert.equal(messages.at(-1), false, 'The unused area below the left side still passes through');
    point = { x: 540, y: 290 }; state('compact');
    assert.equal(messages.at(-1), false, 'A hidden capsule does not capture the pointer');
    point = { x: 200, y: 100 }; state('expanded');
    assert.equal(messages.at(-1), true, 'Normal expanded island controls still receive pointer events');
    point = { x: 540, y: 310 }; state('expanded');
    assert.equal(messages.at(-1), false, 'The area below the capsule passes through');
  } finally { h.close(); }
});

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

test('export preferences restore choices and the last successful save directory', async () => {
  const h = harness({ config: { lyricsExport: { format: 'md', language: 'english', directory: path.join(os.tmpdir(), 'previous') } } });
  try {
    const preferences = h.handlers.get('lyrics-export-preferences');
    assert.equal(preferences().format, 'md');
    assert.equal(preferences(null, { format: 'lrc', language: 'original', directory: '/untrusted' }).directory, path.join(os.tmpdir(), 'previous'));
    h.electron.dialog.showSaveDialog = async (_owner, options) => {
      assert.equal(path.dirname(options.defaultPath), path.join(os.tmpdir(), 'previous'));
      return { canceled: false, filePath: path.join(h.dir, 'saved.txt') };
    };
    const result = await h.handlers.get('lyrics-download')({ sender: {} }, { title: 'Song', lyrics: { lines: [{ t: 1, x: 'Line' }] }, format: 'txt', language: 'english' });
    assert.equal(result.ok, true);
    assert.equal(preferences().directory, h.dir);
    h.electron.dialog.showSaveDialog = async () => ({ canceled: true });
    await h.handlers.get('lyrics-download')({ sender: {} }, { title: 'Song', lyrics: { lines: [{ t: 1, x: 'Line' }] }, format: 'md' });
    assert.equal(preferences().format, 'txt', 'Canceled save does not replace successful preferences');
    await new Promise((r) => setTimeout(r, 650));
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'))).lyricsExport.directory, h.dir);
  } finally { h.close(); }
});

test('edited lyrics preview without mutation, validate, persist, restore and survive cache clearing', async () => {
  const h = harness();
  let persisted;
  try {
    h.handlers.get('lyrics-download-open')(null, { title: 'Song', artist: 'A', lyrics: { lines: [{ t: 1, x: 'Online' }] } });
    const context = await h.handlers.get('lyrics-download-context')();
    const draft = { lines: [{ t: 2.5, x: 'My edit' }], trans: [{ t: 2.5, x: '我的译文' }] };
    const preview = await h.handlers.get('lyrics-download-preview')(null, { contextId: context.id, draft, format: 'lrc', language: 'bilingual' });
    assert.match(preview.content, /\[00:02\.50\]My edit/);
    assert.equal((await h.handlers.get('lyrics-download-context')()).lyrics.lines[0].x, 'Online');
    h.handlers.get('lyrics-editor-dirty')(null, { contextId: context.id, dirty: true });
    assert.match(h.handlers.get('lyrics-download-open')(null, { title: 'Other' }).message, /未保存/);
    let blockedClose = false;
    h.windows[0].events.close({ preventDefault: () => { blockedClose = true; } });
    assert.equal(blockedClose, true);
    assert.equal(h.windows[0].messages.at(-1)[0], 'lyrics-close-blocked');
    const save = (lyrics) => h.handlers.get('lyrics-custom-save')(null, { contextId: context.id, lyrics });
    assert.equal((await save({ lines: [{ t: NaN, x: 'Bad' }] })).ok, false);
    assert.equal(fs.existsSync(path.join(h.dir, 'lyrics-custom.json')), false);
    assert.equal((await save(draft)).ok, true);
    assert.match((await h.handlers.get('lyr-pick')(null, { title: 'Song', artist: 'A', songKey: 'Song|A', src: 'netease', key: '9' })).message, /自定义版本/);
    persisted = JSON.parse(fs.readFileSync(path.join(h.dir, 'lyrics-custom.json')));
    assert.equal(persisted['["song","a"]'].trans[0].x, '我的译文');
    assert.equal((await save({ lines: [{ t: -1, x: 'Invalid' }] })).ok, false);
    assert.equal(fs.readFileSync(path.join(h.dir, 'lyrics-custom.json'), 'utf8'), JSON.stringify(persisted));
    h.s.lyrCache.clear();
    assert.equal((await h.s.fetchLyrics({ title: 'Song', artist: 'A' })).lines[0].x, 'My edit');
    assert.equal((await h.handlers.get('lyrics-custom-save')(null, { contextId: -1, lyrics: draft })).ok, false);
  } finally { h.close(); }
  const reopened = harness({ custom: persisted });
  try {
    assert.equal((await reopened.s.fetchLyrics({ title: ' SONG ', artist: 'a' })).lines[0].t, 2.5);
    reopened.s.cfg.lyrSources = ['netease'];
    reopened.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = async () => ({ lines: [{ t: 1, x: 'Restored online' }] });
    reopened.handlers.get('lyrics-download-open')(null, { title: 'Song', artist: 'A' });
    const context = await reopened.handlers.get('lyrics-download-context')();
    const reset = await reopened.handlers.get('lyrics-custom-reset')(null, { contextId: context.id });
    assert.equal(reset.ok, true);
    assert.equal(reset.custom, false);
    assert.equal(reset.lyrics.lines[0].x, 'Restored online');
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(reopened.dir, 'lyrics-custom.json')))).length, 0);
  } finally { reopened.close(); }
});

test('custom save wins over an automatic request already in flight', async () => {
  const h = harness();
  try {
    h.s.cfg.lyrSources = ['netease'];
    let finish;
    h.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = () => new Promise((resolve) => { finish = resolve; });
    const pending = h.s.fetchLyrics({ title: 'Song', artist: 'A' });
    h.handlers.get('lyrics-download-open')(null, { title: 'Song', artist: 'A', lyrics: { lines: [{ t: 1, x: 'Displayed' }] } });
    const context = await h.handlers.get('lyrics-download-context')();
    await h.handlers.get('lyrics-custom-save')(null, { contextId: context.id, lyrics: { lines: [{ t: 3, x: 'Edited' }] } });
    finish({ lines: [{ t: 1, x: 'Automatic' }] });
    assert.equal((await pending).lines[0].x, 'Edited');
  } finally { h.close(); }
});

test('restoring online lyrics keeps the custom version when the lookup fails', async () => {
  const h = harness({ custom: { '["song","a"]': { lines: [{ t: 2, x: 'Keep my edit' }] } } });
  try {
    h.s.cfg.lyrSources = [];
    h.handlers.get('lyrics-download-open')(null, { title: 'Song', artist: 'A' });
    const context = await h.handlers.get('lyrics-download-context')();
    const before = fs.readFileSync(path.join(h.dir, 'lyrics-custom.json'), 'utf8');
    const reset = await h.handlers.get('lyrics-custom-reset')(null, { contextId: context.id });
    assert.equal(reset.ok, false);
    assert.match(reset.message, /已保留/);
    assert.equal(fs.readFileSync(path.join(h.dir, 'lyrics-custom.json'), 'utf8'), before);
    assert.equal((await h.s.fetchLyrics({ title: 'Song', artist: 'A' })).lines[0].x, 'Keep my edit');
    assert.equal((await h.handlers.get('lyrics-custom-save')(null, { contextId: context.id, lyrics: { lines: [{ t: 2, x: 'Still editable' }] } })).ok, true, 'The failed reset releases the export lock');
  } finally { h.close(); }
});

test('lyric seek verifies track, playback session and position before sending a command', () => {
  const h = harness();
  try {
    const seek = h.handlers.get('lyrics-seek');
    const commands = [];
    vm.runInContext('sendCommand = (cmd, position) => this.commands.push({cmd, position})', Object.assign(h.sandbox, { commands }));
    h.s.setMedia({ hasSession: true, title: 'Song', artist: 'A', appId: 'player', duration: 180, canSeek: false });
    assert.equal(seek(null, { title: 'Other', artist: 'A', position: 2 }).ok, false);
    assert.equal(seek(null, { title: 'Song', artist: 'A', appId: 'other-player', position: 2 }).ok, false);
    assert.equal(seek(null, { title: 'Song', artist: 'A', position: 181 }).ok, false);
    assert.equal(commands.length, 0);
    assert.equal(seek(null, { title: 'Song', artist: 'A', appId: 'player', position: 2.5 }).ok, true);
    assert.equal(commands[0].cmd, 'seek'); assert.equal(commands[0].position, 2.5);
    h.s.setMedia({ hasSession: true, title: 'Song', artist: 'A', appId: 'player', duration: 0 });
    h.s.lyrCache.set('song|a', { dur: 180, lines: [{ t: 1, x: 'Line' }] });
    assert.equal(seek(null, { title: 'Song', artist: 'A', appId: 'player', position: 60 }).ok, true, 'Players without a reported timeline use the known lyric-source duration');
    h.s.setMedia({ hasSession: false });
    assert.equal(seek(null, { title: 'Song', artist: 'A', position: 2 }).ok, false);
  } finally { h.close(); }
});

test('batch export uses custom lyrics, reports failures and never overwrites existing files', async () => {
  const h = harness({ custom: { '["edited","a"]': { lines: [{ t: 2, x: 'Custom' }], trans: [{ t: 2, x: '译文' }] } } });
  try {
    const tracks = [{ title: 'Edited', artist: 'A' }, { title: 'No translation' }, { title: 'Empty' }];
    h.s.lyrCache.set('no translation|', { lines: [{ t: 1, x: 'Only original' }] });
    h.s.lyrCache.set('empty|', { lines: [] });
    h.handlers.get('lyrics-download-open')(null, { tracks });
    const context = await h.handlers.get('lyrics-download-context')();
    assert.equal(context.mode, 'batch');
    const existing = path.join(h.dir, 'Edited - A.bilingual.lrc');
    fs.writeFileSync(existing, 'Keep me');
    h.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [h.dir] });
    const messages = [];
    const event = { sender: { isDestroyed: () => false, send: (_channel, value) => messages.push(JSON.parse(JSON.stringify(value))) } };
    const result = await h.handlers.get('lyrics-batch-export')(event, { contextId: context.id, tracks, format: 'lrc', language: 'bilingual' });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.results.length, 3);
    assert.equal(result.results.filter((r) => r.ok).length, 1);
    assert.match(result.results[1].message, /没有译文/);
    assert.match(result.results[2].message, /没有可下载/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'Keep me');
    assert.match(fs.readFileSync(result.results[0].path, 'utf8'), /\[00:02\.00\]Custom/);
    assert.match(result.results[0].path, /\(1\)/);
    assert.equal(messages.at(-1).running, false);
    assert.equal(h.s.cfg.lyricsExport.directory, h.dir);
    assert.equal((await h.handlers.get('lyrics-batch-export')(event, { contextId: context.id, tracks: [{ title: 'Unlisted' }], format: 'txt', language: 'original' })).ok, false);
  } finally { h.close(); }
});

test('batch cancel stops before writing pending lyrics and releases the export lock', async () => {
  const h = harness();
  try {
    h.s.cfg.lyrSources = ['netease'];
    let finish;
    h.s.LYRIC_SOURCES.find((s) => s.id === 'netease').fn = () => new Promise((resolve) => { finish = resolve; });
    const tracks = [{ title: 'Song' }, { title: 'Next' }];
    h.handlers.get('lyrics-download-open')(null, { tracks });
    const context = await h.handlers.get('lyrics-download-context')();
    h.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [h.dir] });
    const event = { sender: { isDestroyed: () => false, send() {} } };
    const request = { contextId: context.id, tracks, format: 'txt', language: 'original' };
    const pending = h.handlers.get('lyrics-batch-export')(event, request);
    await new Promise((r) => setImmediate(r));
    assert.equal((await h.handlers.get('lyrics-batch-export')(event, request)).ok, false);
    assert.equal(h.handlers.get('lyrics-download-open')(null, { title: 'Other' }).ok, false);
    h.handlers.get('lyrics-batch-cancel')();
    finish({ lines: [{ t: 1, x: 'Late result' }] });
    const result = await pending;
    assert.equal(result.canceled, true);
    assert.equal(result.results.length, 0);
    assert.equal(fs.existsSync(path.join(h.dir, 'Song.txt')), false);
    h.electron.dialog.showOpenDialog = async () => ({ canceled: true });
    assert.equal((await h.handlers.get('lyrics-batch-export')(event, request)).canceled, true);
    assert.equal(h.handlers.get('lyrics-download-open')(null, { title: 'Other' }).ok, true);
  } finally { h.close(); }
});
