// 生成 dist/latest.json (上传到 release 供自动更新比对; 含 SHA256 供镜像下载校验)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const root = path.resolve(__dirname, '..');
const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
const notes = require(path.join(root, 'release-notes.json'));
if (info.version !== notes.version) throw new Error('Release notes version mismatch');
const zip = `MediaIsle-${info.version}-portable.zip`;
const zipPath = path.join(root, 'dist', zip);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const out = {
  version: info.version,
  buildDate: info.buildDate,
  zip,
  sha256,
  notes: notes.changes,
};
fs.writeFileSync(path.join(root, 'dist/latest.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
