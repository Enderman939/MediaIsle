// =====================================================================
// MediaIsle - 主进程
// 灵动岛风格 Windows 媒体控制悬浮窗
//  - 透明无边框置顶窗, 悬浮于屏幕顶部中间
//  - 默认鼠标穿透, 悬停岛内时恢复交互
//  - 通过 PowerShell 桥接(bridge.ps1)读取/控制系统媒体(SMTC)
// =====================================================================
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, net, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

// ---------------------------------------------------------------- 更名数据迁移
// 应用由 FastMusic Island 更名 MediaIsle, userData 目录随名变化,
// 首次启动时把旧目录的配置与统计数据一次性搬迁, 避免用户数据"丢失"
try {
  const newDir = app.getPath('userData');
  const appdataDir = path.dirname(newDir);
  for (const oldName of ['FastMusic Island', 'fastmusic-island']) {
    if (path.basename(newDir).toLowerCase() === oldName.toLowerCase()) continue;
    const oldDir = path.join(appdataDir, oldName);
    if (!fs.existsSync(oldDir)) continue;
    let copied = false;
    for (const f of ['config.json', 'stats.json']) {
      const src = path.join(oldDir, f);
      const dst = path.join(newDir, f);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) { fs.copyFileSync(src, dst); copied = true; }
      } catch { }
    }
    if (copied) console.log('[migrate] 已从 ' + oldName + ' 迁移用户数据 -> ' + path.basename(newDir));
    break;
  }
} catch { }

// 窗口尺寸: 容纳展开态(含右侧歌词竖栏)灵动岛 + 少量余量(动画/阴影)
const WIN_W = 710;
const WIN_H = 258;
const WIN_TOP_GAP = 8; // 距屏幕顶部间距

// 命令文件: 主进程 -> PS 桥接的单向命令通道(PS 5.1 无法非阻塞读 stdin)
const CMD_FILE = path.join(os.tmpdir(), 'fastmusic-island-cmd.json');
const CMD_TMP = CMD_FILE + '.tmp';

