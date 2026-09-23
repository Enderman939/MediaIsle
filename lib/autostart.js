'use strict';
// Linux XDG 自启动 (Electron 的 setLoginItemSettings 在 Linux 不可用):
// 写入 ~/.config/autostart/MediaIsle.desktop

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = () => path.join(os.homedir(), '.config', 'autostart', 'MediaIsle.desktop');

function entryFor(execLine) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=MediaIsle',
    'Comment=Dynamic Island style media controller',
    `Exec=${execLine}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function isEnabled() {
  try { return fs.existsSync(FILE()); } catch { return false; }
}

function setEnabled(execLine, on) {
  const f = FILE();
  if (!on) {
    try { fs.rmSync(f, { force: true }); } catch { }
    return false;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entryFor(execLine));
  return true;
}

module.exports = { FILE, entryFor, isEnabled, setEnabled };
