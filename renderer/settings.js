// MediaIsle - 设置窗口逻辑
(() => {
  const swGlass = document.getElementById('swGlass');
  const swDlyr = document.getElementById('swDlyr');
  const swBi = document.getElementById('swBi');
  const swAuto = document.getElementById('swAuto');
  const swFs = document.getElementById('swFs');
  const selLyric = document.getElementById('selLyric');
  const selLyricLabel = document.getElementById('selLyricLabel');
  const sumTotal = document.getElementById('sumTotal');
  const chartDays = document.getElementById('chartDays');
  const chartTop = document.getElementById('chartTop');
  const dayLabels = document.getElementById('dayLabels');
  const trackRows = document.getElementById('trackRows');

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
    [swGlass, swDlyr, swBi, swAuto, swFs].forEach(syncSwitch);
    selLyric.value = cfg.lyrics || 'race';
    syncSelLabel();
  }
  function syncSelLabel() {
    if (!selLyricLabel) return;
    const op = selLyric.options[selLyric.selectedIndex];
    selLyricLabel.textContent = op ? op.textContent : '';
  }
  bindSwitch(swGlass, 'glass');
  bindSwitch(swDlyr, 'dlyr');
  bindSwitch(swBi, 'bilingual');
  bindSwitch(swAuto, 'autostart');
  bindSwitch(swFs, 'fsHide');
  selLyric.addEventListener('change', async () => {
    const cfg = await api.setCfg('lyrics', selLyric.value);
    applyCfg(cfg);
  });
  api.getCfg().then(applyCfg).catch(() => { });

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
      let total = 0;
      for (const k of Object.keys(st.days || {})) total += st.days[k];
      sumTotal.textContent = total >= 60 ? ('累计收听 ' + fmtSec(total)) : '';
      if (!statsPageVisible()) return; // 隐藏时 canvas 宽度为 0, 跳过绘制
      drawDays(st.days || {});
      drawTop(st.tracks || {});
      drawTable(st.tracks || {});
    } catch { }
  }
  api.onStatsUpdated(refresh);
  refresh();
})();