// ---------------------------------------------------------------- 错误日志
// 所有错误(渲染层 console.error / 主进程异常 / 桥接 stderr)统一:
//   1) 打印到控制台  2) 追加写入 error.log, 方便用户复制反馈
const LOG_FILE = path.join(app.getPath('userData'), 'error.log');
function logErr(tag, ...parts) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${tag} ${parts.map((p) => (p instanceof Error ? (p.stack || p.message) : String(p))).join(' ')}`;
  console.error(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { }
}
process.on('uncaughtException', (err) => logErr('[main:uncaught]', err));
process.on('unhandledRejection', (reason) => logErr('[main:unhandled]', reason));

// 渲染层 console 转发: 带来源文件:行号; error 级别额外落盘
function attachConsoleForward(winObj, tag) {
  winObj.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const src = sourceId ? ` (${String(sourceId).split(/[\\/]/).pop()}:${line})` : '';
    if (level >= 2) logErr(`[${tag}]`, message + src);
    else console.log(`[${tag}]`, message + src);
  });
}

// ---------------------------------------------------------------- 运行日志缓冲
// 包装全局 console: 主进程日志 + 各窗口转发的日志统一进环形缓冲,
// 设置窗口的"日志"页读取展示 (最多保留 600 行)
const LOG_BUF_MAX = 600;
const logBuf = [];
let logSeq = 0;
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
function fmtArgs(a) {
  return a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
}
function pushLog(level, line) {
  const entry = { i: ++logSeq, t: Date.now(), level, line };
  logBuf.push(entry);
  if (logBuf.length > LOG_BUF_MAX) logBuf.splice(0, logBuf.length - LOG_BUF_MAX);
  try { if (setWin && !setWin.isDestroyed()) setWin.webContents.send('log-appended', entry); } catch { }
}
console.log = (...a) => { const line = fmtArgs(a); pushLog('info', line); origLog(line); };
console.error = (...a) => { const line = fmtArgs(a); pushLog('error', line); origErr(line); };
ipcMain.handle('log-get', () => logBuf.slice());
ipcMain.on('log-clear', () => { logBuf.length = 0; });

// 配置持久化(毛玻璃/桌面歌词)
const CFG_FILE = path.join(app.getPath('userData'), 'config.json');
let cfg = { glass: false, dlyr: false, fsHide: true, bilingual: true, lyrSize: 12.5, dlyrSize: 32, dlyrSubSize: 17, islandPos: 'top', taskbar: false, lyrPickSave: true, lyrSources: ['soda', 'netease', 'qq', 'kugou'], lyrStrategy: 'race' };
try {
  const raw = fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '');
  Object.assign(cfg, JSON.parse(raw));
} catch (e) {
  console.error('[cfg] 配置加载失败, 使用默认值:', (e && e.message) || e);
}
let cfgTimer = null;
function saveCfg() {
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => {
    try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg)); } catch { }
  }, 600);
}

// 旧版单值歌词策略迁移: lyrics -> lyrSources + lyrStrategy
if (!Array.isArray(cfg.lyrSources)) {
  const old = cfg.lyrics;
  if (['netease', 'qq', 'kugou', 'soda'].includes(old)) cfg.lyrSources = [old];
  else cfg.lyrSources = ['soda', 'netease', 'qq', 'kugou'];
  cfg.lyrStrategy = old === 'quality' ? 'quality' : 'race';
  saveCfg();
}

// ---------------------------------------------------------------- 听歌统计
// 主进程统一记录: 每日时长 + 每曲目播放次数/时长 (设置窗口展示图表)
const STATS_FILE = path.join(app.getPath('userData'), 'stats.json');
let stats = { days: {}, tracks: {}, lastPlayKey: '' };
try {
  const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  if (loaded && typeof loaded === 'object') {
    stats.days = loaded.days || {};
    stats.tracks = loaded.tracks || {};
    stats.lastPlayKey = loaded.lastPlayKey || '';
  }
} catch { }
let statsDirty = false;
let statsPersistTimer = null;

function todayKeyStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 864e5);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtHMain(sec) {
  if (sec < 60) return '';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟';
  return (sec / 3600).toFixed(1) + ' 小时';
}
function scheduleStatsPersist() {
  if (statsPersistTimer) return;
  statsPersistTimer = setTimeout(() => {
    statsPersistTimer = null;
    if (!statsDirty) return;
    statsDirty = false;
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch { }
    // 设置窗口打开时推送刷新
    if (setWin && !setWin.isDestroyed()) setWin.webContents.send('stats-updated');
  }, 3000);
}
function bumpStats(msg) {
  bumpStats._t = bumpStats._t || Date.now();
  const now = Date.now();
  const dt = Math.min(2, Math.max(0, (now - bumpStats._t) / 1000));
  bumpStats._t = now;
  if (!msg.hasSession || msg.status !== 'Playing' || !msg.title) return;

  const tk = todayKeyStr();
  if (!stats.days[tk]) stats.days[tk] = 0;
  stats.days[tk] += dt;

  const key = (msg.appId || '') + '|' + msg.title + '|' + (msg.artist || '');
  let tr = stats.tracks[key];
  if (!tr) tr = stats.tracks[key] = { t: msg.title, a: msg.artist || '', s: msg.source || '', sec: 0, plays: 0, last: 0 };
  tr.sec += dt;
  tr.last = now;
  if (key !== stats.lastPlayKey) {
    tr.plays += 1;
    stats.lastPlayKey = key;
    // 播放历史时间线
    stats.history = stats.history || [];
    stats.history.push({ t: Date.now(), title: msg.title, artist: msg.artist || '', src: msg.source || '' });
    if (stats.history.length > 2000) stats.history.splice(0, stats.history.length - 2000);
  }

  // 曲目数上限: 超出淘汰最久未播的
  const keys = Object.keys(stats.tracks);
  if (keys.length > 600) {
    keys.sort((x, y) => (stats.tracks[x].last || 0) - (stats.tracks[y].last || 0));
    for (let i = 0; i < 100; i++) delete stats.tracks[keys[i]];
  }
  statsDirty = true;
  scheduleStatsPersist();

  // 主窗底部统计文本 (≥5s 推送一次)
  if (now - (bumpStats._push || 0) > 5000) {
    bumpStats._push = now;
    const t = fmtHMain(stats.days[tk] || 0);
    let week = 0;
    for (let i = 0; i < 7; i++) week += stats.days[todayKeyStr(i)] || 0;
    const w = fmtHMain(week);
    const text = t && w ? `今日 ${t} · 本周 ${w}` : (t ? `今日 ${t}` : (w ? `本周 ${w}` : ''));
    send('stats-text', text);
  }
}

let win = null;
let bridge = null;
let bridgeRestartCount = 0;
let bridgeLastStart = 0;
let artCache = { hash: null, data: null };
let tray = null;
let hiddenByUser = false;
let hiddenByFs = false;
let lastFs = false;

function send(ch, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
}

// ---------------------------------------------------------------- 窗口
function positionWindow() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const y = cfg.islandPos === 'bottom'
    ? workArea.y + workArea.height - WIN_H - 8
    : workArea.y + WIN_TOP_GAP;
  win.setPosition(
    Math.round(workArea.x + (workArea.width - WIN_W) / 2),
    Math.round(y),
    false
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: !cfg.taskbar,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,       // 不抢焦点
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  try { win.setVisibleOnAllWorkspaces(true); } catch { }
  positionWindow();

  // 默认鼠标穿透(悬停检测由主进程光标轮询完成)
  win.setIgnoreMouseEvents(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    keepOnTop();
    send('glass-changed', !!cfg.glass);
    send('bilingual-changed', cfg.bilingual !== false);
    send('lyr-size-changed', cfg.lyrSize || 12.5);
  });

  // 调试: 转发渲染层 console 输出 (error/warning 级别同时写入 error.log)
  attachConsoleForward(win, 'renderer');

  // 分辨率/显示器变化时重新定位
  screen.on('display-metrics-changed', positionWindow);
  screen.on('display-added', positionWindow);

  if (process.env.ISLAND_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---------------------------------------------------------------- 桥接
function startBridge() {
  bridgeLastStart = Date.now();
  // 打包后 bridge.ps1 位于 asar 解包目录(PowerShell 子进程无法读取 asar 内部)
  let bridgePath = path.join(__dirname, 'bridge.ps1');
  if (bridgePath.includes('app.asar') && !bridgePath.includes('app.asar.unpacked')) {
    const alt = bridgePath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(alt)) bridgePath = alt;
  }
  bridge = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', bridgePath,
    '-IntervalMs', '500',
    '-CommandFile', CMD_FILE,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let buf = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { handleBridgeLine(JSON.parse(line)); }
      catch { /* 忽略坏行 */ }
    }
  });

  bridge.stderr.setEncoding('utf8');
  bridge.stderr.on('data', (d) => logErr('[bridge:stderr]', String(d).trim()));

  bridge.on('exit', (code) => {
    bridge = null;
    const ranMs = Date.now() - bridgeLastStart;
    if (ranMs > 60000) bridgeRestartCount = 0; // 稳定运行过则重置计数
    if (bridgeRestartCount < 5) {
      bridgeRestartCount++;
      setTimeout(() => { if (!bridge && !app.isQuitting) startBridge(); }, 1500);
    } else {
      console.error(`[bridge] 桥接进程退出(code=${code}), 已达重启上限`);
      logErr('[bridge]', `桥接进程退出(code=${code}), 已达重启上限`);
    }
  });
}

function handleBridgeLine(msg) {
  if (!win || win.isDestroyed()) return;
  if (msg.type === 'ready') {
    console.log('[bridge] ready');
  } else if (msg.type === 'state') {
    // 封面缓存: bridge 只在封面变化帧附带 art, 此处补全其余帧
    if (msg.art) {
      artCache = { hash: msg.artHash, data: msg.art };
    } else if (msg.artHash && artCache.hash === msg.artHash) {
      msg.art = artCache.data;
    }
    if (!msg.hasSession) artCache = { hash: null, data: null };
    bumpStats(msg);
    win.webContents.send('media-state', msg);
  } else if (msg.type === 'error') {
    logErr('[bridge]', msg.message);
    if (msg.status && msg.status !== lastBridgeStatus) { lastBridgeStatus = msg.status; updateThumbar(); }
  } else if (msg.type === 'volume') {
    send('volume-changed', msg);
  } else if (msg.type === 'fs') {
    // 全屏应用前台时隐藏岛体, 退出全屏恢复 (可在设置中关闭)
    if (msg.v && cfg.fsHide && win && win.isVisible() && !hoverInside) {
      hiddenByFs = true;
      win.hide();
    } else if (!msg.v && hiddenByFs) {
      hiddenByFs = false;
      if (!hiddenByUser) { win.showInactive(); keepOnTop(); }
    }
  }
}

function sendCommand(cmd, val, extra) {
  // 数值 -> position(seek/volume), 字符串 -> appId(switch-source)
  let payload;
  if (typeof val === 'number' && isFinite(val)) payload = { cmd, position: val };
  else if (typeof val === 'string' && val.length) payload = { cmd, appId: val };
  else payload = { cmd };
  if (extra) Object.assign(payload, extra);
  try {
    // 追加写入命令文件(先写临时文件再原子替换, 避免桥接读到半行)
    let content = JSON.stringify(payload) + '\n';
    try {
      if (fs.existsSync(CMD_FILE)) {
        const prev = fs.readFileSync(CMD_FILE, 'utf8');
        if (prev.length < 4096) content = prev + content; // 未消费的命令合并
      }
    } catch { /* 读旧文件失败则覆盖 */ }
    fs.writeFileSync(CMD_TMP, content, 'utf8');
    fs.renameSync(CMD_TMP, CMD_FILE);
  } catch (err) {
    logErr('[bridge]', '命令写入失败:', err.message);
  }
}

// ---------------------------------------------------------------- IPC
// 悬停检测: Electron 的 setIgnoreMouseEvents(forward) 在 Windows 上
// 无法可靠转发 mousemove, 改为主进程轮询光标位置做命中检测
const ISLAND_RECTS = {
  idle:           { w: 92,  h: 36  }, // 尺寸与 renderer/style.css 保持一致
  compact:        { w: 238, h: 37  },
  volume:         { w: 238, h: 37  },
  notify:         { w: 320, h: 54  },
  expanded:       { w: 672, h: 214 },
  'expanded-empty': { w: 406, h: 214 },
  favlist:        { w: 406, h: 214 },
};
const ISLAND_TOP = 3; // 岛距窗口顶部偏移(stage padding-top)

let islandState = 'idle';
let hoverInside = false;
let islandDragging = false;

function islandScreenRect() {
  const s = ISLAND_RECTS[islandState] || ISLAND_RECTS.idle;
  const [wx, wy] = win.getPosition();
  return {
    x: Math.round(wx + (WIN_W - s.w) / 2),
    y: wy + ISLAND_TOP,
    w: s.w,
    h: s.h,
  };
}

function evaluateHover() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const r = islandScreenRect();
  const c = screen.getCursorScreenPoint();
  const inside = c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h;
  const target = islandDragging ? true : inside; // 拖动进度时保持展开
  if (target !== hoverInside) {
    hoverInside = target;
    win.setIgnoreMouseEvents(!hoverInside);
    win.webContents.send('hover-changed', hoverInside);
  }
}

setInterval(evaluateHover, 80);

// ---------------------------------------------------------------- 置顶保持
// Windows 下其他应用置顶/激活会挤掉我们的 topmost 状态, 需周期性重新宣告。
// moveTop() 只调整 z-order, 不抢焦点。
function keepOnTop() {
  try {
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
    }
  } catch { }
  try {
    if (dlWin && !dlWin.isDestroyed() && dlWin.isVisible()) {
      dlWin.setAlwaysOnTop(true, 'screen-saver');
      dlWin.moveTop();
    }
  } catch { }
}
setInterval(keepOnTop, 1200);

ipcMain.on('island-state', (_e, st) => {
  if (ISLAND_RECTS[st]) islandState = st;
  evaluateHover(); // 形态变化后立即按新矩形重估
});

ipcMain.on('island-dragging', (_e, d) => {
  islandDragging = !!d;
  if (!islandDragging) evaluateHover();
});

ipcMain.on('media-command', (_e, cmd, val) => {
  sendCommand(cmd, val);
});

// ---------------------------------------------------------------- 自动更新
// 仅打包版启用: 从 GitHub Release 拉取 latest.json, 比对编译日期,
// 发现新构建则下载 zip -> 解压 -> 由 cmd 脚本在进程退出后换文件并重启。
// 源代码运行 (app.isPackaged === false 或缺 build-info.json) 时不比对。
const REPO = 'Enderman939/MediaIsle';
let localBuildDate = null;
try {
  if (app.isPackaged) {
    localBuildDate = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')).buildDate || null;
  }
} catch { }

let updateAvail = null;     // 最近一次检查的结果
let updateStage = '';       // '' | 'download' | 'extract' | 'restart' | 'error'
let updateBusy = false;
let updateLastCheck = 0;
let updateProg = { received: 0, total: 0, percent: 0, speed: 0 };

function send2(ch, ...args) {
  send(ch, ...args);
  try { if (setWin && !setWin.isDestroyed()) setWin.webContents.send(ch, ...args); } catch { }
}

async function checkForUpdate() {
  if (!app.isPackaged || !localBuildDate) return null;
  try {
    // net.fetch: Chromium 网络栈, 走系统代理与系统证书 (直连 fetch 在代理/拦截环境下不可用)
    const res = await net.fetch('https://github.com/' + REPO + '/releases/latest/download/latest.json', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const info = await res.json();
    const remote = Date.parse(info.buildDate || '');
    const local = Date.parse(localBuildDate);
    if (!(remote > 0) || !(local > 0)) return null;
    // 容忍 60s 时钟偏差
    if (remote - local > 60e3) return { version: info.version || '', buildDate: info.buildDate, zip: info.zip || '' };
  } catch { }
  return null;
}

async function runUpdateCheck(force) {
  if (!app.isPackaged || !localBuildDate || updateBusy) return updateAvail;
  const now = Date.now();
  if (!force && now - updateLastCheck < 10 * 60e3) return updateAvail;
  updateLastCheck = now;
  updateAvail = await checkForUpdate();
  if (updateAvail) {
    try { tray.displayBalloon({ title: 'MediaIsle', content: '发现新版本 (构建于 ' + updateAvail.buildDate.slice(0, 10) + ')，可在设置中更新' }); } catch { }
  }
  return updateAvail;
}

// ---------------------------------------------------------------- 更新下载
// 多连接分段并行: GitHub 大文件单连接在国内环境极慢, 32 段 8 并发可成倍提速;
// 任一段失败自动重试, Range 不可用/并行失败整体回退单流直连
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emitDownloadProgress(received, total, t0) {
  const now = Date.now();
  if (now - (emitDownloadProgress._last || 0) < 250) return;
  emitDownloadProgress._last = now;
  updateProg = {
    received,
    total,
    percent: total ? (received / total) * 100 : 0,
    speed: received / Math.max(0.5, (now - t0) / 1000),
  };
  send2('update-status', { stage: 'download', ...updateProg });
}

async function singleDownload(url) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    emitDownloadProgress(received, total, t0);
  }
  emitDownloadProgress._last = 0;
  updateProg = { received, total, percent: 100, speed: updateProg.speed };
  send2('update-status', { stage: 'download', ...updateProg });
  return Buffer.concat(chunks);
}

async function parallelDownload(url, total) {
  const big = Buffer.alloc(total);
  const SEGMENTS = 32;
  const CONCURRENCY = 8;
  const segSize = Math.ceil(total / SEGMENTS);
  let nextSeg = 0;
  let doneBytes = 0;
  const t0 = Date.now();
  let lastEmit = 0;
  const prog = () => {
    const now = Date.now();
    if (now - lastEmit < 250) return;
    lastEmit = now;
    updateProg = {
      received: doneBytes,
      total,
      percent: (doneBytes / total) * 100,
      speed: doneBytes / Math.max(0.5, (now - t0) / 1000),
    };
    send2('update-status', { stage: 'download', ...updateProg });
  };
  const grab = async (i) => {
    const start = i * segSize;
    const end = Math.min(total, start + segSize) - 1;
    if (start > end) return;
    let lastErr = null;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await net.fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (r.status !== 206) throw new Error('RANGE_UNSUPPORTED(' + r.status + ')');
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== end - start + 1) throw new Error('SIZE_MISMATCH');
        big.set(buf, start);
        doneBytes += buf.length;
        prog();
        return;
      } catch (e) {
        lastErr = e;
        if (String(e.message || '').startsWith('RANGE_UNSUPPORTED')) throw e;
        await sleep(400);
      }
    }
    throw lastErr;
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => (async () => {
    for (;;) {
      const i = nextSeg++;
      if (i >= SEGMENTS) return;
      await grab(i);
    }
  })()));
  if (doneBytes !== total) throw new Error('INCOMPLETE ' + doneBytes + '/' + total);
  emitDownloadProgress._last = 0;
  updateProg = { received: total, total, percent: 100, speed: updateProg.speed };
  return big;
}

async function downloadUpdate(url) {
  let total = 0;
  let ranges = false;
  try {
    const head = await net.fetch(url, { method: 'HEAD' });
    total = Number(head.headers.get('content-length')) || 0;
    ranges = (head.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
  } catch { }
  if (total > 0 && ranges && total >= 8 * 1048576) {
    try {
      return await parallelDownload(url, total);
    } catch (e) {
      console.error('[update] 并行下载失败, 回退单流:', (e && e.message) || e);
    }
  }
  return await singleDownload(url);
}

async function applyUpdate() {
  if (!app.isPackaged || updateBusy) return false;
  const avail = updateAvail || await runUpdateCheck(true);
  if (!avail || !avail.zip) return false;
  updateBusy = true;
  try {
    const dir = path.join(app.getPath('userData'), 'update');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zipPath = path.join(dir, 'update.zip');

    updateStage = 'download';
    updateProg = { received: 0, total: 0, percent: 0, speed: 0 };
    send2('update-status', { stage: updateStage });
    const data = await downloadUpdate('https://github.com/' + REPO + '/releases/latest/download/' + encodeURIComponent(avail.zip));
    fs.writeFileSync(zipPath, data);

    updateStage = 'extract';
    send2('update-status', { stage: updateStage });
    const newDir = path.join(dir, 'new');
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + newDir + '" -Force'], { windowsHide: true });
      ps.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('解压失败 (exit ' + c + ')'))));
      ps.on('error', reject);
    });

    // 生成换文件脚本: 等进程退出 -> 覆盖安装目录 -> 重启 (分离执行, 独立于本进程存活)
    updateStage = 'restart';
    send2('update-status', { stage: updateStage });
    const exeName = path.basename(app.getPath('exe'));
    const installDir = path.dirname(app.getPath('exe'));
    const cmdPath = path.join(dir, 'update.cmd');
    const cmd = [
      '@echo off',
      // ping 延时: timeout 在无控制台的分离进程里会因输入重定向失败
      'ping -n 3 127.0.0.1 >nul',
      'taskkill /f /im ' + exeName + ' >nul 2>&1',
      'xcopy /e /y /i "' + newDir + '\\*" "' + installDir + '" >nul',
      'rmdir /s /q "' + newDir + '"',
      'del /q "' + zipPath + '"',
      'start "" "' + path.join(installDir, exeName) + '"',
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n');
    fs.writeFileSync(cmdPath, cmd);
    const child = spawn('cmd.exe', ['/c', cmdPath], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => app.quit(), 800);
    return true;
  } catch (e) {
    updateStage = 'error';
    send2('update-status', { stage: 'error', message: (e && e.message) || String(e) });
    updateBusy = false;
    return false;
  }
}

// ---------------------------------------------------------------- 任务栏播放控制按钮
let thumbarIcons = null;
let lastBridgeStatus = '';
let lastThumbarState = null;
function getThumbarIcons() {
  if (!thumbarIcons) {
    const p = (n) => nativeImage.createFromPath(path.join(__dirname, 'assets', 'thumbar', n));
    thumbarIcons = { prev: p('prev.png'), play: p('play.png'), pause: p('pause.png'), next: p('next.png') };
  }
  return thumbarIcons;
}
function updateThumbar() {
  try {
    if (!win || win.isDestroyed() || process.platform !== 'win32' || !cfg.taskbar) return;
    const playing = lastBridgeStatus === 'Playing' || lastBridgeStatus === 'Changing';
    if (playing === lastThumbarState) return;
    lastThumbarState = playing;
    const ic = getThumbarIcons();
    win.setThumbarButtons([
      { tooltip: '上一首', icon: ic.prev, click: () => sendCommand('prev') },
      { tooltip: playing ? '暂停' : '播放', icon: playing ? ic.pause : ic.play, click: () => sendCommand('toggle') },
      { tooltip: '下一首', icon: ic.next, click: () => sendCommand('next') },
    ]);
  } catch { }
}

ipcMain.handle('update-get', async () => {
  if (app.isPackaged && localBuildDate) await runUpdateCheck(false);
  return { packaged: !!app.isPackaged, localBuildDate, available: updateAvail, stage: updateStage, busy: updateBusy, prog: updateProg };
});
ipcMain.handle('update-apply', () => applyUpdate());

// ---------------------------------------------------------------- 备份导入/导出 + 定时停止
ipcMain.handle('backup-export', async (_e, favs) => {
  try {
    const win2 = BrowserWindow.getFocusedWindow() || win || setWin;
    const res = await dialog.showSaveDialog(win2, {
      title: '导出备份',
      defaultPath: 'MediaIsle-备份-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    const data = {
      app: 'MediaIsle',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      config: cfg,
      stats,
      favs: favs || {},
    };
    fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('backup-import', async (_e, favs) => {
  try {
    const win2 = BrowserWindow.getFocusedWindow() || win || setWin;
    const res = await dialog.showOpenDialog(win2, {
      title: '导入备份',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false };
    const data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8').replace(/^\uFEFF/, ''));
    if (data.app !== 'MediaIsle') return { ok: false, message: '不是 MediaIsle 备份文件' };
    // 配置: 仅接受已知字段
    if (data.config && typeof data.config === 'object') {
      for (const k of Object.keys(cfg)) {
        if (data.config[k] !== undefined) cfg[k] = data.config[k];
      }
      saveCfg();
      // 推送全部显示相关状态
      send('glass-changed', !!cfg.glass);
      send('bilingual-changed', cfg.bilingual !== false);
      send('lyr-size-changed', cfg.lyrSize || 12.5);
      try { if (win && !win.isDestroyed()) win.setSkipTaskbar(!cfg.taskbar); } catch { }
      try { if (dlWin && !dlWin.isDestroyed()) dlWin.webContents.send('dl-style', { size: cfg.dlyrSize || 32, subSize: cfg.dlyrSubSize || 17 }); } catch { }
      if (cfg.dlyr) ensureDlyrics(); else closeDlyrics();
    }
    // 统计
    if (data.stats && typeof data.stats === 'object') {
      stats.days = data.stats.days || {};
      stats.tracks = data.stats.tracks || {};
      stats.history = data.stats.history || [];
      stats.lastPlayKey = data.stats.lastPlayKey || '';
      try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch { }
      if (setWin && !setWin.isDestroyed()) setWin.webContents.send('stats-updated');
    }
    return { ok: true, config: JSON.parse(JSON.stringify(cfg)), favs: data.favs || {} };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

// 定时停止 (会话级, 不持久化)
let sleepEndAt = 0;
let sleepTimerHandle = null;
ipcMain.handle('sleep-get', () => ({ endAt: sleepEndAt }));
ipcMain.handle('sleep-set', (_e, minutes) => {
  if (sleepTimerHandle) { clearTimeout(sleepTimerHandle); sleepTimerHandle = null; }
  sleepEndAt = 0;
  const n = Number(minutes);
  if (isFinite(n) && n > 0) {
    sleepEndAt = Date.now() + n * 60e3;
    sleepTimerHandle = setTimeout(() => {
      sleepEndAt = 0;
      sleepTimerHandle = null;
      sendCommand('pause');
      try { tray.displayBalloon({ title: 'MediaIsle', content: '定时时间到，已暂停播放' }); } catch { }
    }, n * 60e3);
  }
  return { endAt: sleepEndAt };
});

// ---------------------------------------------------------------- 设置窗口
let setWin = null;
function createSettingsWindow() {
  if (setWin && !setWin.isDestroyed()) { setWin.focus(); return; }
  setWin = new BrowserWindow({
    width: 780,
    height: 580,
    minWidth: 640,
    minHeight: 440,
    title: 'MediaIsle 设置',
    backgroundColor: '#141218',
    frame: false,           // 自绘 MD3 顶栏(安卓风格)
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  setWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  attachConsoleForward(setWin, 'settings');
  setWin.on('closed', () => { setWin = null; });
}

// 自绘标题栏窗口控制(仅设置窗口自身可调用)
ipcMain.on('win-ctrl', (e, action) => {
  if (!setWin || setWin.isDestroyed() || e.sender !== setWin.webContents) return;
  if (action === 'minimize') setWin.minimize();
  else if (action === 'close') setWin.close();
});

ipcMain.handle('cfg-get', () => ({
  glass: !!cfg.glass,
  dlyr: !!cfg.dlyr,
  autostart: app.getLoginItemSettings().openAtLogin,
  lyrSources: Array.isArray(cfg.lyrSources) ? cfg.lyrSources.slice() : ['soda', 'netease', 'qq', 'kugou'],
  lyrStrategy: cfg.lyrStrategy === 'quality' ? 'quality' : 'race',
  fsHide: cfg.fsHide !== false,
  bilingual: cfg.bilingual !== false,
  lyrSize: cfg.lyrSize || 12.5,
  dlyrSize: cfg.dlyrSize || 32,
  dlyrSubSize: cfg.dlyrSubSize || 17,
  islandPos: cfg.islandPos === 'bottom' ? 'bottom' : 'top',
  taskbar: !!cfg.taskbar,
  lyrPickSave: cfg.lyrPickSave !== false,
  version: app.getVersion(),
}));

ipcMain.handle('cfg-set', (_e, key, val) => {
  if (key === 'glass') {
    cfg.glass = !!val;
    saveCfg();
    send('glass-changed', cfg.glass);
  } else if (key === 'dlyr') {
    cfg.dlyr = !!val;
    saveCfg();
    if (cfg.dlyr) ensureDlyrics(); else closeDlyrics();
  } else if (key === 'autostart') {
    app.setLoginItemSettings({ openAtLogin: !!val });
  } else if (key === 'lyrSources') {
    if (Array.isArray(val)) {
      const ids = val.filter((id) => LYRIC_SOURCES.some((s) => s.id === id));
      cfg.lyrSources = ids;
      saveCfg();
      // 音源/策略变化: 清歌词缓存并让岛体立即重抓当前曲目
      lyrCache.clear();
      send('lyrics-refetch');
    }
  } else if (key === 'lyrStrategy') {
    if (val === 'race' || val === 'quality') {
      cfg.lyrStrategy = val;
      saveCfg();
      lyrCache.clear();
      send('lyrics-refetch');
    }
  } else if (key === 'bilingual') {
    cfg.bilingual = !!val;
    saveCfg();
    send('bilingual-changed', cfg.bilingual);
  } else if (key === 'lyrSize') {
    const n = Number(val);
    if (isFinite(n) && n >= 10 && n <= 18) {
      cfg.lyrSize = n;
      saveCfg();
      send('lyr-size-changed', cfg.lyrSize);
    }
  } else if (key === 'dlyrSize') {
    const n = Number(val);
    if (isFinite(n) && n >= 18 && n <= 56) {
      cfg.dlyrSize = n;
      saveCfg();
      try {
        if (dlWin && !dlWin.isDestroyed()) dlWin.webContents.send('dl-style', { size: cfg.dlyrSize, subSize: cfg.dlyrSubSize || 17 });
      } catch { }
    }
  } else if (key === 'dlyrSubSize') {
    const n = Number(val);
    if (isFinite(n) && n >= 10 && n <= 36) {
      cfg.dlyrSubSize = n;
      saveCfg();
      try {
        if (dlWin && !dlWin.isDestroyed()) dlWin.webContents.send('dl-style', { size: cfg.dlyrSize || 32, subSize: cfg.dlyrSubSize });
      } catch { }
    }
  } else if (key === 'fsHide') {
    cfg.fsHide = !!val;
    saveCfg();
    // 关闭功能时若正因全屏隐藏, 立即恢复显示
    if (!cfg.fsHide && hiddenByFs) {
      hiddenByFs = false;
      if (!hiddenByUser && win && !win.isDestroyed()) win.showInactive();
    }
  } else if (key === 'lyrPickSave') {
    cfg.lyrPickSave = !!val;
    saveCfg();
  } else if (key === 'islandPos') {
    if (val === 'top' || val === 'bottom') {
      cfg.islandPos = val;
      saveCfg();
      positionWindow();
    }
  } else if (key === 'taskbar') {
    cfg.taskbar = !!val;
    saveCfg();
    try {
      if (win && !win.isDestroyed()) {
        win.setSkipTaskbar(!cfg.taskbar);
        updateThumbar();
      }
    } catch { }
  }
  return {
    glass: !!cfg.glass,
    dlyr: !!cfg.dlyr,
    autostart: app.getLoginItemSettings().openAtLogin,
    lyrSources: Array.isArray(cfg.lyrSources) ? cfg.lyrSources.slice() : ['soda', 'netease', 'qq', 'kugou'],
    lyrStrategy: cfg.lyrStrategy === 'quality' ? 'quality' : 'race',
    fsHide: cfg.fsHide !== false,
    bilingual: cfg.bilingual !== false,
    lyrSize: cfg.lyrSize || 12.5,
    dlyrSize: cfg.dlyrSize || 32,
    dlyrSubSize: cfg.dlyrSubSize || 17,
    islandPos: cfg.islandPos === 'bottom' ? 'bottom' : 'top',
    taskbar: !!cfg.taskbar,
    lyrPickSave: cfg.lyrPickSave !== false,
    version: app.getVersion(),
  };
});

ipcMain.handle('stats-get', () => JSON.parse(JSON.stringify(stats)));

// ---------------------------------------------------------------- 歌词获取(主进程绕过 CORS)
// 多源并发: 网易云 / QQ音乐 / 酷狗。策略 cfg.lyrics:
//   race    并发竞速, 任一源校验通过立即采用(默认, 最快)
//   quality 等全部源完成, 按"末句时间戳 vs 曲目时长"偏差择优(最准)
//   netease|qq|kugou  仅使用指定单源
const lyrCache = new Map();

function parseLrc(text) {
  const out = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const times = [];
    const re = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    let m;
    while ((m = re.exec(ln))) {
      const cs = m[3] ? parseInt(m[3].padEnd(2, '0').slice(0, 2), 10) : 0;
      times.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + cs / 100);
    }
    const txt = ln.replace(/\[[^\]]*\]/g, '').trim();
    if (!txt || !times.length) continue;
    if (/^(作词|作詞|作曲|编曲|編曲|制作|製作|歌词|歌詞|演唱|和声|混音|母带)/.test(txt)) continue;
    if (txt === '//') continue; // QQ 翻译轨的空占位行
    for (const t of times) out.push({ t, x: txt });
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 500);
}

// QQ/酷狗返回 base64 歌词, 兼容明文
function maybeB64(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.includes('[')) return s;
  try {
    const d = Buffer.from(s, 'base64').toString('utf8');
    if (d.includes('[')) return d;
  } catch { }
  return s;
}

function validateLines(lines, duration) {
  if (!lines || !lines.length) return false;
  if (!(duration > 0)) return true;
  return Math.abs(lines[lines.length - 1].t - duration) < 15;
}

// 繁→简归一化表: 港台歌曲元数据常用繁体 (token = 繁体+简体)
const T2S_PAIRS = '萬万 與与 專专 業业 叢丛 東东 絲丝 丟丢 兩两 嚴严 喪丧 臨临 麗丽 舉举 鄉乡 買买 賣卖 亂乱 於于 雲云 ' +
  '電电 億亿 從从 優优 會会 傳传 兒儿 亞亚 國国 圓圆 圍围 圖图 團团 報报 場场 錯错 個个 這这 對对 開开 ' +
  '間间 門门 關关 來来 後后 現现 見见 聽听 說说 語语 讀读 寫写 樂乐 聲声 體体 點点 廣广 車车 ' +
  '馬马 鳥鸟 龍龙 鳳凤 愛爱 戀恋 網网 給给 幾几 當当 實实 態态 藝艺 節节 衛卫 廠厂 緣缘 範范 慣惯 劇剧 ' +
  '歷历 歲岁 豐丰 烏乌 無无 雙双 歡欢 齊齐 橋桥 樹树 機机 權权 壓压 標标 樣样 樓楼 櫻樱 檸柠 條条 ' +
  '夢梦 殼壳 壞坏 塵尘 傷伤 價价 儀仪 園园 壇坛 塊块 處处 補补 裝装 視视 覺觉 覽览 親亲 壽寿 尋寻 ' +
  '導导 層层 屬属 義义 燦灿 煙烟 燈灯 熱热 營营 爺爷 獨独 獲获 獅狮 獻献 環环 異异 疊叠 療疗 盜盗 盤盘 ' +
  '眾众 確确 禮礼 種种 積积 稱称 穀谷 窮穷 筆笔 籌筹 簡简 簽签 類类 糧粮 絕绝 維维 綱纲 總总 ' +
  '縱纵 縮缩 織织 繼继 續续 蘋苹 號号 蠟蜡 裡里 廢废 強强 戲戏 護护 嘗尝 憶忆 懷怀 擔担 掛挂 擁拥 ' +
  '摯挚 擊击 據据 擬拟 攝摄 敵敌 斷断 時时 晉晋 暢畅 殺杀 棄弃 極极 構构 樞枢 欄栏 漢汉 潑泼 ' +
  '澤泽 牆墙 壯壮 薦荐 術术 觸触 計计 訊讯 認认 討讨 讓让 論论 訪访 設设 許许 詞词 試试 該该 詳详 ' +
  '誤误 調调 誰谁 課课 談谈 請请 講讲 謝谢 譜谱 識识 譽誉 貝贝 財财 負负 責责 貴贵 費费 貼贴 資资 贊赞 趙趙 ' +
  '趕赶 蹟迹 軌轨 軍军 軟软 輕轻 載载 較较 輛辆 輪轮 轉转 轟轰 辦办 邊边 達达 運运 過过 違违 連连 遠远 適适 遲迟 ' +
  '遷迁 選选 遺遗 鄧邓 鄭郑 醫医 釋释 鋪铺 鎮镇 鏡镜 長长 閃闪 閉闭 閒闲 隊队 階阶 際际 雞鸡 難难 霧雾 靜静 ' +
  '韓韩 頁页 頂顶 項项 順顺 須须 預预 領领 頻频 題题 顏颜 願愿 顧顾 飛飞 飢饥 飯饭 飲饮 飾饰 飽饱 飼饲 餘余 館馆 ' +
  '餵喂 馬马 馭驭 駐驻 駕驾 驗验 驚惊 驕骄 髮发 鬥斗 鬧闹 鮮鲜 鳥鸟 鴉鸦 鳴鸣 鶴鹤 龐庞 龜龟 頭头 劉刘 ' +
  '陳陈 楊杨 黃黄 張张 吳吴 孫孙 鄺邺 龔龚 們们 對对 没沒 經经 給给 慣惯 廳厅 區区 灭滅 润潤 浅淺 满滿 ' +
  '渐漸 渊淵 温溫 沟溝 洁潔 涨漲 渔漁 游遊 滨濱 滚滾 滤濾 滩灘 灾災 炉爐 炼煉 炽熾 烂爛 烦煩 烧燒 焕煥 馋饞 颤顫 ' +
  '脏臟 脑腦 腾騰 舰艦 艰艱 艺藝 节節 苏蘇 荣榮 药藥 萧蕭 蒋蔣 弹彈 缤缤 纷纷 荣榮 灭滅 润潤 单单 弹彈 ' +
  '倫伦 傑杰 捲卷 媽妈 紅红 純纯 級级 約约 納纳 細细 編编 綠绿 縣县 联聯 誠诚 讚赞 賴赖 貓猫 驱驅 靈灵 ' +
  '戰战 競竞 築筑 檔档 監监 償偿 嬌娇 懸悬 曬晒 鬆松 麵面 麼么 罷罢 顆颗 響响 懶懒 藥药 蕭萧 聶聂 涛濤 ' +
  '曉晓 瀟潇 寶宝 藍蓝 羅罗 綺绮 鴻鸿 輯辑 銷销 彈弹 繽缤 滅灭 潤润 淺浅 滿满 漸渐 淵渊 溫溫 溝溝 潔洁 漲涨 ' +
  '漁渔 遊游 濱滨 滾滚 濾滤 灘滩 災灾 爐炉 煉炼 熾炽 爛爛 煩烦 燒烧 煥焕 饞馋 顫颤 臟脏 腦脑 騰腾 艦舰 艰艰 ' +
  '蔣蒋 帳帐 幫帮 幹干 莊庄 慶庆 庫库 應应 廟庙 寬宽 審审 憲宪 寢寝 豈岂 崗岗 嶺岭 屢屡 畢毕 匯汇 瀝沥 ' +
  '僅仅 僕仆 農农 況况 凍冻 淨净 淒凄 準准 減减 憑凭 凱凯 劃划 剛刚 創创 劑剂 劍剑 剝剥 勸劝 務务 動动 ' +
  '勵励 勞劳 勢势 勳勋 勻匀 區区 協协 厲厉 厭厌 廁厕 釐厘 參参 葉叶 嘆叹 嚇吓 呂吕 嗎吗 噸吨 嗚呜 員员 ' +
  '囉啰 嘯啸 囑嘱 喬乔 撥拨 擇择 攏拢 攔拦 攤摊 撐撑 話话 風风 譯译 週周 億亿 億亿';

const T2S = new Map();
for (const p of T2S_PAIRS.split(' ')) {
  if (p.length === 2) T2S.set(p[0], p[1]);
}

// 标题/歌手归一化: 繁→简 + 全角→半角 + 去空白标点 + 小写。
// 让 繁体元数据/全角字符 与简体平台数据可匹配
function normTitle(s) {
  let r = '';
  for (const ch of String(s || '')) {
    let c = T2S.get(ch) || ch;
    const code = c.charCodeAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) c = String.fromCharCode(code - 0xFEE0);
    else if (code === 0x3000) c = ' ';
    r += c;
  }
  return r.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

// 标题相似度 0~1: 完全相等 1, 包含关系 0.85, 否则取 bigram 骰子系数。
// bigram 对短标题/换序标题区分度远高于单字重合('爱你'vs'你爱'→0, 'Run'vs'Sun'→0.5)
function titleScore(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  if (na.length < 2 || nb.length < 2) return 0;
  const grams = new Set();
  for (let i = 0; i < na.length - 1; i++) grams.add(na.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const g = nb.slice(i, i + 2);
    if (grams.has(g)) { hit++; grams.delete(g); }
  }
  return (2 * hit) / (na.length - 1 + nb.length - 1);
}

function artistMatch(candArtist, artist) {
  const a = normTitle(candArtist), b = normTitle(artist);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// 歌手相似度: bigram 骰子系数(短字符串区分度远高于单字重合率)
// 'Another Band' vs 'Miatriss' → 0.0, 而 'Miatriss & X' vs 'Miatriss' → ~0.87
function artistScore(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  if (na.length < 2 || nb.length < 2) return 0;
  const grams = new Set();
  for (let i = 0; i < na.length - 1; i++) grams.add(na.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < nb.length - 1; i++) {
    const g = nb.slice(i, i + 2);
    if (grams.has(g)) { hit++; grams.delete(g); }
  }
  return (2 * hit) / (na.length - 1 + nb.length - 1);
}

// 候选时长得分: 元数据时长经常不准, 只作加权不作硬门(差>25s 视为垃圾数据淘汰)
function candDurScore(cd, duration) {
  if (!(duration > 0) || !(cd > 0)) return 0;
  const d = Math.abs(cd - duration);
  if (d <= 3) return 0.2;
  if (d <= 10) return 0.15;
  if (d <= 20) return 0.1;
  return 0;
}
function hasCJKScript(s) { return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s || ''); }
function hasLatinScript(s) { return /[a-zA-Z]/.test(s || ''); }

// 候选排序与过滤(加权评分, 分级接受):
//   标题 ts>=0.55; 综合分 = ts + 歌手分*0.45 + 时长分, 需 >=1.0 且 ts>=0.6
//   歌手硬门槛 as>=0.35; 灰区 0.25~0.35 需时长差<=3s;
//   跨语言歌手(一方CJK一方拉丁, as<0.2): 时长差<=6s 且标题>=0.8 时放行
//   SMTC 无歌手信息: 仅要求标题 >= 0.75
function rankCands(rawList, title, artist, duration, nameOf, artistOf, durOf) {
  return rawList
    .map((s) => {
      const ts = titleScore(nameOf(s), title);
      if (ts < 0.55) return null;
      const cd = durOf ? durOf(s) : 0;
      const dAbs = (duration > 0 && cd > 0) ? Math.abs(cd - duration) : null;
      if (dAbs !== null && dAbs > 25) return null; // 垃圾元数据

      const candArtist = artistOf(s);
      const as = artist ? artistScore(candArtist, artist) : 0.6;
      if (artist) {
        let baseOK = as >= 0.35;
        if (!baseOK && as >= 0.25 && dAbs !== null && dAbs <= 3) baseOK = true;
        if (!baseOK && as < 0.2 && dAbs !== null && dAbs <= 3 && ts >= 0.85 &&
            hasCJKScript(candArtist) !== hasCJKScript(artist) &&
            (hasCJKScript(candArtist) || hasCJKScript(artist)) &&
            (hasLatinScript(candArtist) !== hasLatinScript(artist))) {
          baseOK = true; // 跨语言歌手名变体(如 罗马字 vs 原文), 需近同时长+高标题分
        }
        if (!baseOK) return null;
      }

      const score = ts + as * 0.45 + candDurScore(cd, duration);
      if (score < 1.0) return null;
      if (artist ? ts < 0.6 : ts < 0.75) return null;
      return { s, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.s);
}

async function httpJson(url, headers, signal) {
  const res = await fetch(url, { signal, headers: headers || {} });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

const H_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

async function srcNetease(query) {
  const { title, artist, duration } = query;
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 7500);
  try {
    const h = { ...H_UA, 'Referer': 'https://music.163.com/' };
    const attempt = async (kw) => {
      const q = encodeURIComponent(kw);
      const sr = await httpJson(`https://music.163.com/api/search/get/web?s=${q}&type=1&offset=0&limit=5`, h, ac.signal);
      const songs = (sr && sr.result && sr.result.songs) || [];
      const durOf = (s) => (s.duration && s.duration > 0) ? s.duration / 1000 : 0;
      const cands = rankCands(songs, title, artist, duration,
        (s) => s.name, (s) => (s.artists || []).map((a) => a.name).join('/'), durOf);
      for (const s of cands) {
        try {
          const lr = await httpJson(`https://music.163.com/api/song/lyric?os=pc&id=${s.id}&lv=-1&kv=-1&tv=-1`, h, ac.signal);
          const lines = parseLrc(lr && lr.lrc && lr.lrc.lyric);
          if (validateLines(lines, duration)) {
            const trans = parseLrc(lr && lr.tlyric && lr.tlyric.lyric);
            return { lines, dur: durOf(s), trans };
          }
        } catch { }
      }
      // 歌词未命中也回传候选时长: 无时间轴播放器(网易云)需用它做进度基准
      return { lines: null, dur: cands.length ? durOf(cands[0]) : 0, trans: [] };
    };
    const r1 = await attempt(`${title} ${artist}`.trim());
    if (r1.lines) return r1;
    // 回退: 歌手名干扰匹配时仅用标题重搜
    if (artist) {
      const r2 = await attempt(title);
      if (r2.lines) return r2;
      return { lines: null, dur: r1.dur || r2.dur || 0, trans: r1.trans || r2.trans || [] };
    }
    return r1;
  } catch { return null; } finally { clearTimeout(tm); }
}

