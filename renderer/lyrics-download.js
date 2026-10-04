(() => {
  'use strict';
  const api = window.island;
  const $ = (id) => document.getElementById(id);
  let context = null;
  let contextVersion = 0;
  let previewVersion = 0;
  let saving = false;
  let previewReady = false;
  let draft = null;
  let dirty = false;
  let editing = false;
  let editTimer;
  const isBatch = () => context?.mode === 'batch';
  const hints = { chinese: '仅中文歌词或译文', english: '仅英文歌词或译文', bilingual: '原文与译文逐句排列', original: '保留歌曲原有语言' };
  const unavailable = { chinese: '当前版本暂无中文', english: '当前版本暂无英文', bilingual: '当前版本暂无可对齐译文', original: '当前版本暂无歌词' };
  const format = () => document.querySelector('input[name="format"]:checked').value;
  const language = () => document.querySelector('input[name="language"]:checked')?.value;
  function feedback(text, error = false) { $('downloadFeedback').textContent = text; $('downloadFeedback').dataset.error = String(error); }
  function syncControls() {
    $('formatChoices').disabled = saving || !context;
    $('languageChoices').disabled = saving || !context;
    $('btnSave').disabled = saving || !context || (isBatch() ? !document.querySelector('#batchTracks input:checked') : !previewReady || dirty);
    $('btnCancel').disabled = saving;
    $('btnClose').disabled = saving;
    $('btnStopBatch').hidden = !saving || !isBatch();
    for (const id of ['btnEdit', 'btnSaveCustom', 'btnResetCustom', 'btnRevert', 'btnAddLine', 'btnAddTrans', 'btnSelectAll']) $(id).disabled = saving || !context;
    document.querySelectorAll('#editorPanel input, #editorPanel .editor-row button, #batchTracks input').forEach((input) => { input.disabled = saving; });
  }
  async function refreshPreview() {
    const version = ++previewVersion;
    const contextId = context?.id;
    previewReady = false;
    syncControls();
    if (isBatch()) { previewReady = true; syncControls(); return; }
    if (!contextId || !language()) return;
    feedback('正在生成预览…');
    try {
      const result = await api.lyricsDownloadPreview({ contextId, format: format(), language: language(), ...(editing ? { draft } : {}) });
      if (version !== previewVersion || contextId !== context?.id) return;
      if (result.languages?.length) {
        const current = language();
        const next = result.languages.includes(current) ? current : result.languages.includes('bilingual') ? 'bilingual' : 'original';
        document.querySelectorAll('input[name="language"]').forEach((input) => {
          input.disabled = !result.languages.includes(input.value); input.checked = input.value === next;
          $('hint-' + input.value).textContent = input.disabled ? unavailable[input.value] : hints[input.value];
        });
        if (next !== current) { await refreshPreview(); return; }
      }
      if (!result.ok) throw new Error(result.message || '无法生成预览');
      $('previewFilename').textContent = result.filename;
      $('previewContent').textContent = result.content;
      $('previewCount').textContent = result.lines + ' 句';
      previewReady = true;
      feedback(dirty ? '修改预览已就绪，请先保存自定义版本再下载。' : '预览已就绪，点击保存选择文件位置。');
    } catch (error) {
      if (version !== previewVersion || contextId !== context?.id) return;
      $('previewContent').textContent = '无法预览当前选项';
      feedback(error.message, true);
    } finally { if (version === previewVersion) syncControls(); }
  }
  async function loadContext() {
    const version = ++contextVersion;
    previewVersion++;
    context = null;
    dirty = false;
    editing = false;
    clearTimeout(editTimer);
    $('editorPanel').hidden = true;
    $('btnEdit').setAttribute('aria-expanded', 'false');
    $('btnEdit').textContent = '编辑歌词';
    $('editorFeedback').textContent = '';
    previewReady = false;
    syncControls();
    $('songTitle').textContent = '正在准备歌词…';
    $('songArtist').textContent = '';
    $('songSource').textContent = '打开后保留此曲目的歌词版本';
    $('previewFilename').textContent = '选择格式和语言后预览';
    $('previewCount').textContent = '';
    $('previewContent').textContent = '正在加载…';
    feedback('正在获取歌词…');
    try {
      const result = await api.lyricsDownloadContext();
      if (version !== contextVersion || result.stale) return;
      if (!result.ok) throw new Error(result.message || '无法加载歌词');
      context = result;
      const preferences = result.preferences;
      if (preferences) document.querySelectorAll('input[name="format"]').forEach((input) => { input.checked = input.value === preferences.format; });
      $('batchPanel').hidden = !isBatch();
      for (const id of ['singleActions', 'previewCard', 'singleNote']) $(id).hidden = isBatch();
      $('saveLabel').textContent = isBatch() ? '导出所选歌曲' : '保存歌词';
      if (isBatch()) {
        $('songTitle').textContent = '收藏歌词批量导出';
        $('songArtist').textContent = result.tracks.length + ' 首收藏歌曲';
        $('songSource').textContent = '选择歌曲、格式和语言，再选择一个保存文件夹';
        $('batchTracks').replaceChildren();
        $('batchResults').replaceChildren();
        $('batchSummary').textContent = '';
        $('batchProgress').hidden = true;
        result.tracks.forEach((track, index) => {
          const label = document.createElement('label'); label.className = 'batch-track';
          const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.value = index; check.onchange = syncControls;
          const text = document.createElement('span'); text.textContent = track.title;
          const artist = document.createElement('small'); artist.textContent = track.artist || '未知歌手'; text.appendChild(artist);
          label.append(check, text); $('batchTracks').appendChild(label);
        });
      } else {
      $('songTitle').textContent = result.title;
      $('songArtist').textContent = result.artist || '未知歌手';
      $('songSource').textContent = [result.source, result.originalLines + ' 句原文', result.translatedLines ? result.translatedLines + ' 句译文' : '暂无可对齐译文'].filter(Boolean).join(' · ');
      draft = structuredClone(result.lyrics);
      $('btnResetCustom').hidden = !result.custom;
      }
      const languages = isBatch() ? ['original', 'chinese', 'english', 'bilingual'] : result.languages;
      const current = preferences?.language || language();
      const next = languages.includes(current) ? current : languages.includes('bilingual') ? 'bilingual' : 'original';
      document.querySelectorAll('input[name="language"]').forEach((input) => {
        input.disabled = !languages.includes(input.value);
        input.checked = input.value === next;
        $('hint-' + input.value).textContent = input.disabled ? unavailable[input.value] : hints[input.value];
      });
      syncControls();
      await refreshPreview();
      if (isBatch()) feedback('勾选要导出的歌曲，点击导出选择保存文件夹。');
    } catch (error) {
      if (version !== contextVersion) return;
      $('songTitle').textContent = '暂时无法下载';
      $('previewContent').textContent = '获取歌词后可在这里预览文件内容';
      feedback(error.message, true);
      syncControls();
    }
  }
  for (const id of ['formatChoices', 'languageChoices']) $(id).addEventListener('change', () => {
    api.lyricsExportPreferences({ format: format(), language: language() });
    refreshPreview();
  });
  $('btnSave').addEventListener('click', async () => {
    if ($('btnSave').disabled) return;
    const request = { contextId: context.id, format: format(), language: language() };
    saving = true;
    $('btnStopBatch').disabled = false;
    syncControls();
    feedback('请选择保存位置…');
    try {
      if (isBatch()) {
        const tracks = [...document.querySelectorAll('#batchTracks input:checked')].map((input) => context.tracks[Number(input.value)]);
        const result = await api.lyricsBatchExport({ ...request, tracks });
        if (result.ok) { showProgress({ ...result, running: false }); feedback(result.canceled ? '已停止，已导出的文件保留。' : '批量导出完成：' + result.directory); }
        else feedback(result.canceled ? '已取消选择文件夹。' : result.message || '导出失败', !result.canceled);
        return;
      }
      const result = await api.downloadLyrics(request);
      feedback(result.ok ? '已保存：' + result.path : result.canceled ? '已取消保存，可以继续选择格式和语言。' : result.message || '保存失败', !result.ok && !result.canceled);
    } catch (error) { feedback(error.message, true); }
    finally { saving = false; syncControls(); }
  });
  function changed() {
    dirty = true;
    api.lyricsEditorDirty({ contextId: context.id, dirty: true });
    $('editorFeedback').textContent = '有未保存的修改';
    previewReady = false;
    syncControls();
    clearTimeout(editTimer);
    editTimer = setTimeout(refreshPreview, 180);
  }
  function renderEditor() {
    for (const [type, id, label] of [['lines', 'editorLines', '原文'], ['trans', 'editorTrans', '译文']]) {
      $(id).replaceChildren();
      draft[type].forEach((line, index) => {
        let alignedTime = line.t;
        const row = document.createElement('div'); row.className = 'editor-row';
        const time = document.createElement('input'); time.type = 'number'; time.min = '0'; time.max = '86400'; time.step = '0.01'; time.value = line.t; time.setAttribute('aria-label', label + '第 ' + (index + 1) + ' 句时间（秒）');
        time.oninput = () => {
          const previous = alignedTime; const next = time.value === '' ? NaN : Number(time.value);
          if (type === 'lines' && Number.isFinite(next)) {
            draft.trans.forEach((tr) => { if (Math.abs(tr.t - previous) <= 0.0500001) tr.t = next; });
            // Updating only translation time inputs preserves focus and the original's in-progress text.
            document.querySelectorAll('#editorTrans input[type="number"]').forEach((input, i) => { input.value = draft.trans[i].t; });
          }
          if (Number.isFinite(next)) alignedTime = next;
          line.t = next; changed();
        };
        const text = document.createElement('input'); text.value = line.x; text.maxLength = 5000; text.setAttribute('aria-label', label + '第 ' + (index + 1) + ' 句文本'); text.oninput = () => { line.x = text.value; changed(); };
        const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', '删除' + label + '第 ' + (index + 1) + ' 句'); remove.onclick = () => { draft[type].splice(index, 1); changed(); renderEditor(); };
        row.append(time, text, remove); $(id).appendChild(row);
      });
    }
  }
  $('btnEdit').onclick = () => {
    editing = !editing;
    $('editorPanel').hidden = !editing;
    $('btnEdit').textContent = editing ? '收起编辑器' : '编辑歌词';
    $('btnEdit').setAttribute('aria-expanded', String(editing));
    if (editing) renderEditor();
    refreshPreview();
  };
  for (const [id, type] of [['btnAddLine', 'lines'], ['btnAddTrans', 'trans']]) $(id).onclick = () => {
    draft[type].push({ t: draft.lines.at(-1)?.t || 0, x: '' }); changed(); renderEditor();
    $(type === 'lines' ? 'editorLines' : 'editorTrans').lastElementChild?.querySelector('input:last-of-type')?.focus();
  };
  $('btnRevert').onclick = () => { draft = structuredClone(context.lyrics); dirty = false; api.lyricsEditorDirty({ contextId: context.id, dirty: false }); $('editorFeedback').textContent = '已撤销未保存的修改'; renderEditor(); refreshPreview(); };
  async function updateCustom(reset = false) {
    const id = context.id;
    saving = true; clearTimeout(editTimer); syncControls();
    try {
      const result = reset ? await api.lyricsCustomReset({ contextId: id }) : await api.lyricsCustomSave({ contextId: id, lyrics: draft });
      if (context?.id !== id || result.stale) return;
      if (!result.ok) throw new Error(result.message);
      context = result; draft = structuredClone(result.lyrics); dirty = false;
      $('btnResetCustom').hidden = !result.custom;
      $('songSource').textContent = result.source;
      $('editorFeedback').textContent = reset ? '已恢复在线版本' : '自定义版本已保存，将用于岛体和下载';
      renderEditor(); await refreshPreview();
    } catch (error) { $('editorFeedback').textContent = error.message; }
    finally { saving = false; syncControls(); }
  }
  $('btnSaveCustom').onclick = () => updateCustom();
  $('btnResetCustom').onclick = () => updateCustom(true);
  $('btnSelectAll').onclick = () => { const inputs = [...document.querySelectorAll('#batchTracks input')]; const next = !inputs.every((input) => input.checked); inputs.forEach((input) => { input.checked = next; }); syncControls(); };
  function showProgress(value) {
    $('batchProgress').hidden = false; $('batchProgress').max = value.total || 1; $('batchProgress').value = value.results.length;
    const successes = value.results.filter((row) => row.ok).length;
    $('batchSummary').textContent = (value.running ? '正在导出 ' : value.canceled ? '已停止 ' : '已完成 ') + value.results.length + ' / ' + value.total + ' · 成功 ' + successes + ' · 失败 ' + (value.results.length - successes);
    $('batchResults').replaceChildren();
    value.results.forEach((result) => { const row = document.createElement('div'); row.className = 'batch-result'; row.dataset.error = String(!result.ok); row.textContent = result.title + ' · ' + (result.ok ? '已保存：' + result.path : '失败：' + result.message); $('batchResults').appendChild(row); });
  }
  api.onLyricsBatchProgress(showProgress);
  $('btnStopBatch').onclick = () => { api.lyricsBatchCancel(); $('btnStopBatch').disabled = true; feedback('正在停止，当前歌词获取结束后停止导出…'); };
  $('btnMin').onclick = () => api.winCtrl('minimize');
  const blockedClose = () => feedback('有未保存的修改，请保存自定义版本或在编辑器中撤销修改后关闭。', true);
  for (const id of ['btnClose', 'btnCancel']) $(id).onclick = () => { if (dirty) blockedClose(); else window.close(); };
  api.onLyricsCloseBlocked(blockedClose);
  api.onLyricsDownloadChanged(loadContext);
  loadContext();
})();
