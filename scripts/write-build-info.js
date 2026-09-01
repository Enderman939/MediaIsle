// 构建前: 版本号 = 基础版本 + 编译日期时间 (semver 构建元数据), 同步写入 package.json 与 build-info.json
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const base = (pkg.version || '1.0.0').split('+')[0];
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.${p2(d.getHours())}${p2(d.getMinutes())}`;
const full = `${base}+${stamp}`;
pkg.version = full;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
const buildDate = d.toISOString();
fs.writeFileSync('build-info.json', JSON.stringify({ version: full, buildDate }));
console.log('[build-info] version =', full, '| buildDate =', buildDate);
