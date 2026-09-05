// MediaIsle - 设置窗口逻辑
(() => {
  const swGlass = document.getElementById('swGlass');
  const swDlyr = document.getElementById('swDlyr');
  const swBi = document.getElementById('swBi');
  const swAuto = document.getElementById('swAuto');
  const swFs = document.getElementById('swFs');
  const selStrategy = document.getElementById('selStrategy');
  const selPos = document.getElementById('selPos');
  const selSleep = document.getElementById('selSleep');
  const sleepSub = document.getElementById('sleepSub');
  const swTb = document.getElementById('swTb');
  const rngLyr = document.getElementById('rngLyr');
  const rngLyrVal = document.getElementById('rngLyrVal');
  const rngDl = document.getElementById('rngDl');
const rngDlVal = document.getElementById('rngDlVal');
const rngDlSub = document.getElementById('rngDlSub');
const rngDlSubVal = document.getElementById('rngDlSubVal');
  const lyrChips = document.getElementById('lyrChips');
  const logBox = document.getElementById('logBox');
  const updTitle = document.getElementById('updTitle');
  const updSub = document.getElementById('updSub');
  const btnUpdate = document.getElementById('btnUpdate');
  const sumTotal = document.getElementById('sumTotal');
  const chartDays = document.getElementById('chartDays');
  const chartTop = document.getElementById('chartTop');
  const dayLabels = document.getElementById('dayLabels');
  const trackRows = document.getElementById('trackRows');
  const histList = document.getElementById('histList');

  const api = window.island;
  if (!api) return;

  // ---------------------------------------------------------------- 侧边导航
  const pages = document.querySelectorAll('.md3-page');
  document.querySelectorAll('.md3-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.md3-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.page;
      pages.forEach((pg) => pg.classList.toggle('active', pg.id === 'page-' + target));
      if (target === 'stats') refresh(); // 页面显示后重绘图表(隐藏时宽度为 0)
      if (target === 'logs') loadLogs();
    });
  });

  // ---------------------------------------------------------------- 窗口控制(自绘标题栏)
  const btnMin = document.getElementById('btnMin');
  const btnClose = document.getElementById('btnClose');
  if (btnMin && api.winCtrl) btnMin.addEventListener('click', () => api.winCtrl('minimize'));
  if (btnClose && api.winCtrl) btnClose.addEventListener('click', () => api.winCtrl('close'));

  // 窗口尺寸变化 -> 统计图表重绘
  let rszTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(rszTimer);
    rszTimer = setTimeout(() => { if (statsPageVisible()) refresh(); }, 200);
  });

  // ---------------------------------------------------------------- 开关
  // 轨道视觉状态由 JS class 同步(不依赖 CSS 兄弟选择器的失效时机)
  function syncSwitch(el) {
    const t = el.nextElementSibling;
    if (t && t.classList) t.classList.toggle('checked', el.checked);
  }
  function bindSwitch(el, key) {
    el.addEventListener('change', async () => {
      syncSwitch(el); // 先行同步视觉, 配置回包后再校正
      const cfg = await api.setCfg(key, el.checked);
      applyCfg(cfg);
    });
  }
  function applyCfg(cfg) {
    swGlass.checked = !!cfg.glass;
    swDlyr.checked = !!cfg.dlyr;
    swBi.checked = cfg.bilingual !== false;
    swAuto.checked = !!cfg.autostart;
    swFs.checked = cfg.fsHide !== false;
    [swGlass, swDlyr, swBi, swAuto, swFs, swTb].forEach(syncSwitch);
    selPos.value = cfg.islandPos === 'bottom' ? 'bottom' : 'top';
    syncSelLabel(selPos);
    syncSelLabel(selSleep);
    lyrSources = (Array.isArray(cfg.lyrSources) && cfg.lyrSources.length) ? cfg.lyrSources.slice() : ['soda', 'netease', 'qq', 'kugou'];
    renderChips();
    selStrategy.value = cfg.lyrStrategy === 'quality' ? 'quality' : 'race';
    syncSelLabel(selStrategy);
    setRange(rngLyr, rngLyrVal, cfg.lyrSize || 12.5, (v) => v.toFixed(1));
    setRange(rngDl, rngDlVal, cfg.dlyrSize || 32, (v) => v + ' px');
    setRange(rngDlSub, rngDlSubVal, cfg.dlyrSubSize || 17, (v) => v + ' px');
    if (cfg.version) document.getElementById('appVer').textContent = cfg.version;
  }
  function syncSelLabel(sel) {
    const label = sel.parentElement.querySelector('.md3-select__value');
    if (label) label.textContent = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
  }
  function bindSelect(sel, key) {
    sel.addEventListener('change', async () => {
      syncSelLabel(sel); // 先行同步视觉, 配置回包后再校正
      const num = Number(sel.value);
      const cfg = await api.setCfg(key, isFinite(num) && String(num) === sel.value ? num : sel.value);
      applyCfg(cfg);
    });
  }
  // MD3 滑动条: 轨道填充比 + 数值标签 + 防抖写配置
  function setRange(input, valEl, v, fmt) {
    input.value = v;
    paintRange(input);
    valEl.textContent = fmt(Number(v));
  }
  function paintRange(input) {
    const min = Number(input.min), max = Number(input.max);
    const p = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--p', p + '%');
  }
  function bindRange(input, valEl, key, fmt) {
    let t = null;
    input.addEventListener('input', () => {
      paintRange(input);
      valEl.textContent = fmt(Number(input.value));
      clearTimeout(t);
      t = setTimeout(async () => {
        const cfg = await api.setCfg(key, Number(input.value));
        applyCfg(cfg);
      }, 400);
    });
  }
  bindSwitch(swGlass, 'glass');
  bindSwitch(swDlyr, 'dlyr');
  bindSwitch(swBi, 'bilingual');
  bindSwitch(swAuto, 'autostart');
  bindSwitch(swFs, 'fsHide');
  bindSwitch(swTb, 'taskbar');
  bindSelect(selStrategy, 'lyrStrategy');
  bindSelect(selPos, 'islandPos');
  bindRange(rngLyr, rngLyrVal, 'lyrSize', (v) => v.toFixed(1));
  bindRange(rngDl, rngDlVal, 'dlyrSize', (v) => v + ' px');
  bindRange(rngDlSub, rngDlSubVal, 'dlyrSubSize', (v) => v + ' px');

  // ---------------------------------------------------------------- 音源多选
  let lyrSources = ['soda', 'netease', 'qq', 'kugou'];
  function renderChips() {
    [...lyrChips.children].forEach((ch) => ch.classList.toggle('on', lyrSources.includes(ch.dataset.id)));
  }
  lyrChips.addEventListener('click', async (e) => {
    const ch = e.target.closest('.md3-chip');
    if (!ch) return;
    const id = ch.dataset.id;
    if (lyrSources.includes(id)) {
      if (lyrSources.length > 1) lyrSources = lyrSources.filter((x) => x !== id); // 至少保留一个
    } else {
      lyrSources.push(id);
    }
    renderChips();
    const cfg2 = await api.setCfg('lyrSources', lyrSources);
    applyCfg(cfg2);
  });
    // ---------------------------------------------------------------- 定时停止
  function fmtSleep(endAt) {
    if (!endAt || endAt <= Date.now()) return '到时自动暂停播放';
    const s = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    return '剩余 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' 后暂停播放';
  }
  async function refreshSleep() {
    try {
      const st = await api.sleepGet();
      sleepSub.textContent = fmtSleep(st.endAt);
    } catch { }
  }
  selSleep.addEventListener('change', async () => {
    syncSelLabel(selSleep);
    try { await api.sleepSet(Number(selSleep.value) || 0); } catch { }
    refreshSleep();
  });
  setInterval(refreshSleep, 1000);
  refreshSleep();

  // ---------------------------------------------------------------- 报告图 / 备份
  let lastStats = null;
  function collectFavs() {
    const favs = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('fav:')) favs[k] = localStorage.getItem(k);
      }
    } catch { }
    return favs;
  }
  function applyFavs(favs) {
    try {
      const olds = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('fav:')) olds.push(k);
      }
      olds.forEach((k) => localStorage.removeItem(k));
      for (const k of Object.keys(favs || {})) localStorage.setItem(k, favs[k]);
    } catch { }
  }
  function flashBtn(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
  const btnReport = document.getElementById('btnReport');
  const btnExport = document.getElementById('btnExport');
  const btnImport = document.getElementById('btnImport');
  if (btnReport) btnReport.addEventListener('click', () => { if (lastStats) genReport(lastStats); });
  if (btnExport) btnExport.addEventListener('click', async () => {
    if (!api.backupExport) return;
    const r = await api.backupExport(collectFavs()).catch(() => null);
    flashBtn(btnExport, r && r.ok ? '已导出 ✓' : '导出失败');
  });
  if (btnImport) btnImport.addEventListener('click', async () => {
    if (!api.backupImport) return;
    const r = await api.backupImport(collectFavs()).catch(() => null);
    if (r && r.ok) {
      applyFavs(r.favs);
      if (r.config) applyCfg(r.config);
      flashBtn(btnImport, '已导入 ✓');
      refresh();
    } else {
      flashBtn(btnImport, (r && r.message) ? '失败' : '已取消');
    }
  });

  // 报告图: canvas 绘制并下载 PNG
  function genReport(st) {
    const W = 1000, H = 1400;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#141218';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#d0bcff';
    g.font = '700 52px "Segoe UI", "Microsoft YaHei UI", sans-serif';
    g.fillText('MediaIsle 听歌报告', 64, 120);
    g.fillStyle = 'rgba(202,196,208,.7)';
    g.font = '24px "Segoe UI", sans-serif';
    g.fillText('生成于 ' + new Date().toLocaleString('zh-CN', { hour12: false }), 64, 168);
    let total = 0, days = 0;
    for (const k of Object.keys(st.days || {})) { total += st.days[k] || 0; if ((st.days[k] || 0) > 60) days++; }
    const fmtH = (sec) => (sec >= 3600 ? (sec / 3600).toFixed(1) + ' 小时' : Math.round(sec / 60) + ' 分钟');
    g.fillStyle = '#e6e0e9';
    g.font = '700 40px "Segoe UI", sans-serif';
    g.fillText(total >= 60 ? fmtH(total) : '0 分钟', 64, 280);
    g.fillStyle = 'rgba(202,196,208,.7)';
    g.font = '22px "Segoe UI", sans-serif';
    g.fillText('累计收听 · 活跃 ' + days + ' 天', 64, 322);
    // Top5
    const top = Object.values(st.tracks || {}).sort((a, b) => (b.sec || 0) - (a.sec || 0)).slice(0, 5);
    const maxSec = top.length ? top[0].sec || 1 : 1;
    g.fillStyle = '#cac4d0';
    g.font = '500 26px "Segoe UI", sans-serif';
    g.fillText('最常听 Top 5', 64, 420);
    top.forEach((t, i) => {
      const y = 490 + i * 110;
      g.fillStyle = 'rgba(230,224,233,.06)';
      g.fillRect(64, y - 38, W - 128, 88);
      g.fillStyle = '#e6e0e9';
      g.font = '600 24px "Segoe UI", sans-serif';
      g.fillText((i + 1) + '. ' + (t.t || '(未知)'), 92, y);
      g.fillStyle = 'rgba(202,196,208,.8)';
      g.font = '19px "Segoe UI", sans-serif';
      g.fillText((t.a || '') + ' · ' + fmtH(t.sec || 0), 92, y + 30);
      g.fillStyle = '#d0bcff';
      g.fillRect(64, y + 44, (W - 128 - 40) * Math.min(1, (t.sec || 0) / maxSec), 6);
    });
    // 最常听歌手
    const byArtist = {};
    for (const t of Object.values(st.tracks || {})) {
      const a = (t.a || '').split('/')[0];
      if (!a) continue;
      byArtist[a] = (byArtist[a] || 0) + (t.sec || 0);
    }
    const artists = Object.entries(byArtist).sort((a, b) => b[1] - a[1]);
    if (artists.length) {
      g.fillStyle = '#cac4d0';
      g.font = '500 26px "Segoe UI", sans-serif';
      g.fillText('最常听歌手: ' + artists[0][0] + ' · ' + fmtH(artists[0][1]), 64, 1080);
    }
    g.fillStyle = 'rgba(202,196,208,.45)';
    g.font = '20px "Segoe UI", sans-serif';
    g.fillText('由 MediaIsle 生成 · 随心而动，乐在岛上', 64, H - 64);
    const a = document.createElement('a');
    a.download = 'MediaIsle-听歌报告-' + new Date().toISOString().slice(0, 10) + '.png';
    a.href = cv.toDataURL('image/png');
    a.click();
  }

  // ---------------------------------------------------------------- 日志页
  let logsLoaded = false;
  function fmtLogTime(t) {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }
  function appendLogLine(entry) {
    const div = document.createElement('div');
    div.className = 'ln' + (entry.level === 'error' ? ' err' : '');
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtLogTime(entry.t);
    div.appendChild(ts);
    div.appendChild(document.createTextNode(entry.line));
    logBox.appendChild(div);
    logBox.scrollTop = logBox.scrollHeight;
  }
  async function loadLogs() {
    try {
      const logs = await api.logGet();
      logBox.innerHTML = '';
      logs.forEach(appendLogLine);
      logsLoaded = true;
    } catch { }
  }
  if (api.onLogAppended) api.onLogAppended((entry) => {
    if (!logsLoaded || !logBox.isConnected) return;
    if (!document.getElementById('page-logs').classList.contains('active')) return;
    appendLogLine(entry);
  });
  document.getElementById('btnLogClear').addEventListener('click', () => { api.logClear(); logBox.innerHTML = ''; });
  document.getElementById('btnLogCopy').addEventListener('click', async () => {
    try {
      const text = [...logBox.children].map((d) => d.textContent).join('\n');
      await navigator.clipboard.writeText(text);
    } catch { }
  });

  // ---------------------------------------------------------------- 自动更新
  const updProg = document.getElementById('updProg');
  const updFill = document.getElementById('updFill');
  const updTxt = document.getElementById('updTxt');
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  async function refreshUpdate() {
    if (!api.updateGet) return;
    try {
      const st = await api.updateGet();
      if (!st.packaged) {
        updTitle.textContent = '当前为源代码运行';
        updSub.textContent = '开发模式不检查更新';
        btnUpdate.hidden = true;
        updProg.hidden = true;
        return;
      }
      const fmt = (d) => (Date.parse(d) > 0 ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '未知');
      const prog = st.prog || {};
      if (st.stage === 'download') {
        updTitle.textContent = '正在下载更新…';
        updSub.textContent = '下载完成后自动解压并重启';
        updProg.hidden = false;
        updFill.style.width = (prog.percent || 0).toFixed(1) + '%';
        updTxt.textContent = (prog.total ? mb(prog.received) + ' / ' + mb(prog.total) + ' · ' : mb(prog.received) + ' · ')
          + (prog.percent || 0).toFixed(1) + '% · ' + mb(prog.speed || 0) + '/s';
        btnUpdate.disabled = true; btnUpdate.hidden = false; return;
      }
      updProg.hidden = true;
      if (st.stage === 'extract') { updTitle.textContent = '正在解压更新…'; updSub.textContent = '请稍候'; btnUpdate.disabled = true; btnUpdate.hidden = false; return; }
      if (st.stage === 'restart') { updTitle.textContent = '即将重启完成更新…'; btnUpdate.disabled = true; btnUpdate.hidden = false; return; }
      if (st.stage === 'error') {
        updTitle.textContent = '更新失败';
        updSub.textContent = st.message || '发生未知错误';
        btnUpdate.hidden = false; btnUpdate.disabled = false; btnUpdate.textContent = '重试';
        return;
      }
      btnUpdate.textContent = '立即更新';
      updProg.hidden = true;
      if (st.available) {
        updTitle.textContent = '发现新版本' + (st.available.version ? ' (v' + st.available.version + ')' : '');
        updSub.textContent = '新构建 ' + fmt(st.available.buildDate) + ' · 当前构建 ' + fmt(st.localBuildDate);
        btnUpdate.hidden = false; btnUpdate.disabled = false;
      } else {
        updTitle.textContent = '已是最新版本';
        updSub.textContent = '当前构建 ' + fmt(st.localBuildDate);
        btnUpdate.hidden = true;
      }
    } catch { }
  }
  if (api.onUpdateStatus) api.onUpdateStatus(() => refreshUpdate());
  if (btnUpdate) btnUpdate.addEventListener('click', async () => { btnUpdate.disabled = true; try { await api.updateApply(); } catch { } refreshUpdate(); });
  refreshUpdate();

  // ---------------------------------------------------------------- 工具
  // MD3 令牌读取 (图表绘制需要具体色值, 从 CSS 令牌解析)
  const TOK = {};
  (function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n) => cs.getPropertyValue(n).trim();
    TOK.primary = get('--md-sys-color-primary');
    TOK.onSurface = get('--md-sys-color-on-surface');
    TOK.onSurfaceVariant = get('--md-sys-color-on-surface-variant');
  })();
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function fmtSec(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + ' 秒';
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return (h > 0 ? h + ' 小时 ' : '') + m + ' 分钟';
  }
  function shortDur(sec) {
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    return (sec / 3600).toFixed(1) + 'h';
  }

  function setupCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.parentElement.clientWidth || 480;
    const h = parseInt(cv.getAttribute('height'), 10);
    cv.width = w * dpr;
    cv.height = h * dpr;
    cv.style.height = h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function statsPageVisible() {
    const pg = document.getElementById('page-stats');
    return pg && pg.classList.contains('active');
  }

  // ---------------------------------------------------------------- 图表: 近14天柱状
  function drawDays(days) {
    const vals = [], labels = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      vals.push(days[k] || 0);
      labels.push(String(d.getDate()).padStart(2, '0'));
    }
    const { g, w, h } = setupCanvas(chartDays);
    g.clearRect(0, 0, w, h);
    const padL = 6, padR = 6, padT = 18, barGap = 5;
    const n = vals.length;
    const bw = Math.max(8, (w - padL - padR - barGap * (n - 1)) / n);
    const maxV = Math.max(...vals, 60);
    const plotH = h - padT;

    for (let i = 0; i < n; i++) {
      const x = padL + i * (bw + barGap);
      const bh = Math.max(vals[i] > 0 ? 3 : 1.5, (vals[i] / maxV) * plotH);
      const y = h - bh;
      // 柱体 (primary / surface 10%)
      g.fillStyle = vals[i] > 0 ? TOK.primary : rgba(TOK.onSurface, .10);
      roundRect(g, x, y, bw, bh, Math.min(4, bw / 2));
      g.fill();
      // 时长标注 (on-surface 55%)
      if (vals[i] > 0 && bh > padT - 6) {
        g.fillStyle = rgba(TOK.onSurface, .55);
        g.font = '9px Segoe UI';
        g.textAlign = 'center';
        g.fillText(shortDur(vals[i]), x + bw / 2, y - 4);
      }
    }
    // x 轴日期标签
    dayLabels.innerHTML = '';
    labels.forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      dayLabels.appendChild(s);
    });
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, 0);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // ---------------------------------------------------------------- 图表: Top8 横向条
  function drawTop(tracks) {
    const list = Object.values(tracks)
      .sort((a, b) => (b.sec || 0) - (a.sec || 0))
      .slice(0, 8);
    const { g, w } = setupCanvas(chartTop);
    const h = parseInt(chartTop.getAttribute('height'), 10);
    g.clearRect(0, 0, w, h);
    if (!list.length) {
      g.fillStyle = rgba(TOK.onSurface, .30);
      g.font = '12px Segoe UI';
      g.textAlign = 'center';
      g.fillText('暂无播放记录', w / 2, h / 2);
      return;
    }
    const rowH = h / list.length;
    const nameW = Math.min(190, w * .42);
    const barMax = w - nameW - 52;
    const maxV = Math.max(...list.map((t) => t.sec || 0), 1);

    list.forEach((t, i) => {
      const cy = i * rowH + rowH / 2;
      // 曲名 (on-surface 85%)
      g.fillStyle = rgba(TOK.onSurface, .85);
      g.font = '11px Segoe UI';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      let name = t.t || '(未知)';
      while (name.length > 3 && g.measureText(name).width > nameW - 8) name = name.slice(0, -2) + '…';
      g.fillText(name, 4, cy);
      // 条 (primary)
      const bw = Math.max(3, ((t.sec || 0) / maxV) * barMax);
      g.fillStyle = TOK.primary;
      roundRect(g, nameW, cy - 5, bw, 10, 5);
      g.fill();
      // 时长 (on-surface 45%)
      g.fillStyle = rgba(TOK.onSurface, .45);
      g.font = '10px Segoe UI';
      g.textAlign = 'right';
      g.fillText(shortDur(t.sec || 0), w - 4, cy);
    });
    g.textBaseline = 'alphabetic';
  }

  // ---------------------------------------------------------------- 曲目明细表
  function drawTable(tracks) {
    const list = Object.values(tracks).sort((a, b) => (b.sec || 0) - (a.sec || 0)).slice(0, 200);
    trackRows.innerHTML = '';
    if (!list.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" class="empty-tip">暂无数据，播放音乐后这里会自动记录</td>';
      trackRows.appendChild(tr);
      return;
    }
    for (const t of list) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(t.t || '(未知)') + '</td>' +
        '<td class="dim">' + esc(t.a || '') + '</td>' +
        '<td class="dim">' + esc(t.s || '') + '</td>' +
        '<td class="num">' + (t.plays || 0) + '</td>' +
        '<td class="num">' + fmtSec(t.sec || 0) + '</td>';
      trackRows.appendChild(tr);
    }
  }
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  // ---------------------------------------------------------------- 加载/刷新
  async function refresh() {
    try {
      const st = await api.getStats();
      lastStats = st;
      let total = 0;
      for (const k of Object.keys(st.days || {})) total += st.days[k];
      sumTotal.textContent = total >= 60 ? ('累计收听 ' + fmtSec(total)) : '';
      if (!statsPageVisible()) return; // 隐藏时 canvas 宽度为 0, 跳过绘制
      drawDays(st.days || {});
      drawTop(st.tracks || {});
      drawTable(st.tracks || {});
      drawHistory(st.history || []);
    } catch { }
  }
  function drawHistory(history) {
    if (!histList) return;
    histList.innerHTML = '';
    const list = (history || []).slice(-100).reverse();
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'fl-empty';
      d.textContent = '暂无播放记录';
      histList.appendChild(d);
      return;
    }
    for (const h of list) {
      const row = document.createElement('div');
      row.className = 'hist-row';
      const d0 = new Date(h.t);
      const time = String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0') + ' '
        + String(d0.getHours()).padStart(2, '0') + ':' + String(d0.getMinutes()).padStart(2, '0');
      const t = document.createElement('span');
      t.className = 'ht';
      t.textContent = time;
      const n = document.createElement('span');
      n.className = 'hn';
      n.textContent = h.title || '(未知)';
      const a = document.createElement('span');
      a.className = 'ha';
      a.textContent = h.artist || '';
      row.appendChild(t); row.appendChild(n); row.appendChild(a);
      histList.appendChild(row);
    }
  }
  api.onStatsUpdated(refresh);
  api.getCfg().then(applyCfg).catch(() => { });
  refresh();
})();
