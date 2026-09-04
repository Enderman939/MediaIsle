// MediaIsle - preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  // 订阅媒体状态推送
  onState: (cb) => ipcRenderer.on('media-state', (_e, state) => cb(state)),
  // 订阅悬停状态变化(主进程光标命中检测)
  onHover: (cb) => ipcRenderer.on('hover-changed', (_e, inside) => cb(inside)),
  // 订阅系统音量变化(键盘音量键等)
  onVolume: (cb) => ipcRenderer.on('volume-changed', (_e, v) => cb(v)),
  // 上报当前岛形态(主进程据此计算命中矩形)
  reportState: (st) => ipcRenderer.send('island-state', st),
  // 进度条拖动状态(拖动期间保持展开)
  setDragging: (d) => ipcRenderer.send('island-dragging', d),
  // 发送控制命令: play / pause / toggle / next / prev / seek / volume /
  // toggle-mute / shuffle / repeat / switch-source(字符串 appId)
  command: (cmd, val) => ipcRenderer.send('media-command', cmd, val),
  // 歌词查询: {title, artist, duration} -> Promise<{lines:[{t, x}]}>
  getLyrics: (q) => ipcRenderer.invoke('fetch-lyrics', q),
  // 推送当前桌面歌词行
  desktopLine: (text) => ipcRenderer.send('desktop-lyric', text),
  // 桌面歌词窗口订阅歌词行
  onDesktopLine: (cb) => ipcRenderer.on('dl-line', (_e, t) => cb(t)),
  // 毛玻璃模式开关
  onGlass: (cb) => ipcRenderer.on('glass-changed', (_e, g) => cb(g)),
  // 双语字幕开关
  onBilingual: (cb) => ipcRenderer.on('bilingual-changed', (_e, b) => cb(b)),
  // 岛体歌词字号
  onLyrSize: (cb) => ipcRenderer.on('lyr-size-changed', (_e, v) => cb(v)),
  // 歌词源/策略变化: 重新抓取当前曲目歌词
  onLyricsRefetch: (cb) => ipcRenderer.on('lyrics-refetch', () => cb()),
  // 桌面歌词字号
  onDesktopStyle: (cb) => ipcRenderer.on('dl-style', (_e, v) => cb(v)),
  // 主窗底部统计文本(主进程推送)
  onStatsText: (cb) => ipcRenderer.on('stats-text', (_e, t) => cb(t)),
  // 设置窗口
  getCfg: () => ipcRenderer.invoke('cfg-get'),
  setCfg: (key, val) => ipcRenderer.invoke('cfg-set', key, val),
  getStats: () => ipcRenderer.invoke('stats-get'),
  onStatsUpdated: (cb) => ipcRenderer.on('stats-updated', () => cb()),
  // 自绘标题栏窗口控制(设置窗口)
  winCtrl: (action) => ipcRenderer.send('win-ctrl', action),
  // 自动更新(打包版): 状态查询 / 执行更新 / 进度推送
  updateGet: () => ipcRenderer.invoke('update-get'),
  updateApply: () => ipcRenderer.invoke('update-apply'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, v) => cb(v)),
  // 运行日志
  logGet: () => ipcRenderer.invoke('log-get'),
  logClear: () => ipcRenderer.send('log-clear'),
  onLogAppended: (cb) => ipcRenderer.on('log-appended', (_e, v) => cb(v)),
  // 备份导入/导出 (favs 由渲染层收集/落盘)
  backupExport: (favs) => ipcRenderer.invoke('backup-export', favs),
  backupImport: (favs) => ipcRenderer.invoke('backup-import', favs),
  // 定时停止
  sleepGet: () => ipcRenderer.invoke('sleep-get'),
  sleepSet: (minutes) => ipcRenderer.invoke('sleep-set', minutes),
  // 歌词纠错
  lyrCandidates: (q) => ipcRenderer.invoke('lyr-candidates', q),
  lyrPick: (p) => ipcRenderer.invoke('lyr-pick', p),
});