async function srcQQ(query) {
  const { title, artist, duration } = query;
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 7500);
  try {
    const h = { ...H_UA, 'Referer': 'https://y.qq.com/' };
    const attempt = async (kw) => {
      const q = encodeURIComponent(kw);
      const sr = await httpJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${q}&format=json&n=5`, h, ac.signal);
      const list = (sr && sr.data && sr.data.song && sr.data.song.list) || [];
      const cands = rankCands(list, title, artist, duration,
        (s) => s.songname || s.name, (s) => (s.singer || []).map((a) => a.name).join('/'),
        (s) => s.interval || 0);
      for (const s of cands) {
        try {
          const mid = s.songmid || s.mid;
          if (!mid) continue;
          // GetPlayLyricInfo: 老版 fcg_query_lyric_new 接口的 trans 字段已恒为空,
          // 翻译需走 musicu.fcg 的 PlayLyricInfo 模块 (isFormat:false 时 lyric/trans 为 base64)
          const lr = await httpJson(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify({
            comm: { ct: 19, cv: 1873, uin: '' },
            req_1: {
              module: 'music.musichallSong.PlayLyricInfo',
              method: 'GetPlayLyricInfo',
              param: { songMID: mid, songID: 0, isFormat: false, trans: 1 },
            },
          }))}`, h, ac.signal);
          const d = lr && lr.req_1 && lr.req_1.data;
          const lines = parseLrc(maybeB64(d && d.lyric));
          if (validateLines(lines, duration)) {
            const trans = parseLrc(maybeB64(d && d.trans));
            return { lines, dur: s.interval || 0, trans };
          }
        } catch { }
      }
      return { lines: null, dur: cands.length ? (cands[0].interval || 0) : 0, trans: [] };
    };
    const r1 = await attempt(`${title} ${artist}`.trim());
    if (r1.lines) return r1;
    if (artist) {
      const r2 = await attempt(title);
      if (r2.lines) return r2;
      return { lines: null, dur: r1.dur || r2.dur || 0, trans: r1.trans || r2.trans || [] };
    }
    return r1;
  } catch { return null; } finally { clearTimeout(tm); }
}

