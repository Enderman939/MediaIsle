(() => {
  'use strict';
  const api = window.island;
  const $ = (id) => document.getElementById(id);
  let context = null;
  let contextVersion = 0;
  let previewVersion = 0;
  let saving = false;
  let previewReady = false;
  const hints = { chinese: '仅中文歌词或译文', english: '仅英文歌词或译文', bilingual: '原文与译文逐句排列', original: '保留歌曲原有语言' };
  const unavailable = { chinese: '当前版本暂无中文', english: '当前版本暂无英文', bilingual: '当前版本暂无可对齐译文', original: '当前版本暂无歌词' };
  const format = () => document.querySelector('input[name="format"]:checked').value;
  const language = () => document.querySelector('input[name="language"]:checked')?.value;
  function feedback(text, error = false) { $('downloadFeedback').textContent = text; $('downloadFeedback').dataset.error = String(error); }
  function syncControls() {
    $('formatChoices').disabled = saving || !context;
    $('languageChoices').disabled = saving || !context;
    $('btnSave').disabled = saving || !context || !previewReady;
    $('btnCancel').disabled = saving;
  }
  async function refreshPreview() {
    const version = ++previewVersion;
    const contextId = context?.id;
    previewReady = false;
    syncControls();
    if (!contextId || !language()) return;
    feedback('正在生成预览…');
    try {
      const result = await api.lyricsDownloadPreview({ contextId, format: format(), language: language() });
      if (version !== previewVersion || contextId !== context?.id) return;
      if (!result.ok) throw new Error(result.message || '无法生成预览');
      $('previewFilename').textContent = result.filename;
      $('previewContent').textContent = result.content;
      $('previewCount').textContent = result.lines + ' 句';
      previewReady = true;
      feedback('预览已就绪，点击保存选择文件位置。');
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
      $('songTitle').textContent = result.title;
      $('songArtist').textContent = result.artist || '未知歌手';
      $('songSource').textContent = [result.source, result.originalLines + ' 句原文', result.translatedLines ? result.translatedLines + ' 句译文' : '暂无可对齐译文'].filter(Boolean).join(' · ');
      const current = language();
      const next = result.languages.includes(current) ? current : result.languages.includes('bilingual') ? 'bilingual' : 'original';
      document.querySelectorAll('input[name="language"]').forEach((input) => {
        input.disabled = !result.languages.includes(input.value);
        input.checked = input.value === next;
        $('hint-' + input.value).textContent = input.disabled ? unavailable[input.value] : hints[input.value];
      });
      syncControls();
      await refreshPreview();
    } catch (error) {
      if (version !== contextVersion) return;
      $('songTitle').textContent = '暂时无法下载';
      $('previewContent').textContent = '获取歌词后可在这里预览文件内容';
      feedback(error.message, true);
      syncControls();
    }
  }
  for (const id of ['formatChoices', 'languageChoices']) $(id).addEventListener('change', refreshPreview);
  $('btnSave').addEventListener('click', async () => {
    if ($('btnSave').disabled) return;
    const request = { contextId: context.id, format: format(), language: language() };
    saving = true;
    syncControls();
    feedback('请选择保存位置…');
    try {
      const result = await api.downloadLyrics(request);
      feedback(result.ok ? '已保存：' + result.path : result.canceled ? '已取消保存，可以继续选择格式和语言。' : result.message || '保存失败', !result.ok && !result.canceled);
    } catch (error) { feedback(error.message, true); }
    finally { saving = false; syncControls(); }
  });
  $('btnMin').onclick = () => api.winCtrl('minimize');
  for (const id of ['btnClose', 'btnCancel']) $(id).onclick = () => window.close();
  api.onLyricsDownloadChanged(loadContext);
  loadContext();
})();
