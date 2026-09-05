// 歌词纠错窗口: 候选搜索 + 手动选定 (选定后主进程通知岛体重抓)
(() => {
  const songLine = document.getElementById('songLine');
  const status = document.getElementById('status');
  const list = document.getElementById('list');
  const srcName = { soda: '汽水', netease: '网易', qq: 'QQ', kugou: '酷狗' };

  document.getElementById('btnClose').addEventListener('click', () => window.close());
  document.getElementById('btnMin').addEventListener('click', () => window.island.winCtrl('minimize'));

  const fmtDur = (s) => (s > 0 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '');

  function render(cands) {
    list.innerHTML = '';
    if (!cands || !cands.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '未找到候选歌词。请确认音源设置中已启用对应平台，或稍后重试。';
      list.appendChild(d);
      return;
    }
    status.textContent = '共 ' + cands.length + ' 个候选，点击应用';
    for (const c of cands) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.key = c.key;
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = srcName[c.src] || c.src;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.name || '(未知)';
      const artist = document.createElement('div');
      artist.className = 'artist';
      artist.textContent = c.artist || '';
      meta.appendChild(name);
      meta.appendChild(artist);
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = fmtDur(c.dur);
      row.appendChild(src);
      row.appendChild(meta);
      row.appendChild(dur);
      row.addEventListener('click', async () => {
        status.textContent = '正在应用…';
        const r = await window.island.lyrPick({
          songKey: (ctx.title + '|' + ctx.artist),
          src: c.src,
          key: c.key,
        }).catch(() => null);
        if (r && r.ok) {
          list.querySelectorAll('.row').forEach((x) => x.classList.remove('picked'));
          row.classList.add('picked');
          status.textContent = '已应用，岛体歌词已更新 ✓';
        } else {
          status.textContent = '应用失败' + (r && r.message ? '：' + r.message : '，请重试其他候选');
        }
      });
      list.appendChild(row);
    }
  }

  let ctx = {};
  (async () => {
    try {
      ctx = await window.island.lyrFixContext();
      songLine.textContent = [ctx.title, ctx.artist].filter(Boolean).join(' — ');
      const cands = await window.island.lyrCandidates(ctx);
      if (ctx.pickedKey) {
        const picked = cands.find((c) => c.key === ctx.pickedKey);
        if (picked) picked.pickedMark = true;
      }
      render(cands);
      if (ctx.pickedKey) {
        const cur = [...list.querySelectorAll('.row')].find((r) => r.dataset.key === ctx.pickedKey);
        if (cur) { cur.classList.add('picked'); status.textContent = '当前使用此版本（点击其他候选可切换）'; }
      }
    } catch (e) {
      status.textContent = '加载失败: ' + (e && e.message ? e.message : e);
    }
  })();
})();
