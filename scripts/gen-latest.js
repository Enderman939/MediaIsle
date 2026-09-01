// 生成 dist/latest.json (上传到 release 供自动更新比对)
// zip 文件名用基础版本(构建器命名规则), 完整版本号 = 基础版本+编译日期
const fs = require('fs');
const info = JSON.parse(fs.readFileSync('E:/fastmusic/build-info.json', 'utf8'));
const base = info.version.split('+')[0];
const out = {
  version: info.version,
  buildDate: info.buildDate,
  zip: `MediaIsle-${base}-portable.zip`,
};
fs.writeFileSync('E:/fastmusic/dist/latest.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
