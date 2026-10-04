'use strict';

const FORMATS = ['txt', 'md', 'lrc'];
const LANGUAGES = ['original', 'chinese', 'english', 'bilingual'];

function exportPreferences(value = {}) {
  return {
    format: FORMATS.includes(value?.format) ? value.format : 'txt',
    language: LANGUAGES.includes(value?.language) ? value.language : 'bilingual',
    directory: typeof value?.directory === 'string' ? value.directory : '',
  };
}

// Validate every row so a typo cannot silently discard a user's edited line.
function validateLyrics(value) {
  function rows(list, label) {
    if (!Array.isArray(list) || list.length > 10000) throw new Error(label + '行数无效');
    return list.map((row, i) => {
      if (!row || typeof row.t !== 'number' || !Number.isFinite(row.t) || row.t < 0 || row.t > 86400)
        throw new Error(label + '第 ' + (i + 1) + ' 句时间须为 0–86400 秒');
      if (typeof row.x !== 'string' || !row.x.trim() || row.x.length > 5000 || /[\r\n\u0000]/.test(row.x))
        throw new Error(label + '第 ' + (i + 1) + ' 句须填写单行文本');
      return { t: row.t, x: row.x.trim() };
    }).sort((a, b) => a.t - b.t);
  }
  const lines = rows(value?.lines, '原文');
  if (!lines.length) throw new Error('至少保留一句原文');
  return { lines, trans: rows(value?.trans || [], '译文'), src: '自定义版本', dur: typeof value?.dur === 'number' && Number.isFinite(value.dur) && value.dur > 0 && value.dur <= 86400 ? value.dur : 0 };
}

function batchTracks(value) {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error('请选择 1–500 首收藏歌曲');
  const seen = new Set();
  return value.map((track) => {
    if (!track || typeof track.title !== 'string' || !track.title.trim()) throw new Error('收藏曲目缺少歌名');
    return { title: track.title.trim(), artist: typeof track.artist === 'string' ? track.artist.trim() : '', duration: Number(track.duration) || 0 };
  }).filter((track) => {
    const key = JSON.stringify([track.title.toLowerCase(), track.artist.toLowerCase()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { exportPreferences, validateLyrics, batchTracks };