// ---------------------------------------------------------------- 汽水音乐本地歌词缓存源
// 汽水(SodaMusic)的曲目详情接口有原生层签名风控, 无法直接请求;
// 但客户端会把已播放曲目的完整详情(含逐字歌词/翻译)缓存到本地 LMDB
// (LunaCacheV2/entries.db), 此处直接读取并按标题/歌手/时长匹配。
// 仅在汽水正在播放的场景可用(缓存由汽水自己写入), 其余场景返回空。
// 注意: LMDB 只读句柄打开即快照, 每次查找都重新打开以读到新写入的缓存。
function readSodaCatalog() {
  let lmdb;
  try { lmdb = require('lmdb'); } catch { return []; }
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'SodaMusic', 'LunaCacheV2', 'entries.db');
  let db = null;
  try { db = lmdb.open({ path: dbPath, readOnly: true }); } catch { return []; }
  const out = [];
  try {
    for (const { value } of db.getRange()) {
      try {
        if (!value || typeof value !== 'object') continue;
        const md = value.info && value.info.mediaDetail;
        if (!md) continue;
        const resp = md.response;
        const tr = resp && resp.track;
        const lyr = (resp && resp.lyric) || md.lyrics;
        if (!tr || !tr.name || !lyr || !lyr.content) continue;
        out.push({
          id: String(tr.id || ''),
          name: tr.name,
          artists: (Array.isArray(tr.artists) ? tr.artists : []).map((a) => a.name || '').filter(Boolean).join('/'),
          dur: (tr.duration && tr.duration > 0) ? tr.duration / 1000 : 0,
          c: lyr.content,
          t: (lyr.translations && lyr.translations.cn) || '',
        });
      } catch { }
    }
  } catch { }
  try { db.close(); } catch { }
  return out;
}

