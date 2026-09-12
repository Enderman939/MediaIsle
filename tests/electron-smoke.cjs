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
  await settings.waitForSelector('#appVer:has-text("1.2.0")');
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

  if (process.env.MEDIAISLE_TEST_EXE) {
    await settings.locator('[data-page="general"]').click();
    assert.equal(await settings.locator('#updateNotice').isVisible(), true);
    assert.match(await settings.locator('#updateNoticeTitle').innerText(), /1\.2\.0/);
    await settings.screenshot({ path: path.join(evidence, 'updated-settings.png') });
    await settings.locator('#btnDismissNotice').click();
    assert.equal(await settings.locator('#updateNotice').isVisible(), false);
    assert.equal(await settings.evaluate(() => window.island.updateNoticeGet()), null);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', packaged: !!process.env.MEDIAISLE_TEST_EXE, width: size, errors, evidence }));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
