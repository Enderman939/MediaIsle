const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaisle-ui-'));
const evidence = path.join(root, 'dist', 'verification');
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ lastSeenVersion: '1.1.1', lowPower: false }));
const errors = [];
let application;

(async () => {
  const env = { ...process.env, MEDIAISLE_USER_DATA: temp, MEDIAISLE_SETTINGS: '1', MEDIAISLE_NO_BRIDGE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ executablePath: process.env.MEDIAISLE_TEST_EXE || require('electron'), args: process.env.MEDIAISLE_TEST_EXE ? [] : [root], env });
  application.on('window', (page) => page.on('pageerror', (e) => errors.push(e.message)));
  let settings;
  for (let i = 0; i < 100; i++) {
    settings = application.windows().find((p) => /settings\.html/.test(p.url()));
    if (settings) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(settings, 'Settings window opened');
  settings.on('pageerror', (e) => errors.push(e.message));
  const appVersion = require('../package.json').version.split('+')[0];
  await settings.waitForSelector(`#appVer:has-text("${appVersion}")`);
  const getCfg = () => settings.evaluate(() => window.island.getCfg());
  await settings.locator('#swLowPower').check();
  await settings.waitForTimeout(200);
  assert.equal((await getCfg()).lowPower, true);
  const offset = settings.locator('#rngLyrOffset');
  await offset.evaluate((el) => { el.value = '0.8'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await settings.waitForTimeout(700);
  assert.equal((await getCfg()).lyrOffset, 0.8);

  await settings.locator('[data-page="diagnostics"]').click();
  await settings.waitForSelector('#diagShortcuts input');
  const shortcut = settings.locator('#shortcut-toggle');
  await shortcut.fill('Ctrl+Alt+X');
  await shortcut.locator('..').getByRole('button', { name: '保存', exact: true }).click();
  await settings.waitForFunction(() => document.getElementById('diagnosticFeedback').textContent.includes('已保存'));
  await settings.screenshot({ path: path.join(evidence, 'diagnostics.png') });
  await settings.locator('[data-page="general"]').click();
  await settings.screenshot({ path: path.join(evidence, 'settings.png') });

  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('settings.html'));
    window.setSize(640, 440);
  });
  await settings.locator('[data-page="diagnostics"]').click();
  await settings.waitForTimeout(350);
  const layout = await settings.evaluate(() => {
    const page = document.getElementById('page-diagnostics');
    return { client: page.clientWidth, scroll: page.scrollWidth };
  });
  assert.ok(layout.scroll <= layout.client + 1, JSON.stringify(layout));
  await settings.screenshot({ path: path.join(evidence, 'diagnostics-compact.png') });

  const island = application.windows().find((p) => /index\.html/.test(p.url()));
  assert.ok(island);
  assert.equal(await island.locator('#btnLyricsDownload').isDisabled(), true);
  assert.equal(await settings.locator('#btnLyricsDownload').isDisabled(), true);
  // Keep lyric requests deterministic; the real fetching, picking, exporting and IPC handlers run.
  await settings.evaluate(() => window.island.setCfg('lyrSources', ['netease']));
  await application.evaluate(({ ipcMain, dialog }, outputDir) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const fetchBefore = global.fetch;
    global.fetch = async (url, options) => {
      if (!String(url).includes('music.163.com')) return fetchBefore(url, options);
      const manual = new URL(url).searchParams.get('id') === '9';
      const body = String(url).includes('/song/lyric') ? {
        lrc: { lyric: manual ? '[00:01.25]Selected first\n[01:00.25]Selected second\n[02:55.00]Selected end' : '[00:01.25]First line\n[01:00.25]Second line\n[02:55.00]End' },
        tlyric: { lyric: manual ? '[01:00.25]手动选定译文' : '[01:00.25]第二句译文' },
      } : { result: { songs: [{ id: 8, name: 'Verification track', artists: [{ name: 'MediaIsle' }], duration: 180000 }] } };
      return { ok: true, status: 200, json: async () => body };
    };
    const handlers = ipcMain._invokeHandlers;
    const originalInfo = handlers.get('lyrics-download-info');
    global.__lyricsSmoke = { mode: 'save', requests: [], available: true };
    handlers.set('lyrics-download-info', (event) => global.__lyricsSmoke.available
      ? { available: true, title: 'Verification track', artist: 'MediaIsle', ready: true, hasTranslation: true, source: '网易云' } : originalInfo(event));
    handlers.set('lyr-candidates', async () => [{ src: 'netease', key: '9', name: 'Verification track · selected version', artist: 'MediaIsle', dur: 180 }]);
    dialog.showSaveDialog = async (owner, options) => {
      global.__lyricsSmoke.requests.push({ owner: owner.webContents.getURL(), ...options });
      if (global.__lyricsSmoke.mode === 'cancel') return { canceled: true };
      const filePath = path.join(outputDir, path.basename(options.defaultPath));
      if (global.__lyricsSmoke.mode === 'fail') return { canceled: false, filePath: path.join(outputDir, 'missing-directory', 'song.lrc') };
      // Write is performed by the actual lyrics-download handler after this return.
      if (!fs.existsSync(outputDir)) throw new Error('Test output directory is missing');
      return { canceled: false, filePath };
    };
  }, temp);
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    w.webContents.send('media-state', { type: 'state', hasSession: true, title: 'Verification track', artist: 'MediaIsle', source: 'Test session', status: 'Paused', duration: 180, position: 60, canPlay: true, canPause: true, canPrev: true, canNext: true, sources: [] });
    w.webContents.send('hover-changed', true);
  });
  await settings.evaluate(() => window.island.setCfg('expWidth', 960));
  await island.waitForTimeout(700);
  const size = await island.evaluate(() => ({ width: document.getElementById('island').getBoundingClientRect().width, viewport: innerWidth }));
  assert.equal(size.width, 960);
  assert.ok(size.viewport > size.width, JSON.stringify(size));
  await island.screenshot({ path: path.join(evidence, 'island-wide.png') });

  await island.waitForFunction(() => !document.getElementById('btnLyricsDownload').disabled);
  await island.locator('#btnLyricsDownload').dispatchEvent('click');
  let download;
  for (let i = 0; i < 100; i++) {
    download = application.windows().find((p) => /lyrics-download\.html/.test(p.url()));
    if (download) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(download, 'Separate lyrics download window opened');
  const waitPreview = () => download.waitForFunction(() => !document.getElementById('btnSave').disabled);
  await waitPreview();
  assert.equal((await application.evaluate(() => global.__lyricsSmoke.requests)).length, 0, 'Opening the window does not open Save');
  const choose = async (format, language) => {
    await download.locator(`input[name="format"][value="${format}"]`).check();
    await waitPreview();
    await download.locator(`input[name="language"][value="${language}"]`).check();
    await waitPreview();
  };
  const save = async () => {
    const filename = await download.locator('#previewFilename').innerText();
    const preview = await download.locator('#previewContent').innerText();
    await download.locator('#btnSave').click();
    await download.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('已保存'));
    const content = fs.readFileSync(path.join(temp, filename), 'utf8');
    assert.equal(content.replace(/\r\n/g, '\n').trimEnd(), preview.replace(/\r\n/g, '\n').trimEnd(), 'Saved content matches preview');
    return content;
  };
  for (const format of ['md', 'txt', 'lrc']) {
    for (const language of ['chinese', 'english', 'bilingual']) {
      await choose(format, language);
      const content = await save();
      if (language !== 'english') assert.match(content, /第二句译文/);
      else assert.doesNotMatch(content, /第二句译文/);
      if (language !== 'chinese') assert.match(content, /Second line/);
      else assert.doesNotMatch(content, /First line|Second line|End/);
      if (format === 'lrc') assert.match(content, /\[01:00\.25\]/);
      else assert.doesNotMatch(content, /\[01:00\.25\]/);
    }
  }
  await choose('md', 'bilingual');
  await download.screenshot({ path: path.join(evidence, 'lyrics-download-window.png') });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('lyrics-download.html')).setSize(480, 540);
  });
  const compactDownload = await download.evaluate(() => ({ client: document.querySelector('main').clientWidth, scroll: document.querySelector('main').scrollWidth,
    saveBottom: document.getElementById('btnSave').getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(compactDownload.scroll <= compactDownload.client + 1, JSON.stringify(compactDownload));
  assert.ok(compactDownload.saveBottom <= compactDownload.height, JSON.stringify(compactDownload));
  await download.screenshot({ path: path.join(evidence, 'lyrics-download-window-compact.png') });

  await settings.locator('[data-page="general"]').click();
  await settings.waitForFunction(() => !document.getElementById('btnLyricsDownload').disabled);
  await download.locator('#btnMin').click();
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('lyrics-download.html')).isMinimized()), true);
  await settings.locator('#btnLyricsDownload').click();
  await settings.waitForFunction(() => document.getElementById('lyricsDownloadFeedback').textContent.includes('已打开'));
  await waitPreview();
  assert.equal(application.windows().filter((p) => /lyrics-download\.html/.test(p.url())).length, 1);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('lyrics-download.html')).isMinimized()), false);
  await choose('lrc', 'original');
  assert.doesNotMatch(await save(), /译文/);
  await settings.locator('#lyricsDownloadFeedback').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(evidence, 'lyrics-download-settings.png') });
  const downloadLayout = await settings.evaluate(() => {
    const page = document.getElementById('page-general');
    return { client: page.clientWidth, scroll: page.scrollWidth };
  });
  assert.ok(downloadLayout.scroll <= downloadLayout.client + 1, JSON.stringify(downloadLayout));

  await island.locator('#btnLyrFix').dispatchEvent('click');
  let fix;
  for (let i = 0; i < 100; i++) {
    fix = application.windows().find((p) => /lyrfix\.html/.test(p.url()));
    if (fix) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fix, 'Correction window opened');
  await fix.locator('.row').click();
  await fix.waitForFunction(() => document.getElementById('status').textContent.includes('已应用'));
  await fix.locator('#btnDownload').click();
  await fix.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('已打开'));
  await download.waitForFunction(() => document.getElementById('previewContent').textContent.includes('Selected second') && !document.getElementById('btnSave').disabled);
  await choose('md', 'bilingual');
  const manual = await save();
  assert.match(manual, /Selected second  \r\n手动选定译文/);
  assert.doesNotMatch(manual, /Second line/);
  await fix.screenshot({ path: path.join(evidence, 'lyrics-download-correction.png') });
  await fix.close();

  await settings.evaluate(() => window.island.setCfg('expWidth', 0));
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    w.webContents.send('media-state', { type: 'state', hasSession: true, title: 'Verification track', artist: 'MediaIsle', status: 'Paused', duration: 180, position: 60.25, sources: [] });
    w.webContents.send('hover-changed', true);
  });
  await island.waitForFunction(() => !document.getElementById('btnLyricsDownload').disabled && document.getElementById('ylTrack').textContent.includes('Selected second'));
  await island.locator('#btnLyricsDownload').dispatchEvent('click');
  await island.waitForFunction(() => document.getElementById('lyricsDownloadStatus').textContent.includes('已打开'));
  await waitPreview();
  const footerLayout = await island.locator('.e-foot').evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(footerLayout.scroll <= footerLayout.client + 1, JSON.stringify(footerLayout));
  await island.screenshot({ path: path.join(evidence, 'lyrics-download-island.png') });

  await settings.evaluate(() => window.island.openLyricsDownload({ title: '中文歌曲', artist: '验证', lyrics: { lines: [{ t: 1, x: '只有中文歌词' }], trans: [] } }));
  await download.waitForFunction(() => document.getElementById('songTitle').textContent === '中文歌曲' && !document.getElementById('btnSave').disabled);
  assert.equal(await download.locator('input[name="language"][value="english"]').isDisabled(), true);
  assert.equal(await download.locator('input[name="language"][value="bilingual"]').isDisabled(), true);
  await choose('txt', 'chinese');
  assert.match(await save(), /只有中文歌词/);
  await download.screenshot({ path: path.join(evidence, 'lyrics-download-chinese-only.png') });
  await settings.evaluate(() => window.island.openLyricsDownload({ title: 'Empty', lyrics: { lines: [] } }));
  await download.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('没有可下载'));
  assert.equal(await download.locator('#btnSave').isDisabled(), true);
  await settings.locator('#btnLyricsDownload').click();
  await waitPreview();
  await application.evaluate(() => { global.__lyricsSmoke.mode = 'cancel'; });
  await download.locator('#btnSave').click();
  await download.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('已取消'));
  await application.evaluate(() => { global.__lyricsSmoke.mode = 'fail'; });
  await download.locator('#btnSave').click();
  await download.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('ENOENT'));
  assert.equal(await download.locator('#btnSave').isDisabled(), false);
  await application.evaluate(() => { global.__lyricsSmoke.available = false; });
  await settings.waitForFunction(() => document.getElementById('btnLyricsDownload').disabled);
  const saves = await application.evaluate(() => global.__lyricsSmoke.requests);
  assert.equal(saves.length, 14);
  assert.ok(saves.every((request) => request.owner.endsWith('lyrics-download.html')));
  await download.locator('#btnCancel').click();

  if (process.env.MEDIAISLE_TEST_EXE) {
    await settings.locator('[data-page="general"]').click();
    assert.equal(await settings.locator('#updateNotice').isVisible(), true);
    assert.match(await settings.locator('#updateNoticeTitle').innerText(), new RegExp(appVersion.replace(/\./g, '\\.')));
    await settings.screenshot({ path: path.join(evidence, 'updated-settings.png') });
    await settings.locator('#btnDismissNotice').click();
    assert.equal(await settings.locator('#updateNotice').isVisible(), false);
    assert.equal(await settings.evaluate(() => window.island.updateNoticeGet()), null);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', packaged: !!process.env.MEDIAISLE_TEST_EXE, width: size, lyricDownloads: saves.length, errors, evidence }));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
