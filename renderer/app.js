// =====================================================================
// MediaIsle - 渲染层逻辑
//  - 状态机: idle / compact / expanded / expanded-empty
//  - 鼠标穿透切换: 默认穿透, 悬停岛内时恢复交互并展开
//  - 进度条本地插值平滑 + 拖动 seek
// =====================================================================
(() => {
  const $ = (id) => document.getElementById(id);

  const island = $('island');
  const api = window.island;

  const cArt = $('cArt'), cArtImg = $('cArtImg');
  const cTitleWrap = $('cTitleWrap'), cMarquee = $('cMarquee'), cText = $('cText');
  const eArt = $('eArt'), eArtImg = $('eArtImg');
  const eTitle = $('eTitle'), eSub = $('eSub'), eArtist = $('eArtist'), eSource = $('eSource'), eDot = $('eDot');
  const tCur = $('tCur'), tDur = $('tDur');
  const pBar = $('pBar'), pKnobWrap = $('pKnobWrap');
  const pFill = pBar.children[1]; // .p-fill (无 id, 合成器通道驱动)
  const btnPrev = $('btnPrev'), btnNext = $('btnNext'), btnToggle = $('btnToggle');
  const btnShuffle = $('btnShuffle'), btnRepeat = $('btnRepeat'), btnFav = $('btnFav');
  const vBar = $('vBar'), vKnob = $('vKnob'), vMuteBtn = $('vMuteBtn'), vKnobWrap = $('vKnobWrap');
  const eVBar = $('eVBar'), eVKnob = $('eVKnob'), eMuteBtn = $('eMuteBtn'), eVKnobWrap = $('eVKnobWrap');
  const vFill = vBar.children[1];   // .p-fill
  const eVFill = eVBar.children[1]; // .p-fill
  const icPlay = $('icPlay'), icPause = $('icPause');
  const eAlbum = $('eAlbum'), eDotB = $('eDotB');
  const nArt = $('nArt'), nArtImg = $('nArtImg'), nTitle = $('nTitle'), nSub = $('nSub');
  const eLyrics = $('eLyrics'), ylTrack = $('ylTrack'), srcChips = $('srcChips'), eStats = $('eStats');
  const flBack = $('flBack'), flCount = $('flCount'), flList = $('flList');

  // ---------------------------------------------------------------- 状态
  const S = {
    hasSession: false,
    appId: '', title: '', artist: '', album: '', source: '', status: 'Unknown',
    position: 0, duration: 0, posAge: 0,
    canPlay: false, canPause: false, canNext: false, canPrev: false, canSeek: false,
    canShuffle: false, canRepeat: false, isShuffle: false, repeatMode: 0,
    volume: 50, mute: false,
    sources: [], selApp: '',
    lyrics: null, lyricKey: '',
    trans: [], bilingual: true, lyrSize: 12.5,
    art: null,
    updatedAt: 0,
    seekGraceUntil: 0,   // seek 后的桥接帧宽限期(防视觉回跳)
  };

  let hovered = false;
  let dragging = false;
  let dragPos = 0;
  let lastTitle = '';
  let lastArt = null;
  let firstFrame = true;
  let volActiveUntil = 0;   // 音量胶囊自动隐藏时刻
  let notifyUntil = 0;      // 换歌气泡自动隐藏时刻
  let chipsSig = '';
  let curLineIdx = -1;      // 当前歌词行索引
  let lastDl = '';          // 已推送的桌面歌词行
  let lyricsBuiltKey = '';  // 已构建的歌词 DOM 键
  let lyrEls = [];          // 虚拟窗口内的行元素
  let lineTrans = [];       // 行号 -> 翻译文本(时间戳对齐)
  let lyrHeights = [];      // 虚拟窗口内各行的实测高度(长句换行后更高)
  let lyrWinStart = -1;     // 虚拟窗口起始行号
  let lyrLastY = 0;         // 轨道当前位移
  let lastDomIdx = -999;    // 已高亮的行号(-999 强制刷新)
  let lastLyrCheck = 0;     // 歌词节流
  let lyricSmoothPos = null;// 歌词平滑时钟(滤掉桥接帧锯齿与补偿量抖动)
  let lastTickTs = performance.now();
  const lastUi = { artist: null, album: null, source: null, dotA: null, dotB: null, dis: [null, null, null, null, null], shuf: null, rep: null, fav: null, favKey: null };

  const isPlaying = () => S.status === 'Playing' || S.status === 'Changing';
  const autoState = () => (S.hasSession ? 'compact' : 'idle');
  const expandState = () => (S.hasSession ? 'expanded' : 'expanded-empty');
  const curState = () => island.dataset.state;
  const isTransient = (st) => st === 'volume' || st === 'notify';

  // 全局错误上报: 未捕获异常/Promise 拒绝 -> console.error
  // (主进程经 console-message 转发到控制台并写入 error.log)
  window.addEventListener('error', (e) => {
    console.error('[island:error]', (e && e.message) || e, e && e.filename ? `${e.filename}:${e.lineno}` : '', (e && e.error && e.error.stack) || '');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    console.error('[island:unhandled]', (r && (r.stack || r.message)) || String(r));
  });

  function setState(st) {
    if (island.dataset.state !== st) {
      island.dataset.state = st;
      api.reportState(st); // 通知主进程更新命中检测矩形
    }
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // ---------------------------------------------------------------- 收藏
  function getFavKey() {
    return (S.appId || '') + '|' + (S.title || '') + '|' + (S.artist || '');
  }
  function isFavTrack() {
    if (!S.title) return false;
    try { return localStorage.getItem('fav:' + getFavKey()) !== null; } catch { return false; }
  }
  function toggleFav() {
    if (!S.title) return;
    const key = 'fav:' + getFavKey();
    const now = isFavTrack();
    try {
      if (now) { localStorage.removeItem(key); }
      else { localStorage.setItem(key, JSON.stringify({ t: S.title, a: S.artist })); }
    } catch { }
    render();
  }
  // 收藏条目列表(兼容旧版纯 '1' 值)
  function favEntries() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('fav:')) continue;
        const raw = localStorage.getItem(k) || '';
        let t = '', a = '';
        try { const j = JSON.parse(raw); t = j.t || ''; a = j.a || ''; }
        catch { const p = k.slice(4).split('|'); t = p[1] || ''; a = p[2] || ''; }
        out.push({ k, t: t || '(未知曲目)', a });
      }
    } catch { }
    return out.sort((x, y) => x.k.localeCompare(y.k));
  }

  // ---------------------------------------------------------------- 收听统计(主进程记录, 此处仅展示)
  api.onStatsText((text) => { eStats.textContent = text || ''; });

  // ---------------------------------------------------------------- 音量
  let vPct = -1;
  function renderVolumeUI() {
    const pct = S.mute ? 0 : Math.min(100, Math.max(0, S.volume));
    if (Math.abs(pct - vPct) < 0.02) { island.dataset.mute = S.mute ? 'true' : 'false'; return; }
    vPct = pct;
    const f = (pct / 100).toFixed(4);
    const t = 'translateY(-50%) scaleX(' + f + ')';
    vFill.style.transform = t;
    eVFill.style.transform = t;
    const x = 'translateX(' + pct.toFixed(3) + '%)';
    vKnobWrap.style.transform = x;
    eVKnobWrap.style.transform = x;
    island.dataset.mute = S.mute ? 'true' : 'false';
  }

  function applyVolume(pct, send) {
    S.volume = pct;
    if (S.mute && pct > 0) { S.mute = false; }
    island.dataset.mute = S.mute ? 'true' : 'false';
    renderVolumeUI();
    if (send) api.command('volume', pct);
  }

  // 音量滑条绑定 (胶囊态与展开面板共用)
  function bindVolumeSlider(bar) {
    let d = false, val = 0, lastSend = 0;
    const from = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100));
    };
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      d = true;
      volActiveUntil = performance.now() + 1500; // 拖动视为操作
      api.setDragging(true); // 拖动期间保持展开
      bar.classList.add('dragging');
      try { bar.setPointerCapture(e.pointerId); } catch { }
      val = from(e);
      lastSend = performance.now();
      applyVolume(val, true);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!d) return;
      val = from(e);
      volActiveUntil = performance.now() + 1500;
      renderVolumeUI();
      // 拖动中节流发送 (~70ms)
      if (performance.now() - lastSend > 70) {
        lastSend = performance.now();
        api.command('volume', val);
      }
    });
    const end = () => {
      if (!d) return;
      d = false;
      api.setDragging(false);
      bar.classList.remove('dragging');
      api.command('volume', val);
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }

  bindVolumeSlider(vBar);
  bindVolumeSlider(eVBar);

  [vMuteBtn, eMuteBtn].forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      api.command('toggle-mute');
      S.mute = !S.mute; // 乐观更新, 音量事件会校正
      island.dataset.mute = S.mute ? 'true' : 'false';
      renderVolumeUI();
    });
  });
  // 系统音量变化 (键盘音量键等): 更新UI并自动弹出音量胶囊
  api.onVolume((v) => {
    S.volume = typeof v.volume === 'number' ? v.volume : S.volume;
    S.mute = !!v.mute;
    renderVolumeUI();
    volActiveUntil = performance.now() + 1500;
    if (!hovered && !dragging && island.dataset.state !== 'volume') {
      setState('volume');
    }
  });

  // ---------------------------------------------------------------- 状态接收
  function onStateImpl(st) {
    if (!st || st.type !== 'state') return;
    const prevTitle = S.title;
    const prevSession = S.hasSession;

    S.hasSession = !!st.hasSession;
    S.appId = st.appId || '';
    S.title = st.title || '';
    S.artist = st.artist || '';
    S.album = st.album || '';
    S.source = st.source || '';
    S.status = st.status || 'Unknown';

    // 换歌 -> 弹跳 + 后台通知气泡 (跳过首帧)
    const trackChanged = S.hasSession && S.title !== prevTitle;

    // 时间轴年龄校正: SMTC 的 Position 是 posAge 秒前的采样值,
    // 真实位置 = Position + posAge。部分播放器(如 Spotify)数秒才刷新一次时间轴,
    // 不校正则进度/歌词系统性落后最多数秒。暂停时 Position 即真实值, 不加。
    // 无时间轴播放器(网易云等): SMTC timeline 恒为 0, 进度改由本地时钟插值
    // (tick), 时长用歌词源返回的曲目时长估算, 桥接帧不得清零本地位置。
    const stDur = st.duration || 0;
    const rawPos = st.position || 0;
    if (stDur > 0) S.duration = stDur;
    if (stDur > 0 || rawPos > 0) {
      let posAge = (typeof st.posAge === 'number' && isFinite(st.posAge)) ? Math.max(0, st.posAge) : 0;
      if (!(S.duration > 0) || posAge > S.duration) posAge = 0;
      const playingNow = st.status === 'Playing' || st.status === 'Changing';
      const corrected = rawPos + (playingNow ? posAge : 0);
      // seek 宽限: 拖动后短时间内忽略明显回退的桥接帧(时间轴未刷新的旧采样)
      if (!(performance.now() < S.seekGraceUntil && corrected < S.position - 2)) {
        S.position = S.duration > 0 ? Math.min(corrected, S.duration) : corrected;
      }
      S.posAge = posAge;
    } else if (trackChanged) {
      // 无时间轴: 换曲后旧估算作废, 从 0 开始本地插值
      S.position = 0;
      S.posAge = 0;
      S.duration = 0;
    }
    S.canPlay = !!st.canPlay;
    S.canPause = !!st.canPause;
    S.canNext = !!st.canNext;
    S.canPrev = !!st.canPrev;
    S.canSeek = !!st.canSeek;
    S.canShuffle = !!st.canShuffle;
    S.canRepeat = !!st.canRepeat;
    S.isShuffle = !!st.isShuffle;
    S.repeatMode = st.repeatMode || 0;
    if (Array.isArray(st.sources)) {
      S.sources = st.sources.filter((s) => s && s.id).map((s) => ({ id: s.id, name: s.name || s.id }));
    }
    S.selApp = st.selApp || '';
    S.art = st.art || null;
    S.updatedAt = performance.now();

    if (trackChanged && !firstFrame && !hovered) triggerBounce();
    if (trackChanged && !firstFrame && !hovered && curState() !== 'volume') {
      nTitle.textContent = S.title || '未知曲目';
      nSub.textContent = [S.artist, S.source].filter(Boolean).join(' · ');
      setState('notify');
      notifyUntil = performance.now() + 2300;
    }
    firstFrame = false;

    // 歌词: 换曲后异步获取(主进程代理请求, 带缓存)
    const lk = (S.title + '|' + S.artist).toLowerCase();
    if (lk !== S.lyricKey) {
      S.lyricKey = lk;
      S.lyrics = null;
      curLineIdx = -1;
      if (S.title) {
        const wantKey = lk;
        api.getLyrics({ title: S.title, artist: S.artist, duration: S.duration })
          .then((r) => {
            if ((S.title + '|' + S.artist).toLowerCase() === wantKey) {
              S.lyrics = (r && r.lines) || [];
              S.trans = (r && r.trans) || [];
              // 无时间轴播放器: 采用歌词源返回的曲目时长作为进度基准
              if (r && r.dur > 0 && !(S.duration > 0)) S.duration = r.dur;
              curLineIdx = -1;
            }
          })
          .catch(() => { });
      }
    }

    render();
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    island.classList.toggle('paused', !isPlaying());

    if (!S.hasSession) {
      if (!hovered && !isTransient(curState())) setState('idle');
      island.dataset.shuffle = 'false';
      island.dataset.repeat = '0';
      island.dataset.fav = 'false';
      return;
    }

    // 文本 (仅变化时写入, 避免无效 layout)
    if (S.title !== lastTitle) {
      lastTitle = S.title;
      eTitle.textContent = S.title || '未知曲目';
      setupMarquee();
    }
    const artistStr = S.artist || '未知歌手';
    if (artistStr !== lastUi.artist) { lastUi.artist = artistStr; eArtist.textContent = artistStr; }
    if (S.album !== lastUi.album) { lastUi.album = S.album; eAlbum.textContent = S.album; }
    if (S.source !== lastUi.source) { lastUi.source = S.source; eSource.textContent = S.source; }
    // 分隔点: 艺术家·专辑·来源 (缺项时智能隐藏)
    const dotA = (S.artist && S.album) ? '' : 'none';
    const dotB = ((S.album && S.source) || (!S.album && S.artist && S.source)) ? '' : 'none';
    if (dotA !== lastUi.dotA) { lastUi.dotA = dotA; eDot.style.display = dotA; }
    if (dotB !== lastUi.dotB) { lastUi.dotB = dotB; eDotB.style.display = dotB; }

    // 封面
    if (S.art !== lastArt) {
      lastArt = S.art;
      const targets = [[cArt, cArtImg], [eArt, eArtImg], [nArt, nArtImg]];
      for (const [box, img] of targets) {
        if (S.art) {
          img.onerror = () => console.error('[island] 封面加载失败, data 长度', (S.art || '').length);
          img.src = S.art;
          box.classList.add('has-img');
        } else {
          img.onerror = null;
          img.removeAttribute('src');
          box.classList.remove('has-img');
        }
      }
    }

    // 按钮 (仅变化时切换)
    const dis = [!S.canPrev, !S.canNext, !(S.canPlay || S.canPause), !S.canShuffle, !S.canRepeat];
    if (dis.some((v, i) => v !== lastUi.dis[i])) {
      lastUi.dis = dis;
      btnPrev.disabled = dis[0]; btnNext.disabled = dis[1];
      btnToggle.disabled = dis[2]; btnShuffle.disabled = dis[3]; btnRepeat.disabled = dis[4];
    }
    icPlay.classList.toggle('hidden', isPlaying());
    icPause.classList.toggle('hidden', !isPlaying());
    pBar.classList.toggle('no-seek', S.duration <= 0);

    // 音源 chips
    buildChips();

    if (!hovered && !isTransient(curState())) setState('compact');
    const fav = isFavTrack();
    if (S.isShuffle !== lastUi.shuf) { lastUi.shuf = S.isShuffle; island.dataset.shuffle = S.isShuffle ? 'true' : 'false'; }
    if (S.repeatMode !== lastUi.rep) { lastUi.rep = S.repeatMode; island.dataset.repeat = String(S.repeatMode); }
    if (fav !== lastUi.fav || S.title !== lastUi.favKey) { lastUi.fav = fav; lastUi.favKey = S.title; island.dataset.fav = fav ? 'true' : 'false'; }
    updateProgressUI();
  }

  // 音源切换 chips
  function buildChips() {
    const sel = S.selApp || S.appId;
    const sig = S.sources.map((s) => s.id).join(',') + '|' + sel;
    if (sig === chipsSig) return;
    chipsSig = sig;
    srcChips.innerHTML = '';
    S.sources.forEach((s) => {
      const el = document.createElement('span');
      el.className = 'chip' + (s.id === sel ? ' on' : '');
      el.textContent = s.name;
      el.title = '切换到 ' + s.name;
      if (s.id !== sel) {
        el.onclick = (ev) => { ev.stopPropagation(); api.command('switch-source', s.id); };
      } else {
        el.onclick = (ev) => ev.stopPropagation();
      }
      srcChips.appendChild(el);
    });
  }

  // chips 溢出时滚轮横滚
  srcChips.addEventListener('wheel', (e) => {
    if (srcChips.scrollWidth <= srcChips.clientWidth) return;
    e.preventDefault();
    srcChips.scrollLeft += (e.deltaY || e.deltaX);
  }, { passive: false });

  // 跑马灯: 标题过长时无缝滚动
  function setupMarquee() {
    const text = S.title || '未知曲目';
    cMarquee.classList.remove('scrolling');
    cMarquee.style.animation = 'none';
    cMarquee.innerHTML = '';
    const s1 = document.createElement('span');
    s1.textContent = text;
    cMarquee.appendChild(s1);

    requestAnimationFrame(() => {
      const wrapW = cTitleWrap.clientWidth;
      const textW = s1.getBoundingClientRect().width;
      if (textW > wrapW && wrapW > 0) {
        const s2 = document.createElement('span');
        s2.textContent = text;
        cMarquee.appendChild(s2);
        cMarquee.style.setProperty('--mq-dur', Math.max(5, textW / 30).toFixed(2) + 's');
        cMarquee.style.animation = '';
        cMarquee.classList.add('scrolling');
      }
    });
  }

  // ---------------------------------------------------------------- 进度
  function currentPos() {
    if (dragging) return dragPos;
    return S.position;
  }

  // 进度 UI: 全部走 transform 合成器通道, 且仅在值变化时写入 DOM
  let uiPct = -1, uiCur = '', uiDur = '';
  function applyPct(pct) {
    if (Math.abs(pct - uiPct) < 0.02) return;
    uiPct = pct;
    const f = Math.max(0, Math.min(1, pct / 100)).toFixed(4);
    pFill.style.transform = 'translateY(-50%) scaleX(' + f + ')';
    pKnobWrap.style.transform = 'translateX(' + pct.toFixed(3) + '%)';
  }

  function updateProgressUI() {
    if (!S.hasSession || S.duration <= 0) {
      if (uiPct !== 0) { applyPctForce(0); }
      if (uiCur !== '0:00') { uiCur = '0:00'; tCur.textContent = uiCur; }
      if (uiDur !== '--:--') { uiDur = '--:--'; tDur.textContent = uiDur; }
      return;
    }
    const pos = currentPos();
    applyPct((pos / S.duration) * 100);
    const c = fmt(pos);
    if (c !== uiCur) { uiCur = c; tCur.textContent = c; }
    const d = fmt(S.duration);
    if (d !== uiDur) { uiDur = d; tDur.textContent = d; }
  }
  function applyPctForce(pct) { uiPct = -1; applyPct(pct); }

  function tick() {
    const now = performance.now();

    // 窗口被遮挡/最小化时跳过全部 UI 工作
    if (document.hidden) { lastTickTs = now; requestAnimationFrame(tick); return; }

    // 音量胶囊/通知气泡超时自动收回 (音量优先级更高)
    if (!hovered) {
      const st = curState();
      if (st === 'volume' && now > volActiveUntil) {
        setState(now < notifyUntil ? 'notify' : autoState());
      } else if (st === 'notify' && now > notifyUntil) {
        setState(autoState());
      }
    }

    // 播放时本地插值更新位置
    const dt = Math.max(0, (now - lastTickTs) / 1000);
    lastTickTs = now;
    if (isPlaying() && S.duration > 0 && !dragging) {
      S.position = Math.min(S.position + dt, S.duration);
      S.updatedAt = now;
    }

    // 歌词行 + 桌面歌词
    updateLyricUI(now);

    updateProgressUI();
    requestAnimationFrame(tick);
  }

  // 多行滚动歌词: 虚拟窗口渲染(仅当前行±7), 仅换行时触碰 DOM, 点击句子跳转
  let LYR_LINE_H = 19;
  let LYR_SUB_H = 15;
  const LYR_WINDOW = 7;
  // 行高: 双语模式下带翻译的行更高
  const rowH = (i) => (S.bilingual && lineTrans[i]) ? LYR_LINE_H + LYR_SUB_H : LYR_LINE_H;

  // 字号应用: CSS 变量 + 行高度量同步 (滚动定位依赖行高); 译文按原文等比
  function applyLyrSize() {
    const s = S.lyrSize || 12.5;
    const sub = Math.round((s - 2) * 2) / 2;
    LYR_LINE_H = Math.ceil(s * 1.52);
    LYR_SUB_H = Math.round(sub * 1.43);
    island.style.setProperty('--lyr-size', s + 'px');
    island.style.setProperty('--lyr-sub-size', sub + 'px');
    island.style.setProperty('--lyr-line-h', LYR_LINE_H + 'px');
    island.style.setProperty('--lyr-sub-h', LYR_SUB_H + 'px');
  }

  // 将翻译行按时间戳对齐到原文行: lineTrans[i] = 第 i 行的翻译
  function rebuildTrans(lines) {
    lineTrans = new Array(lines.length).fill('');
    const tr = S.trans || [];
    let j = 0;
    for (let i = 0; i < lines.length && j < tr.length; i++) {
      while (j < tr.length && tr[j].t < lines[i].t - 0.05) j++;
      if (j < tr.length && Math.abs(tr[j].t - lines[i].t) <= 0.05) { lineTrans[i] = tr[j].x; j++; }
    }
  }

  function buildLyricsDom(lines) {
    lyricsBuiltKey = S.lyricKey + ':' + lines.length;
    rebuildTrans(lines);
    ylTrack.innerHTML = '';
    ylTrack.style.transform = 'translateY(0px)';
    lyrEls = [];
    lyrHeights = [];
    lyrWinStart = -1;
    curLineIdx = -1;
    lastDomIdx = -999;
    lyrLastY = 0;
    lyricSmoothPos = null;
    if (!lines.length) {
      const d = document.createElement('div');
      d.className = 'yl-line ph';
      d.textContent = '♪';
      ylTrack.appendChild(d);
      ylTrack.style.transform = 'translateY(-' + LYR_LINE_H / 2 + 'px)';
    }
  }

  function ensureLyrWindow(lines, center) {
    let start = center - LYR_WINDOW;
    const maxStart = Math.max(0, lines.length - (LYR_WINDOW * 2 + 1));
    if (start < 0) start = 0; else if (start > maxStart) start = maxStart;
    if (start === lyrWinStart) return;
    ylTrack.innerHTML = '';
    lyrEls = [];
    const end = Math.min(lines.length - 1, start + LYR_WINDOW * 2);
    for (let i = start; i <= end; i++) {
      const d = document.createElement('div');
      d.className = 'yl-line';
      d.textContent = lines[i].x;
      if (S.bilingual && lineTrans[i]) {
        d.classList.add('has-sub');
        const sub = document.createElement('div');
        sub.className = 'yl-sub';
        sub.textContent = lineTrans[i];
        d.appendChild(sub);
      }
      const idx = i;
      d.addEventListener('click', (e) => { e.stopPropagation(); seekToLyric(idx); });
      ylTrack.appendChild(d);
      lyrEls.push(d);
    }
    lyrWinStart = start;
    lastDomIdx = -999;
    // 长句自动换行: 渲染后实测每行高度, 供滚动定位使用
    lyrHeights = lyrEls.map((el) => el.offsetHeight || LYR_LINE_H);
  }

  function seekToLyric(idx) {
    if (S.duration <= 0 || !S.hasSession) return;
    const lines = S.lyrics || [];
    if (!lines[idx]) return;
    api.command('seek', lines[idx].t);
    S.position = lines[idx].t;
    S.updatedAt = performance.now();
    S.seekGraceUntil = performance.now() + 1500;
    curLineIdx = idx - 1;
    lyricSmoothPos = null; // seek 后直接吸附到目标位置
    lastLyrCheck = 0; // 立即重新定位
    lastDl = '\u0000'; // 强制刷新桌面歌词
  }

  function updateLyricUI(now) {
    const lines = S.lyrics || [];
    const key = S.lyricKey + ':' + lines.length;
    if (key !== lyricsBuiltKey) buildLyricsDom(lines);

    if (!lines.length) {
      if (lastDl !== '') { lastDl = ''; api.desktopLine(''); }
      return;
    }

    // 节流 45ms: 快节奏歌曲句间隔短, 保证边界采样密度
    if (now - lastLyrCheck < 45) return;
    lastLyrCheck = now;

    // 歌词同步补偿: posAge 已并入位置基准(onStateImpl), 此处仅需
    // 管道传输延迟(~0.3s)。EMA 滤波消除桥接帧锯齿, 大跳变直接吸附。
    // k=0.45@45ms → 收敛约 120ms, 不拖慢快歌切句
    const target = currentPos() + (isPlaying() ? 0.34 : 0);
    if (lyricSmoothPos === null || Math.abs(target - lyricSmoothPos) > 2.5) {
      lyricSmoothPos = target;
    } else {
      lyricSmoothPos += (target - lyricSmoothPos) * 0.45;
    }
    const pos = lyricSmoothPos;

    // 局部探测当前行(避免每帧全量扫描)
    // 迟滞防抖: 桥接帧会造成位置锯齿回落, 小幅跌破当前句起点不回退,
    // 只有真实向后 seek(跌破超过 1.2s)才允许往回找, 否则本句/上一句会来回横跳
    // 前进方向附加 60ms 预切量: 歌手开口前高亮先行, 观感更跟手
    const HYST = 1.2;
    const PRE = isPlaying() ? 0.06 : 0;
    let idx = curLineIdx < 0 ? 0 : Math.min(curLineIdx, lines.length - 1);
    if (pos < lines[idx].t - HYST) {
      // 真实回退
      while (idx > 0 && pos < lines[idx].t) idx--;
    } else {
      // 前进不受迟滞限制 + 预切量; 小幅回落保持在当前句
      while (idx + 1 < lines.length && pos + PRE >= lines[idx + 1].t) idx++;
    }
    curLineIdx = idx;

    // DOM 更新仅在展开面板可见时进行
    if (curState() === 'expanded' || curState() === 'favlist') {
      ensureLyrWindow(lines, idx);
      if (idx !== lastDomIdx) {
        // 平移量按实测累计行高计算(长句换行/双语副行更高), 当前行垂直居中;
        // 合成层文字模糊对策: 平移对齐物理像素网格 (高 DPI 缩放下小数偏移会被插值拉糊)
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const snap = (v) => Math.round(v * dpr) / dpr;
        const hAt = (k) => lyrHeights[k - lyrWinStart] || rowH(k);
        let cum = 0;
        for (let k = lyrWinStart; k < idx; k++) cum += hAt(k);
        const targetY = snap(-(cum + hAt(idx) / 2));
        const delta = Math.abs(targetY - lyrLastY);
        if (delta > LYR_LINE_H * 2.5) {
          // 大跳变(seek/换歌): 关闭过渡瞬移
          ylTrack.style.transition = 'none';
          ylTrack.style.transform = 'translateY(' + targetY + 'px)';
          void ylTrack.offsetHeight; // 强制应用
          ylTrack.style.transition = '';
        } else {
          ylTrack.style.transform = 'translateY(' + targetY + 'px)';
        }
        lyrLastY = targetY;
        const prev = lyrEls[lastDomIdx - lyrWinStart];
        if (prev && prev.classList) prev.classList.remove('on');
        const el = lyrEls[idx - lyrWinStart];
        if (el) el.classList.add('on');
        lastDomIdx = idx;
      }
    } else if (lastDomIdx !== -999) {
      lastDomIdx = -999; // 收起后标记, 下次展开强制刷新高亮
    }

    // 桌面歌词: 双层结构(原文字幕在上, 译文在下), 分开推送
    const text = lines[idx] ? lines[idx].x : '';
    const sub = (text && S.bilingual && lineTrans[idx]) ? lineTrans[idx] : '';
    const sig = text + '\u0001' + sub;
    if (sig !== lastDl) {
      lastDl = sig;
      api.desktopLine({ x: text, s: sub });
    }
  }

  // 进度条拖动
  function posFromEvent(e) {
    const r = pBar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return ratio * S.duration;
  }

  function setDragUI(pos) {
    if (S.duration <= 0) return;
    applyPct((Math.min(100, Math.max(0, (pos / S.duration) * 100))));
    const c = fmt(pos);
    if (c !== uiCur) { uiCur = c; tCur.textContent = c; }
  }

  pBar.addEventListener('pointerdown', (e) => {
    // 拖动门槛只看时长: 部分播放器(QQ/网易云)的 canSeek 能力标志误报 false,
    // 但 TryChangePlaybackPositionAsync 实际可用, 拒绝拖动反而是错的
    if (S.duration <= 0 || !S.hasSession) return;
    e.preventDefault();
    dragging = true;
    api.setDragging(true); // 拖动期间主进程保持展开
    dragPos = posFromEvent(e);
    pBar.classList.add('dragging');
    pBar.setPointerCapture(e.pointerId);
    setDragUI(dragPos);
  });

  pBar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragPos = posFromEvent(e);
    setDragUI(dragPos);
  });

  function endDrag(e, commit) {
    if (!dragging) return;
    dragging = false;
    api.setDragging(false);
    pBar.classList.remove('dragging');
    if (commit) {
      api.command('seek', dragPos);
      // 乐观定位: 无时间轴播放器(网易云)不会回报 seek 后的位置, 本地时钟
      // 从落点继续; 有时间轴的播放器会被桥接帧校正(宽限期内忽略回跳帧)
      S.position = dragPos;
      S.updatedAt = performance.now();
      S.seekGraceUntil = performance.now() + 1500;
      lyricSmoothPos = null;
      lastDl = '\u0000'; // 强制刷新桌面歌词
    }
  }

  pBar.addEventListener('pointerup', (e) => endDrag(e, true));
  pBar.addEventListener('pointercancel', (e) => endDrag(e, true));

  // ---------------------------------------------------------------- 悬停
  // 悬停检测由主进程光标轮询完成, 这里只响应结果
  api.onHover((inside) => {
    if (favOpen) return; // 面板打开时完全忽略悬停变化
    hovered = inside;
    if (inside) {
      setState(expandState());
    } else {
      const n = performance.now();
      setState(n < volActiveUntil ? 'volume' : (n < notifyUntil ? 'notify' : autoState()));
    }
  });

  // ---------------------------------------------------------------- 收藏面板
  function buildFav() {
    const es = favEntries();
    flCount.textContent = es.length + ' 首';
    flList.innerHTML = '';
    if (!es.length) {
      const d = document.createElement('div');
      d.className = 'fl-empty';
      d.innerHTML = '暂无收藏<br>悬停展开后，点击封面右上角的 ♥ 收藏当前歌曲';
      flList.appendChild(d);
      return;
    }
    for (const en of es) {
      const row = document.createElement('div');
      row.className = 'fl-row';
      const t = document.createElement('span');
      t.className = 'fl-t';
      t.textContent = en.t;
      const a = document.createElement('span');
      a.className = 'fl-a';
      a.textContent = en.a;
      const x = document.createElement('span');
      x.className = 'fl-x';
      x.textContent = '×';
      x.title = '删除';
      x.onclick = (ev) => {
        ev.stopPropagation();
        try { localStorage.removeItem(en.k); } catch { }
        buildFav();
        render();
      };
      row.appendChild(t); row.appendChild(a); row.appendChild(x);
      flList.appendChild(row);
    }
  }
  let favOpen = false;
  function openFav() {
    buildFav();
    // 同纠错面板: 钉住悬停防塌缩
    favOpen = true;
    api.setDragging(true);
    setState('favlist');
  }
  eSource.addEventListener('click', (e) => { e.stopPropagation(); openFav(); });
  flBack.addEventListener('click', (e) => {
    e.stopPropagation();
    favOpen = false;
    api.setDragging(false);
    setState(hovered ? expandState() : autoState());
  });

  // ---------------------------------------------------------------- 歌词纠错(独立窗口)
  const openLyricFix = () => { if (S.hasSession && S.title && api.lyrFixOpen) api.lyrFixOpen({ title: S.title, artist: S.artist, duration: S.duration }); };
  const btnLyrFix = $('btnLyrFix');
  btnLyrFix.addEventListener('click', (e) => { e.stopPropagation(); openLyricFix(); });
  eLyrics.addEventListener('contextmenu', (e) => { e.preventDefault(); openLyricFix(); });

  // ---------------------------------------------------------------- 毛玻璃 / 双语字幕 / 字号
  api.onGlass((g) => document.body.classList.toggle('glass', !!g));
  api.onBilingual((b) => {
    S.bilingual = !!b;
    // 行高结构可能变化, 强制重建歌词 DOM
    lyricsBuiltKey = '';
    lyrWinStart = -1;
    lastDomIdx = -999;
  });
  api.onLyrSize((v) => {
    S.lyrSize = Number(v) || 12.5;
    applyLyrSize();
    lyricsBuiltKey = '';
    lyrWinStart = -1;
    lastDomIdx = -999;
  });
  // 音源/策略变化: 丢弃当前歌词, 下一帧按新配置重新获取
  api.onLyricsRefetch(() => {
    S.lyricKey = '';
    S.lyrics = null;
    S.trans = [];
    curLineIdx = -1;
  });

  // ---------------------------------------------------------------- 控制
  btnToggle.addEventListener('click', () => {
    if (btnToggle.disabled) return;
    api.command('toggle');
    // 乐观切换图标, 下一帧状态校正
    S.status = isPlaying() ? 'Paused' : 'Playing';
    render();
  });

  btnPrev.addEventListener('click', () => {
    if (btnPrev.disabled) return;
    api.command('prev');
  });

  btnNext.addEventListener('click', () => {
    if (btnNext.disabled) return;
    api.command('next');
  });

  btnShuffle.addEventListener('click', () => {
    api.command('shuffle');
  });

  btnRepeat.addEventListener('click', () => {
    api.command('repeat');
  });

  btnFav.addEventListener('click', () => {
    toggleFav();
  });

  // ---------------------------------------------------------------- 弹跳
  function triggerBounce() {
    island.classList.remove('bounce');
    void island.offsetWidth; // 强制 reflow 以重启动画
    island.classList.add('bounce');
  }

  // ---------------------------------------------------------------- 启动
  api.onState((st) => {
    try { onStateImpl(st); }
    catch (err) { console.error('[island] state error:', err && err.stack || err); }
  });

  setState('idle');
  applyLyrSize();
  tick();
})();
