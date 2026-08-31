// 构建前写入编译日期 (打包版用于自动更新比对)
const fs = require('fs');
fs.writeFileSync('build-info.json', JSON.stringify({ buildDate: new Date().toISOString() }));
console.log('[build-info] buildDate =', new Date().toISOString());
