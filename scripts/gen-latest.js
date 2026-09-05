// 生成 dist/latest.json (上传到 release 供自动更新比对; 含 SHA256 供镜像下载校验)
const fs = require('fs');
const crypto = require('crypto');
const info = JSON.parse(fs.readFileSync('E:/fastmusic/build-info.json', 'utf8'));
const base = info.version.split('+')[0];
const zip = `MediaIsle-${base}-portable.zip`;
const zipPath = `E:/fastmusic/dist/${zip}`;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const out = {
  version: info.version,
  buildDate: info.buildDate,
  zip,
  sha256,
};
fs.writeFileSync('E:/fastmusic/dist/latest.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