// 汽水歌词行格式: KRC 逐字 [startMs,durMs]<relStart,relDur,0>词 <...>...
// 兼容普通 LRC 行 [mm:ss.xx]文本
function parseSodaContent(text) {
  const out = [];
  const lrcRest = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(ln.trim());
    if (m) {
      const x = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (x) out.push({ t: parseInt(m[1], 10) / 1000, x });
    } else {
      lrcRest.push(ln);
    }
  }
  if (lrcRest.length) out.push(...parseLrc(lrcRest.join('\n')));
  return out.sort((a, b) => a.t - b.t).slice(0, 500);
}

async function srcSoda(query) {
  const { title, artist, duration } = query;
  const cats = readSodaCatalog();
  if (!cats.length) return null;
  const cands = rankCands(cats, title, artist, duration,
    (t) => t.name, (t) => t.artists, (t) => t.dur);
  // 元数据候选已经过 rankCands 精确校验(即汽水正在播的曲目),
  // 末句时间不必紧贴曲尾(电音 outro 很长), 只做宽松防护
  const softValid = (lines) => lines.length &&
    !(duration > 0 && Math.abs(lines[lines.length - 1].t - duration) > 60);
  for (const t of cands) {
    const lines = parseSodaContent(t.c);
    if (softValid(lines)) {
      const trans = t.t ? parseLrc(t.t) : [];
      return { lines, dur: t.dur || 0, trans };
    }
  }
  // 元数据命中但歌词校验未过: 仍回传时长与翻译兜底
  if (cands.length) {
    const t = cands[0];
    return { lines: null, dur: t.dur || 0, trans: t.t ? parseLrc(t.t) : [] };
  }
  return null;
}

