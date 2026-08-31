// 生成 dist/latest.json (上传到 release 供自动更新比对)
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('E:/fastmusic/package.json', 'utf8'));
const info = JSON.parse(fs.readFileSync('E:/fastmusic/build-info.json', 'utf8'));
const out = {
  version: pkg.version,
  buildDate: info.buildDate,
  zip: 'MediaIsle-' + pkg.version + '-portable.zip',
};
fs.writeFileSync('E:/fastmusic/dist/latest.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
