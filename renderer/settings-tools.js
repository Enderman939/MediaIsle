(() => {
  'use strict';
  const api = window.island;
  const $ = (id) => document.getElementById(id);
  const sourceNames = { soda: '汽水本地缓存', netease: '网易云', qq: 'QQ 音乐', kugou: '酷狗' };
  const actionNames = { toggle: '播放 / 暂停', prev: '上一首', next: '下一首', desktopLyrics: '桌面歌词', favorite: '收藏当前歌曲' };
  const stateNames = { loading: '请求中', hit: '已命中', empty: '未匹配', error: '请求失败', timeout: '请求超时', idle: '尚未请求' };
  const shortcutNames = { registered: '已启用', disabled: '已禁用', conflict: '被占用' };
  const stages = ['download', 'verify', 'extract', 'restart'];
  const stageTitles = { checking: '正在检查更新', download: '正在下载更新', verify: '正在校验文件', extract: '正在解压更新', restart: '正在重启 MediaIsle' };
  let diagnosticBusy = false;
  let offsetKey = '';
  let offsetTrack = null;
  let offsetDirty = false;
  let shortcutsBuilt = false;
  let refreshId = 0;
  let updateFrame = null;
  const offsetText = (n) => (n > 0 ? '+' : '') + Number(n).toFixed(1) + ' 秒';

  function listText(container, items) {
    container.replaceChildren(...items.map((text) => { const li = document.createElement('li'); li.textContent = text; return li; }));
  }

  function diagnosticRows(id, rows) {
    const box = $(id);
    const signature = JSON.stringify(rows);
    if (box.dataset.signature === signature) return;
    box.dataset.signature = signature;
    box.replaceChildren(...rows.map(([name, value, state = '']) => {
      const row = document.createElement('div'); row.className = 'diag-row';
      const label = document.createElement('span'); label.textContent = name;
      const result = document.createElement('span'); result.className = 'diag-value ' + state; result.textContent = String(value ?? '');
      row.append(label, result); return row;
    }));
  }

  function buildShortcuts(shortcuts) {
    if (shortcutsBuilt) return;
    shortcutsBuilt = true;
    $('diagShortcuts').replaceChildren(...Object.entries(shortcuts).map(([action, item]) => {
      const row = document.createElement('div'); row.className = 'shortcut-row';
      const label = document.createElement('label'); label.htmlFor = 'shortcut-' + action; label.textContent = actionNames[action] || action;
      const input = document.createElement('input'); input.id = label.htmlFor; input.value = item.accelerator; input.placeholder = '未设置'; input.spellcheck = false;
      const status = document.createElement('span'); status.className = 'shortcut-status'; status.textContent = shortcutNames[item.state];
      const save = document.createElement('button'); save.className = 'md3-btn md3-btn--tonal'; save.textContent = '保存';
      save.onclick = async () => {
        save.disabled = true;
        try {
          const result = await api.shortcutSet(action, input.value);
          if (!result.ok) throw new Error(result.message);
          const item = result.shortcuts[action]; input.value = item.accelerator; status.textContent = shortcutNames[item.state];
          $('diagnosticFeedback').textContent = actionNames[action] + '快捷键已保存';
        } catch (e) { $('diagnosticFeedback').textContent = e.message; }
        finally { save.disabled = false; }
      };
      row.append(label, input, status, save); return row;
    }));
  }

  async function refreshDiagnostics() {
    if (diagnosticBusy) return;
    diagnosticBusy = true;
    try {
      const d = await api.diagnosticsGet();
      const m = d.media;
      diagnosticRows('diagBridge', [
        ['连接状态', d.bridge.connected ? '已连接' : '未就绪', d.bridge.connected ? 'hit' : 'empty'],
        ['自动重连', d.bridge.restarts + ' 次'], ['最近错误', d.bridge.error || '无'],
      ]);
      diagnosticRows('diagMedia', m?.hasSession ? [
        ['播放器', m.source || m.appId], ['曲目', m.title], ['歌手', m.artist || '未提供'], ['播放状态', m.status],
        ['播放 / 暂停', `${m.canPlay ? '支持' : '未报告'} / ${m.canPause ? '支持' : '未报告'}`],
        ['上一首 / 下一首', `${m.canPrev ? '支持' : '未报告'} / ${m.canNext ? '支持' : '未报告'}`],
        ['进度跳转', m.canSeek ? '支持' : '播放器未报告能力'],
        ['状态帧年龄', Math.max(0, (Date.now() - m.receivedAt) / 1000).toFixed(1) + ' 秒'],
      ] : [['媒体会话', '未检测到正在使用的播放器']]);
      const q = d.lyric.request;
      const rows = [['策略', d.lyric.strategy === 'race' ? '竞速' : '质量'], ['当前来源', (q.selected || '暂无') + (q.cache ? ' · 缓存' : '')]];
      for (const id of Object.keys(sourceNames)) {
        const result = q.sources[id];
        const enabled = d.lyric.enabled.includes(id);
        const state = result?.state || 'idle';
        let value = enabled ? stateNames[state] : '未启用';
        if (result) value += ` · ${result.elapsedMs} ms` + (result.lines ? ` · ${result.lines} 行` : '') + (result.relaxed ? ' · 宽松' : '') + (result.error ? ` · ${result.error}` : '');
        rows.push([sourceNames[id], value, state]);
      }
      diagnosticRows('diagLyric', rows);
      const key = m?.hasSession ? JSON.stringify([m.title, m.artist]) : '';
      if (key !== offsetKey || !offsetDirty) {
        offsetKey = key; offsetTrack = key ? { title: m.title, artist: m.artist } : null;
        $('offsetTrack').textContent = key ? `${m.title} · ${m.artist || '未知歌手'}` : '当前没有曲目';
        $('trackOffset').value = d.lyric.offset;
        $('trackOffsetValue').textContent = offsetText(d.lyric.offset) + (d.lyric.savedOffset !== null ? ' · 单曲' : ' · 全局');
        offsetDirty = false;
      }
      for (const id of ['trackOffset', 'btnOffsetSave', 'btnOffsetReset']) $(id).disabled = !key;
      buildShortcuts(d.shortcuts);
      $('diagUpdated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    } catch (e) { $('diagnosticFeedback').textContent = e.message; }
    finally { diagnosticBusy = false; }
  }

  $('trackOffset').oninput = () => { offsetDirty = true; $('trackOffsetValue').textContent = offsetText($('trackOffset').value); };
  for (const [id, reset] of [['btnOffsetSave', false], ['btnOffsetReset', true]]) {
    $(id).onclick = async () => {
      if (!offsetTrack) return;
      try {
        await api.trackOffsetSet({ ...offsetTrack, value: reset ? null : Number($('trackOffset').value) });
        offsetDirty = false;
        $('diagnosticFeedback').textContent = reset ? '当前歌曲已跟随全局偏移' : '当前歌曲偏移已保存';
        await refreshDiagnostics();
      } catch (e) { $('diagnosticFeedback').textContent = e.message; }
    };
  }
  $('btnDiagRefresh').onclick = refreshDiagnostics;
  $('btnLyricsRetry').onclick = async () => { await api.diagnosticsRetry(); $('diagnosticFeedback').textContent = '已重新请求当前歌曲歌词'; };
  $('btnBridgeReconnect').onclick = async () => { await api.bridgeReconnect(); $('diagnosticFeedback').textContent = '正在重新连接媒体桥接'; };
  window.addEventListener('settings-page', (e) => { if (e.detail === 'diagnostics') refreshDiagnostics(); });
  const diagnosticTimer = setInterval(() => {
    if (!document.hidden && $('page-diagnostics').classList.contains('active')) refreshDiagnostics();
  }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(diagnosticTimer));

  const mb = (bytes) => ((bytes || 0) / 1048576).toFixed(1) + ' MB';
  function renderUpdate(st) {
    if (st.platform && st.platform !== 'win32') {
      $('btnRecheck').hidden = true;
      $('btnUpdate').hidden = true;
      $('updProg').hidden = true;
      $('updTitle').textContent = '当前平台暂不支持应用内更新';
      $('updSub').textContent = '请前往 GitHub Releases 页面下载最新版本';
      return;
    }
    const busy = !!st.busy;
    const index = stages.indexOf(st.stage);
    $('updatePanel').dataset.stage = st.stage;
    $('btnRecheck').disabled = busy || st.stage === 'checking';
    $('btnRecheck').hidden = !st.packaged;
    $('btnUpdate').disabled = busy;
    $('btnUpdate').hidden = !st.packaged || (!st.available && !busy);
    $('btnUpdate').textContent = busy ? '更新中' : st.stage === 'error' ? '重试更新' : '下载并更新';
    $('updProg').hidden = index < 0;
    $('updTitle').textContent = stageTitles[st.stage] || (st.stage === 'error' ? '安装更新失败' : st.stage === 'check-error' ? '无法检查更新' : !st.packaged ? '开发版本' : st.available ? '发现新版本 ' + st.available.version : '已是最新版本');
    $('updSub').textContent = st.message || (st.stage === 'restart' ? '安装完成后自动返回设置页面' : `当前 v${st.version}` + (st.available ? ` → v${st.available.version}` : ''));
    const prog = st.prog || {};
    const percent = Math.max(0, Math.min(100, prog.percent || 0));
    const indeterminate = st.stage !== 'download' || !prog.total;
    $('updBar').classList.toggle('indeterminate', indeterminate);
    $('updFill').style.width = indeterminate ? '35%' : percent + '%';
    if (indeterminate) $('updBar').removeAttribute('aria-valuenow');
    else $('updBar').setAttribute('aria-valuenow', Math.round(percent));
    $('updTxt').textContent = st.stage === 'download' ? `${mb(prog.received)}${prog.total ? ' / ' + mb(prog.total) + ' · ' + percent.toFixed(1) + '%' : ''} · ${mb(prog.speed)}/s` : st.stage === 'verify' ? 'SHA256 完整性校验' : st.stage === 'extract' ? '准备安装文件' : '正在切换至更新安装窗口';
    document.querySelectorAll('#updateSteps li').forEach((li, i) => { li.classList.toggle('done', i < index); li.classList.toggle('active', i === index); });
    if (st.notes) {
      $('releaseTitle').textContent = `v${st.notes.version} 更新内容`;
      listText($('releaseChanges'), st.notes.changes || []);
    }
  }

  async function refreshUpdate(force = false) {
    const id = ++refreshId;
    try {
      if (force) { $('btnRecheck').disabled = true; $('updTitle').textContent = '正在检查更新'; }
      const state = await api.updateGet(force);
      if (id === refreshId) renderUpdate(state);
    } catch (e) { $('updTitle').textContent = '更新状态读取失败'; $('updSub').textContent = e.message; $('btnRecheck').disabled = false; }
  }
  api.onUpdateStatus(() => {
    if (updateFrame !== null) return;
    updateFrame = requestAnimationFrame(() => { updateFrame = null; refreshUpdate(); });
  });
  $('btnRecheck').onclick = () => refreshUpdate(true);
  $('btnUpdate').onclick = async () => {
    $('btnUpdate').disabled = true;
    try { await api.updateApply(); } catch (e) { $('updSub').textContent = e.message; }
    await refreshUpdate();
  };
  $('btnDismissNotice').onclick = async () => { await api.updateNoticeAck(); $('updateNotice').hidden = true; };
  api.updateNoticeGet().then((notice) => {
    if (!notice?.completed) return;
    $('updateNoticeTitle').textContent = `已更新至 v${notice.to}`;
    $('updateNoticeBody').textContent = notice.from ? `v${notice.from} → v${notice.to}` : `MediaIsle v${notice.to}`;
    listText($('updateNoticeList'), notice.notes || []);
    $('updateNotice').hidden = false;
    document.querySelector('[data-page="general"]').click();
    $('page-general').scrollTop = 0;
  }).catch((e) => console.error('[update:notice]', e));
  refreshUpdate(true);
})();
