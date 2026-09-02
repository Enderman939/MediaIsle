// MediaIsle - 桌面歌词窗口
// 数据: { x: 原文, s: 译文(可空) } — 双层结构, 兼容旧版纯字符串
(() => {
  const el = document.getElementById('dlText');
  const sub = document.getElementById('dlSub');
  let cur = null;
  let hideTimer = null;

  // 超宽自动缩字号: 用隐藏测量元素实测文本宽度, 等比缩放 (保底 55%)
  const meas = document.createElement('span');
  meas.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0;';
  document.body.appendChild(meas);
  function fitEl(el) {
    if (!el.textContent) { el.style.fontSize = ''; return; }
    const cs = getComputedStyle(el);
    meas.style.fontWeight = cs.fontWeight;
    meas.style.fontFamily = cs.fontFamily;
    meas.style.letterSpacing = cs.letterSpacing;
    meas.style.fontSize = cs.fontSize;
    meas.textContent = el.textContent;
    const maxW = window.innerWidth * 0.96;
    const w = meas.offsetWidth;
    if (w > maxW && w > 0) {
      const scale = Math.max(0.55, maxW / w);
      el.style.fontSize = (parseFloat(cs.fontSize) * scale).toFixed(1) + 'px';
    } else {
      el.style.fontSize = '';
    }
  }
  window.addEventListener('resize', () => { fitEl(el); fitEl(sub); });

  // 字号设置: { size: 原文字号px, subSize: 译文字号px }
  window.island.onDesktopStyle((st) => {
    const root = document.documentElement;
    if (st && st.size > 0) root.style.setProperty('--dl-size', st.size + 'px');
    if (st && st.subSize > 0) root.style.setProperty('--dl-sub-size', st.subSize + 'px');
    fitEl(el);
    fitEl(sub);
  });

  window.island.onDesktopLine((payload) => {
    let x = '', s = '';
    if (typeof payload === 'string') x = payload;
    else if (payload && typeof payload === 'object') { x = payload.x || ''; s = payload.s || ''; }
    const sig = x + '\u0001' + s;
    if (sig === cur) return;
    cur = sig;

    if (!x) {
      // 无歌词: 渐隐后清空
      el.classList.remove('show');
      sub.classList.remove('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!cur || cur === '\u0001') { el.textContent = ''; sub.textContent = ''; } }, 220);
      return;
    }
    clearTimeout(hideTimer);
    el.classList.remove('show');
    sub.classList.remove('show');
    setTimeout(() => {
      if (cur !== sig) return;
      el.textContent = x;
      sub.textContent = s; // 无翻译时保持空, 占位层不可见
      fitEl(el);
      if (s) fitEl(sub);
      el.classList.add('show');
      if (s) sub.classList.add('show');
    }, 120);
  });
})();
