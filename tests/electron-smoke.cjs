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
      const review = Array.from({ length: 36 }, (_, i) => {
        const time = 70 + i * 2;
        return '[' + String(Math.floor(time / 60)).padStart(2, '0') + ':' + String(time % 60).padStart(2, '0') + '.00]Review line ' + (i + 1);
      }).join('\n');
      const body = String(url).includes('/song/lyric') ? {
        lrc: { lyric: (manual ? '[00:01.25]Selected first\n[01:00.25]Selected second\n' : '[00:01.25]First line\n[01:00.25]Second line\n') + review + (manual ? '\n[02:55.00]Selected end' : '\n[02:55.00]End') },
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
  const dockLayout = await island.evaluate(() => {
    const dock = document.getElementById('lyricDock').getBoundingClientRect();
    const island = document.getElementById('island').getBoundingClientRect();
    return { top: dock.top, bottom: dock.bottom, right: dock.right, islandBottom: island.bottom, islandRight: island.right, height: innerHeight };
  });
  assert.ok(dockLayout.top >= dockLayout.islandBottom + 7 && dockLayout.bottom <= dockLayout.height && dockLayout.right <= dockLayout.islandRight, JSON.stringify(dockLayout));
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
      assert.match(content, /\[01:00\.25\]/);
      assert.doesNotMatch(content, /^\[by:/m);
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
  assert.match(manual, /\[01:00\.25\] Selected second  \r\n\[01:00\.25\] 手动选定译文/);
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

  // Search matches original and translated text, and stale playback cannot be sought.
  await application.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    // CDP mouse events do not move the OS cursor used by the native hover poll.
    // Keep that cursor inside the island while exercising real DOM pointer input.
    screen.getCursorScreenPoint = () => ({ x: w.getBounds().x + w.getBounds().width / 2, y: w.getBounds().y + 24 });
    w.webContents.send('hover-changed', true);
  });
  await island.locator('#lyricSearch').click();
  await island.waitForFunction(() => document.activeElement === document.getElementById('lyricSearch'));
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).isFocusable()), true);
  await island.keyboard.type('手动');
  await island.waitForSelector('#ylTrack mark');
  assert.equal(await island.locator('#ylTrack .yl-line').count(), 1);
  assert.equal(await island.locator('#ylTrack mark').innerText(), '手动');
  assert.equal(await island.locator('#lyricScrollbar').isHidden(), true, 'A single search result needs no scrollbar');
  await island.screenshot({ path: path.join(evidence, 'lyrics-search-floating.png') });
  await island.locator('#ylTrack .yl-line').click();
  await island.waitForFunction(() => document.getElementById('lyricSearchStatus').textContent.includes('改变'));
  await island.locator('#btnClearLyricSearch').click();
  assert.equal(await island.locator('#lyricSearch').inputValue(), '');
  assert.equal(await island.locator('#btnClearLyricSearch').isHidden(), true);
  assert.equal(await island.locator('#ylTrack .yl-line').count(), 39);
  await island.locator('#btnFollowLyric').click();
  await island.locator('#lyricViewport').dispatchEvent('wheel', { deltaY: 80 });
  assert.equal(await island.locator('#lyricViewport').evaluate((el) => el.classList.contains('manual')), true);
  assert.equal(await island.locator('#ylTrack .yl-line').count(), 39, 'Manual review includes lines outside the automatic virtual window');
  const manualTransform = await island.locator('#ylTrack').evaluate((el) => getComputedStyle(el).transform);
  const manualScroll = await island.locator('#lyricViewport').evaluate((el) => el.scrollTop);
  assert.ok(manualScroll > 0);
  await island.waitForSelector('#lyricScrollbar');
  assert.equal(await island.locator('#lyricViewport').evaluate((el) => getComputedStyle(el).scrollbarWidth), 'none');
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    w.webContents.send('media-state', { type: 'state', hasSession: true, title: 'Verification track', artist: 'MediaIsle', status: 'Paused', duration: 180, position: 175, sources: [] });
    w.webContents.send('hover-changed', true);
  });
  await island.waitForTimeout(200);
  assert.equal(await island.locator('#ylTrack').evaluate((el) => getComputedStyle(el).transform), manualTransform);
  assert.equal(await island.locator('#lyricViewport').evaluate((el) => el.scrollTop), manualScroll, 'Playback updates do not move the review position');
  await island.screenshot({ path: path.join(evidence, 'lyrics-manual-review.png') });
  const thumb = await island.locator('#lyricScrollThumb').boundingBox();
  assert.ok(thumb);
  await island.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await island.mouse.down();
  await island.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 38, { steps: 6 });
  await island.mouse.up();
  assert.ok(await island.locator('#lyricViewport').evaluate((el) => el.scrollTop) > manualScroll, 'Dragging the custom thumb scrolls the lyrics');
  await island.waitForFunction(() => document.activeElement === document.getElementById('lyricScrollbar'));
  await island.keyboard.press('End');
  const endScroll = await island.locator('#lyricViewport').evaluate((el) => ({ top: el.scrollTop, end: el.scrollHeight - el.clientHeight }));
  assert.ok(Math.abs(endScroll.top - endScroll.end) <= 1, JSON.stringify(endScroll));
  assert.equal(await island.locator('#lyricScrollbar').getAttribute('aria-valuenow'), '100');
  await island.keyboard.press('Home');
  assert.equal(await island.locator('#lyricViewport').evaluate((el) => el.scrollTop), 0);
  const rail = await island.locator('#lyricScrollbar').boundingBox();
  await island.locator('#lyricScrollbar').click({ position: { x: 6, y: rail.height - 3 } });
  assert.equal(await island.locator('#lyricScrollbar').getAttribute('aria-valuenow'), '100', 'Clicking the custom track moves to the corresponding lyric position');
  await island.locator('#btnFollowLyric').click();
  await island.waitForFunction(() => !document.getElementById('lyricViewport').classList.contains('manual') && document.querySelector('#ylTrack .on')?.textContent.includes('Selected end'));
  assert.equal(await island.locator('#lyricScrollbar').isHidden(), true);

  // Persist a custom bilingual edit and verify preview, downloaded file and island use it.
  await application.evaluate(() => { global.__lyricsSmoke.mode = 'save'; });
  await settings.evaluate(() => window.island.openLyricsDownload({ title: 'Verification track', artist: 'MediaIsle' }));
  await waitPreview();
  await choose('lrc', 'bilingual');
  await download.locator('#btnEdit').click();
  await download.locator('#editorLines input[aria-label="原文第 2 句文本"]').fill('Edited second');
  await download.locator('#editorLines input[aria-label="原文第 2 句时间（秒）"]').fill('');
  await download.locator('#editorLines input[aria-label="原文第 2 句时间（秒）"]').fill('62.75');
  await download.locator('#editorTrans input[type="number"]').waitFor();
  assert.equal(await download.locator('#editorTrans input[type="number"]').inputValue(), '62.75');
  await download.locator('#editorTrans input[aria-label="译文第 1 句文本"]').fill('自定义译文');
  await download.waitForFunction(() => document.getElementById('previewContent').textContent.includes('Edited second'));
  assert.equal(await download.locator('#btnSave').isDisabled(), true);
  await download.locator('#btnCancel').click();
  await download.waitForFunction(() => document.getElementById('downloadFeedback').textContent.includes('未保存'));
  const rejectedOpen = await settings.evaluate(() => window.island.openLyricsDownload({ title: 'Other track' }));
  assert.equal(rejectedOpen.ok, false);
  await download.locator('#btnSaveCustom').click();
  await download.waitForFunction(() => document.getElementById('editorFeedback').textContent.includes('已保存'));
  await choose('lrc', 'bilingual');
  const edited = await save();
  assert.match(edited, /\[01:02\.75\]Edited second\r\n\[01:02\.75\]自定义译文/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'lyrics-custom.json')))['["verification track","mediaisle"]'].lines[1].t, 62.75);
  const editorLayout = await download.evaluate(() => ({ client: document.querySelector('main').clientWidth, scroll: document.querySelector('main').scrollWidth, bottom: document.getElementById('btnSave').getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(editorLayout.scroll <= editorLayout.client + 1 && editorLayout.bottom <= editorLayout.height, JSON.stringify(editorLayout));
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('lyrics-download.html')).setSize(640, 800); });
  await download.evaluate(() => { document.querySelector('main').scrollTop = 0; });
  await download.screenshot({ path: path.join(evidence, 'lyrics-editor.png') });
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    w.webContents.send('media-state', { type: 'state', hasSession: true, title: 'Verification track', artist: 'MediaIsle', status: 'Paused', duration: 180, position: 62.75, sources: [] });
    w.webContents.send('hover-changed', true);
  });
  await island.waitForFunction(() => document.getElementById('ylTrack').textContent.includes('Edited second'));
  await download.locator('#btnCancel').click();
  await settings.evaluate(() => window.island.openLyricsDownload({ title: 'Verification track', artist: 'MediaIsle' }));
  for (let i = 0; i < 100; i++) { download = application.windows().find((p) => /lyrics-download\.html/.test(p.url())); if (download) break; await new Promise((r) => setTimeout(r, 100)); }
  await waitPreview();
  assert.equal(await download.locator('input[name="format"]:checked').inputValue(), 'lrc');
  assert.equal(await download.locator('input[name="language"]:checked').inputValue(), 'bilingual');
  assert.match(await download.locator('#previewContent').innerText(), /自定义译文/);

  // Favorites selection opens batch mode and the actual exporter emits per-track results.
  await island.evaluate(() => {
    localStorage.setItem('fav:test|Verification track|MediaIsle', JSON.stringify({ t: 'Verification track', a: 'MediaIsle' }));
    localStorage.setItem('fav:test|中文歌曲|验证', JSON.stringify({ t: '中文歌曲', a: '验证' }));
  });
  await island.locator('#eSource').dispatchEvent('click');
  await island.locator('#lyricDock').waitFor({ state: 'hidden' });
  for (const input of await island.locator('#flList input').all()) await input.check();
  await island.locator('#flExport').click();
  await download.waitForFunction(() => !document.getElementById('batchPanel').hidden && !document.getElementById('btnSave').disabled);
  assert.equal(await download.locator('#batchTracks input').count(), 2);
  await application.evaluate(({ dialog }, outputDir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outputDir] }); }, temp);
  await download.locator('#btnSave').click();
  await download.waitForFunction(() => document.getElementById('batchSummary').textContent.includes('已完成') && document.getElementById('batchSummary').textContent.includes('失败 1'));
  assert.match(await download.locator('#batchSummary').innerText(), /成功 1/);
  assert.match(await download.locator('#batchResults').innerText(), /没有译文|没有可下载/);
  assert.equal(fs.existsSync(path.join(temp, 'Verification track - MediaIsle.bilingual (1).lrc')), true);
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('lyrics-download.html')).setSize(480, 540); });
  const batchLayout = await download.evaluate(() => ({ client: document.querySelector('main').clientWidth, scroll: document.querySelector('main').scrollWidth, bottom: document.getElementById('btnSave').getBoundingClientRect().bottom, height: innerHeight }));
  assert.ok(batchLayout.scroll <= batchLayout.client + 1 && batchLayout.bottom <= batchLayout.height, JSON.stringify(batchLayout));
  await download.screenshot({ path: path.join(evidence, 'lyrics-batch-export.png') });
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
  const downloads = await application.evaluate(() => global.__lyricsSmoke.requests.length);
  console.log(JSON.stringify({ result: 'PASS', packaged: !!process.env.MEDIAISLE_TEST_EXE, width: size, saveDialogs: downloads, customEdit: true, searchAndReview: true, batchTracks: 2, errors, evidence }));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
