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
  const electron = {
    app: { isPackaged: false, getPath: () => dir, getVersion: () => '1.2.0', getLoginItemSettings: () => ({ openAtLogin: false }), requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { handle: (k, fn) => handlers.set(k, fn), on() {} },
    globalShortcut: { unregisterAll: () => registered.clear(), register: (v) => { if (v === 'Ctrl+Alt+Z') return false; registered.add(v); return true; } },
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
      diagnostics: () => JSON.parse(JSON.stringify(lyricDiagnostic)),
      run: () => lyricRun };
  `, sandbox);
  return { s: sandbox.subject, handlers, sandbox, close() { for (const t of timers) clearTimeout(t); fs.rmSync(dir, { recursive: true, force: true }); } };
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
