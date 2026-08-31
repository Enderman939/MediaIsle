// MediaIsle - 桌面歌词窗口
// 数据: { x: 原文, s: 译文(可空) } — 双层结构, 兼容旧版纯字符串
(() => {
  const el = document.getElementById('dlText');
  const sub = document.getElementById('dlSub');
  let cur = null;
  let hideTimer = null;

  // 字号设置: { size: 原文字号px, subSize: 译文字号px }
  window.island.onDesktopStyle((st) => {
    const root = document.documentElement;
    if (st && st.size > 0) root.style.setProperty('--dl-size', st.size + 'px');
    if (st && st.subSize > 0) root.style.setProperty('--dl-sub-size', st.subSize + 'px');
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
      el.classList.add('show');
      if (s) sub.classList.add('show');
    }, 120);
  });
})();