// ---------------------------------------------------------------- 酷狗 KRC 解密 (含翻译)
// KRC: base64 -> 跳过 4 字节魔数("krc1") -> 16 字节循环 XOR -> zlib 解压;
// 原文行为 [ms,dur]<off,dur,0>词 逐字格式, 翻译在 language 标签 (base64 JSON, type 1 = 逐句翻译)
const KRC_KEY = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]);
function parseKrc(b64) {
  const data = Buffer.from(b64, 'base64');
  if (data.length < 5) return null;
  const out = Buffer.alloc(data.length - 4);
  for (let i = 4; i < data.length; i++) out[i - 4] = data[i] ^ KRC_KEY[(i - 4) % KRC_KEY.length];
  const text = zlib.inflateSync(out).toString('utf8');
  let langTag = null;
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('[')) continue;
    const m = /^\[(\d+),(\d+)\](.*)$/.exec(line);
    if (m) {
      const x = m[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      entries.push({ t: parseInt(m[1], 10) / 1000, x });
      continue;
    }
    const tg = /^\[(\w+):([^\]]*)\]$/.exec(line);
    if (tg && tg[1] === 'language') langTag = tg[2];
  }
  const trans = [];
  if (langTag) {
    try {
      const lang = JSON.parse(Buffer.from(langTag, 'base64').toString('utf8'));
      const ts = (lang.content || []).find((c) => c.type === 1);
      if (ts && Array.isArray(ts.lyricContent)) {
        for (let i = 0; i < Math.min(entries.length, ts.lyricContent.length); i++) {
          const s = (ts.lyricContent[i] || [])[0];
          if (s && s.trim() && entries[i].x) trans.push({ t: entries[i].t, x: s.trim() });
        }
      }
    } catch { }
  }
  return { entries: entries.filter((e) => e.x), trans };
}

