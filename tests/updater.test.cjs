const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('update installer copies staged files, preserves user files and rolls back on failure', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaisle-update-'));
  const installer = path.resolve(__dirname, '../scripts/install-update.ps1');
  try {
    for (const fail of [false, true]) {
      const dir = path.join(root, fail ? 'failure' : 'success');
      const installDir = path.join(dir, 'install');
      const newDir = path.join(dir, 'new');
      fs.mkdirSync(installDir, { recursive: true }); fs.mkdirSync(newDir);
      fs.writeFileSync(path.join(installDir, 'MediaIsle.exe'), 'old-exe');
      fs.writeFileSync(path.join(installDir, 'user-config.json'), 'preserve');
      fs.writeFileSync(path.join(newDir, 'MediaIsle.exe'), 'new-exe');
      fs.mkdirSync(path.join(newDir, 'resources'));
      fs.writeFileSync(path.join(newDir, 'resources', 'app.asar'), 'new-app');
      if (fail) fs.writeFileSync(path.join(installDir, 'resources'), 'blocks-directory');
      const plan = { pid: 2147483647, installDir, newDir, exeName: 'MediaIsle.exe', to: '1.2.0', resultFile: path.join(dir, 'result.json'), ui: {} };
      const planPath = path.join(dir, 'plan.json'); fs.writeFileSync(planPath, JSON.stringify(plan));
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-PlanPath', planPath, '-Headless', '-NoLaunch'], { encoding: 'utf8', timeout: 14000 });
      assert.equal(run.status, fail ? 1 : 0, run.stderr + run.stdout);
      const result = JSON.parse(fs.readFileSync(plan.resultFile, 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(result.status, fail ? 'error' : 'installed');
      assert.equal(fs.readFileSync(path.join(installDir, 'MediaIsle.exe'), 'utf8'), fail ? 'old-exe' : 'new-exe');
      assert.equal(fs.readFileSync(path.join(installDir, 'user-config.json'), 'utf8'), 'preserve');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