async function srcKugou(query) {
  const { title, artist, duration } = query;
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 8000);
  try {
    const attempt = async (kw) => {
      const q = encodeURIComponent(kw);
      const sr = await httpJson(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${q}&page=1&pagesize=5`, H_UA, ac.signal);
      const list = (sr && sr.data && sr.data.info) || [];
      const cands = rankCands(list, title, artist, duration,
        (s) => s.songname, (s) => s.singername,
        (s) => s.duration || 0);
      for (const s of cands) {
        try {
          if (!s.hash) continue;
          const cs = await httpJson(
            `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&hash=${s.hash}&album_audio_id=${s.album_audio_id || ''}`,
            H_UA, ac.signal);
          const cand = cs && cs.candidates && cs.candidates[0];
          if (!cand || !cand.id) continue;
          const aKey = cand.accesskey || cand.access_key || '';
          // 优先 KRC: 解密后同时得到原文(逐字)与翻译; 失败回退 lrc
          try {
            const kr = await httpJson(
              `https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${aKey}&fmt=krc&charset=utf8`,
              H_UA, ac.signal);
            if (kr && kr.content) {
              const parsed = parseKrc(kr.content);
              const lines = parsed ? parsed.entries.map(({ t, x }) => ({ t, x })) : [];
              if (validateLines(lines, duration)) {
                return { lines, dur: s.duration || 0, trans: parsed.trans };
              }
            }
          } catch { }
          const dl = await httpJson(
            `https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${aKey}&fmt=lrc&charset=utf8`,
            H_UA, ac.signal);
          const lines = parseLrc(maybeB64(dl && dl.content));
          if (validateLines(lines, duration)) return { lines, dur: s.duration || 0, trans: [] };
        } catch { }
      }
      return { lines: null, dur: cands.length ? (cands[0].duration || 0) : 0, trans: [] };
    };
    const r1 = await attempt(`${title} ${artist}`.trim());
    if (r1.lines) return r1;
    if (artist) {
      const r2 = await attempt(title);
      if (r2.lines) return r2;
      return { lines: null, dur: r1.dur || r2.dur || 0, trans: r1.trans || r2.trans || [] };
    }
    return r1;
  } catch { return null; } finally { clearTimeout(tm); }
}

const LYRIC_SOURCES = [
  // soda(本地缓存)放在首位: 读取即返回, 竞速下天然优先, 且与汽水播放内容精确一致
  { id: 'soda', fn: srcSoda },
  { id: 'netease', fn: srcNetease },
  { id: 'qq', fn: srcQQ },
  { id: 'kugou', fn: srcKugou },
];

async function fetchLyrics(query) {
  const { title, artist, duration } = query || {};
  if (!title) return { lines: [], src: '', dur: 0 };
  const key = (title + '|' + artist).toLowerCase();
  if (lyrCache.has(key)) return lyrCache.get(key);

  // 用户手动选定的歌词优先 (可在设置中关闭保存)
  const pick = cfg.lyrPickSave !== false ? lyrPicks[key] : undefined;
  if (pick) {
    try {
      const r = await fetchLyricByKey(pick.src, pick.key);
      if (r && r.lines && r.lines.length) return finish(r.lines, pick.src + ' · 手动', r.dur, r.trans);
    } catch { }
  }

  const finish = (lines, src, dur, trans) => {
    const r = { lines: lines || [], src: src || '', dur: dur || 0, trans: trans || [] };
    lyrCache.set(key, r);
    if (lines && lines.length) {
      // 日志 ASCII 转义: 终端代码页不一致时也不会显示乱码
      const safe = String(title).replace(/[^\x20-\x7E]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      console.log(`[lyrics] "${safe}" <- ${src || strat}${r.dur ? ' (' + Math.round(r.dur) + 's)' : ''}${r.trans.length ? ' +trans' : ''}`);
    }
    return r;
  };

  // 按用户启用的音源并发 (固定优先级: 汽水 > 网易 > QQ > 酷狗)
  const enabled = LYRIC_SOURCES.filter((s) => Array.isArray(cfg.lyrSources) && cfg.lyrSources.includes(s.id));
  if (!enabled.length) return finish([], '', 0, []);
  const strat = cfg.lyrStrategy === 'quality' ? 'quality' : 'race';

  const ps = enabled.map((s) =>
    withTimeout(Promise.resolve().then(() => s.fn({ title, artist, duration })), 9000)
      .then((r) => r ? {
        lines: (r.lines && r.lines.length) ? r.lines : [],
        src: (r.lines && r.lines.length) ? s.id : '',
        dur: r.dur || 0,
        trans: r.trans || [],
      } : null));

  if (strat === 'race') {
    return new Promise((resolve) => {
      let pending = ps.length, done = false, bestDur = 0, bestTrans = [];
      ps.forEach((p) => p.then((r) => {
        if (r) {
          if (r.dur > bestDur) bestDur = r.dur;
          if (r.trans && r.trans.length && !bestTrans.length) bestTrans = r.trans;
        }
        if (!done && r && r.lines.length) { done = true; resolve(finish(r.lines, r.src, r.dur, r.trans)); }
        if (--pending === 0 && !done) { done = true; resolve(finish([], '', bestDur, bestTrans)); }
      }));
    });
  }

  // quality: 等全部完成, 按末句与曲目时长偏差择优, 同分按源优先级
  const rs = await Promise.all(ps);
  let bestDur = 0, bestTrans = [];
  rs.forEach((r) => {
    if (!r) return;
    if (r.dur > bestDur) bestDur = r.dur;
    if (r.trans && r.trans.length && !bestTrans.length) bestTrans = r.trans;
  });
  let best = null, bestScore = Infinity, bestIdx = Infinity;
  rs.forEach((r, i) => {
    if (!r || !r.lines.length) return;
    const last = r.lines[r.lines.length - 1].t;
    const score = (duration > 0) ? Math.abs(last - duration) : 1000 + i * 10;
    if (score < bestScore || (score === bestScore && i < bestIdx)) { best = r; bestScore = score; bestIdx = i; }
  });
  return best ? finish(best.lines, best.src, best.dur, best.trans) : finish([], '', bestDur, bestTrans);
}
// ---------------------------------------------------------------- 歌词手动纠错
// 用户在候选列表手动选定歌词源与版本, 按曲目记忆 (lyr-picks.json),
// fetchLyrics 命中手选记录时优先按选定源抓取
let lyrPicks = {};
try { lyrPicks = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'lyr-picks.json'), 'utf8')); } catch { }
function savePicks() {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'lyr-picks.json'), JSON.stringify(lyrPicks)); } catch { }
}

// 纠错窗口: 独立普通窗口, 不参与岛体状态机
let lyrFixWin = null;
let lyrFixCtx = null;
ipcMain.handle('lyrfix-open', (_e, ctx) => {
  const songKey = (((ctx && ctx.title) || '') + '|' + ((ctx && ctx.artist) || '')).toLowerCase();
  const picked = lyrPicks[songKey];
  lyrFixCtx = { ...(ctx || {}), pickedKey: (picked && picked.key) || '' };
  if (lyrFixWin && !lyrFixWin.isDestroyed()) { lyrFixWin.focus(); return { ok: true }; }
  lyrFixWin = new BrowserWindow({
    width: 480,
    height: 580,
    minWidth: 380,
    minHeight: 420,
    title: '歌词纠错 - MediaIsle',
    backgroundColor: '#141218',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  lyrFixWin.loadFile(path.join(__dirname, 'renderer', 'lyrfix.html'));
  attachConsoleForward(lyrFixWin, 'lyrfix');
  lyrFixWin.on('closed', () => { lyrFixWin = null; });
  return { ok: true };
});
ipcMain.handle('lyrfix-context', () => lyrFixCtx || {});

async function fetchLyricByKey(src, key) {
  if (src === 'soda') {
    const cats = readSodaCatalog();
    const hit = cats.find((c) => String(c.id) === String(key));
    if (!hit) return null;
    const entries = parseSodaContent(hit.c);
    if (!entries.length) return null;
    const lines = entries.map(({ t, x }) => ({ t, x }));
    return { lines, trans: hit.t ? parseLrc(hit.t) : [], dur: hit.dur || 0 };
  }
  if (src === 'netease') {
    const lr = await httpJson(`https://music.163.com/api/song/lyric?os=pc&id=${key}&lv=-1&kv=-1&tv=-1`, { ...H_UA, Referer: 'https://music.163.com/' });
    const lines = parseLrc(lr && lr.lrc && lr.lrc.lyric);
    if (!lines.length) return null;
    return { lines, trans: parseLrc(lr && lr.tlyric && lr.tlyric.lyric), dur: 0 };
  }
  if (src === 'qq') {
    const lr = await httpJson(`https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify({ comm: { ct: 19, cv: 1873, uin: '' }, req_1: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param: { songMID: key, songID: 0, isFormat: false, trans: 1 } } }))}`, { ...H_UA, Referer: 'https://y.qq.com/' });
    const d = lr && lr.req_1 && lr.req_1.data;
    const lines = parseLrc(maybeB64(d && d.lyric));
    if (!lines.length) return null;
    return { lines, trans: parseLrc(maybeB64(d && d.trans)), dur: 0 };
  }
  if (src === 'kugou') {
    const [hash, aaid] = String(key).split('|');
    const cs = await httpJson(`https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&hash=${hash}&album_audio_id=${aaid || ''}`, H_UA);
    const cand = cs && cs.candidates && cs.candidates[0];
    if (!cand || !cand.id) return null;
    const aKey = cand.accesskey || cand.access_key || '';
    const kr = await httpJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${aKey}&fmt=krc&charset=utf8`, H_UA);
    if (kr && kr.content) {
      const parsed = parseKrc(kr.content);
      const lines = parsed ? parsed.entries.map(({ t, x }) => ({ t, x })) : [];
      if (lines.length) return { lines, trans: parsed.trans, dur: 0 };
    }
    return null;
  }
  return null;
}

ipcMain.handle('lyr-candidates', async (_e, q) => {
  const { title, artist, duration } = q || {};
  if (!title) return [];
  const out = [];
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 8000);
  try {
    const kw = encodeURIComponent(`${title} ${artist || ''}`.trim());
    // 汽水: 本地缓存目录匹配
    try {
      for (const c of readSodaCatalog()) {
        const ts = titleScore(c.name, title);
        if (ts < 0.55) continue;
        out.push({ src: 'soda', key: c.id, name: c.name, artist: c.artists, dur: Math.round(c.dur), score: ts });
      }
    } catch { }
    // 网易云
    try {
      const sr = await httpJson(`https://music.163.com/api/search/get/web?s=${kw}&type=1&offset=0&limit=3`, { ...H_UA, Referer: 'https://music.163.com/' }, ac.signal);
      for (const s of ((sr.result && sr.result.songs) || []).slice(0, 3)) {
        out.push({ src: 'netease', key: String(s.id), name: s.name, artist: (s.artists || []).map((a) => a.name).join('/'), dur: s.duration > 0 ? Math.round(s.duration / 1000) : 0 });
      }
    } catch { }
    // QQ
    try {
      const sr = await httpJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${kw}&format=json&n=3`, { ...H_UA, Referer: 'https://y.qq.com/' }, ac.signal);
      for (const s of (((sr.data || {}).song || {}).list || []).slice(0, 3)) {
        out.push({ src: 'qq', key: s.songmid, name: s.songname, artist: (s.singer || []).map((a) => a.name).join('/'), dur: s.interval || 0 });
      }
    } catch { }
    // 酷狗
    try {
      const sr = await httpJson(`http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${kw}&page=1&pagesize=3`, H_UA, ac.signal);
      for (const s of (((sr.data || {}).info) || []).slice(0, 3)) {
        out.push({ src: 'kugou', key: s.hash + '|' + (s.album_audio_id || ''), name: s.songname, artist: s.singername, dur: s.duration || 0 });
      }
    } catch { }
  } catch { } finally { clearTimeout(tm); }
  for (const c of out) c.score = titleScore(c.name, title) + (duration > 0 && c.dur > 0 ? candDurScore(c.dur, duration) : 0);
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 12);
});

ipcMain.handle('lyr-pick', async (_e, p) => {
  try {
    const { songKey, src, key } = p || {};
    if (!songKey || !src || !key) return { ok: false };
    const r = await fetchLyricByKey(src, key);
    if (!r || !r.lines || !r.lines.length) return { ok: false };
    lyrPicks[songKey.toLowerCase()] = { src, key };
    savePicks();
    lyrCache.set(songKey.toLowerCase(), { lines: r.lines, src: src + ' · 手动', dur: r.dur || 0, trans: r.trans || [] });
    // 通知岛体按手选结果重抓
    send('lyrics-refetch');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e && e.message) || String(e) };
  }
});

ipcMain.handle('fetch-lyrics', (_e, q) => fetchLyrics(q || {}).catch(() => ({ lines: [], src: '' })));

// 桌面歌词窗口
let dlWin = null;
function ensureDlyrics() {
  if (dlWin && !dlWin.isDestroyed()) return;
  dlWin = new BrowserWindow({
    width: 1000, height: 120,
    frame: false, transparent: true, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  dlWin.setAlwaysOnTop(true, 'screen-saver');
  try { dlWin.setVisibleOnAllWorkspaces(true); } catch { }
  dlWin.setIgnoreMouseEvents(true);
  dlWin.loadFile(path.join(__dirname, 'renderer', 'dlyrics.html'));
  attachConsoleForward(dlWin, 'dlyr');
  positionDlyrics();
  dlWin.once('ready-to-show', () => {
    try { dlWin.webContents.send('dl-style', { size: cfg.dlyrSize || 32, subSize: cfg.dlyrSubSize || 17 }); } catch { }
    dlWin.showInactive();
    keepOnTop();
  });
}
function positionDlyrics() {
  if (!dlWin || dlWin.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  dlWin.setPosition(
    Math.round(workArea.x + (workArea.width - 1000) / 2),
    workArea.y + workArea.height - 140,
    false
  );
}
function closeDlyrics() {
  try { if (dlWin && !dlWin.isDestroyed()) dlWin.destroy(); } catch { }
  dlWin = null;
}

ipcMain.on('desktop-lyric', (_e, payload) => {
  if (!cfg.dlyr) return;
  ensureDlyrics();
  if (dlWin && !dlWin.isDestroyed()) dlWin.webContents.send('dl-line', payload || { x: '', s: '' });
});

// ---------------------------------------------------------------- 托盘
function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('MediaIsle');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏岛体', click: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) { hiddenByUser = true; win.hide(); }
      else { hiddenByUser = false; hiddenByFs = false; win.showInactive(); keepOnTop(); }
    } },
    { type: 'separator' },
    { label: '设置...', click: () => createSettingsWindow() },
    { label: '切换静音', click: () => sendCommand('toggle-mute') },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------- 生命周期
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { /* 已在运行, 忽略 */ });

  app.whenReady().then(() => {
    // 清理上次运行遗留的命令文件; 错误日志超 256KB 轮转
    try { fs.rmSync(CMD_FILE, { force: true }); fs.rmSync(CMD_TMP, { force: true }); } catch { }
    try { if (fs.statSync(LOG_FILE).size > 262144) fs.rmSync(LOG_FILE, { force: true }); } catch { }
    createWindow();
    startBridge();
    createTray();
    if (cfg.dlyr) ensureDlyrics();
    screen.on('display-metrics-changed', positionDlyrics);
    console.log('[start] MediaIsle', app.getVersion(), '| build:', localBuildDate || '(源代码)');
    // 调试: MEDIAISLE_SETTINGS=1 启动时直接打开设置窗口
    if (process.env.MEDIAISLE_SETTINGS === '1') createSettingsWindow();
    // 打包版: 启动 30s 后后台检查更新
    if (app.isPackaged && localBuildDate) {
      setTimeout(() => runUpdateCheck(false).catch(() => { }), 30e3);
      setInterval(() => runUpdateCheck(false).catch(() => { }), 6 * 3600e3); // 每 6 小时复查
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('will-quit', () => {
    try { if (bridge) bridge.kill(); } catch { }
    try { fs.rmSync(CMD_FILE, { force: true }); fs.rmSync(CMD_TMP, { force: true }); } catch { }
    closeDlyrics();
    try { if (tray) tray.destroy(); } catch { }
    try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg)); } catch { }
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch { }
  });
}
