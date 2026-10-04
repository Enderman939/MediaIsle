'use strict';

const FORMATS = new Set(['lrc', 'txt', 'md']);
const LANGUAGES = new Set(['original', 'chinese', 'english', 'bilingual']);

function cleanText(value) {
  return String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').trim();
}

function validLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => line && typeof line.t === 'number' && Number.isFinite(line.t) && line.t >= 0 && typeof line.x === 'string' && cleanText(line.x))
    .map(({ t, x }) => ({ t, x: cleanText(x) }))
    .sort((a, b) => a.t - b.t);
}

function timestamp(seconds) {
  const cs = Math.round(seconds * 100);
  const minutes = Math.floor(cs / 6000);
  const sec = Math.floor(cs % 6000 / 100);
  return `[${String(minutes).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`;
}

function metadata(value) {
  return cleanText(value).replace(/[\[\]]/g, '');
}

function filename(title, artist, format, language = 'original') {
  let stem = [cleanText(title), cleanText(artist)].filter(Boolean).join(' - ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  stem = [...stem].slice(0, 120).join('').replace(/[. ]+$/g, '') || '歌词';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  const suffix = { chinese: '.zh', english: '.en', bilingual: '.bilingual' }[language] || '';
  return stem + suffix + '.' + format;
}

function languageOf(text) {
  const han = /\p{Script=Han}/u.test(text);
  const latin = /\p{Script=Latin}/u.test(text);
  // Kana, Hangul and other scripts must not be mistaken for Chinese or English.
  const otherLetters = /\p{L}/u.test(text.replace(/[\p{Script=Han}\p{Script=Latin}]/gu, ''));
  if (otherLetters) return '';
  return han ? 'chinese' : latin ? 'english' : '';
}

// Translation rows align by timestamp, not by list index: translated files often omit lines.
function inspectLyrics({ lines, trans }) {
  const originals = validLines(lines);
  const translations = validLines(trans);
  let j = 0;
  let aligned = 0;
  const groups = originals.map((line) => {
    const paired = [];
    while (j < translations.length && translations[j].t < line.t - 0.0500001) j++;
    while (j < translations.length && Math.abs(translations[j].t - line.t) <= 0.0500001) {
      const translation = translations[j++];
      if (translation.x !== line.x && !paired.includes(translation.x)) paired.push(translation.x);
    }
    aligned += paired.length;
    return { t: line.t, original: line.x, translations: paired };
  });
  const languages = [];
  if (originals.length) languages.push('original');
  for (const language of ['chinese', 'english']) {
    if (originals.length && [...originals, ...translations].some((line) => languageOf(line.x) === language)) languages.push(language);
  }
  if (aligned) languages.push('bilingual');
  return { originals, translations, groups, languages, aligned };
}

function escapeMarkdown(value) {
  return cleanText(value).replace(/[\\`*_{}\[\]<>()#+.!|~\-]/g, '\\$&');
}

function createExport({ title, artist, lines, trans, format = 'lrc', language = 'original' }) {
  if (!FORMATS.has(format)) throw new Error('不支持的歌词格式');
  if (!LANGUAGES.has(language)) throw new Error('不支持的歌词语言');
  const { originals, translations, groups, languages } = inspectLyrics({ lines, trans });
  if (!originals.length) throw new Error('这首歌还没有可下载的歌词，请先获取歌词或选择其他版本');
  if (!languages.includes(language)) {
    if (language === 'bilingual') throw new Error(translations.length ? '当前译文时间轴无法对齐，请选择其他语言' : '当前版本没有译文，请选择其他语言');
    throw new Error('当前版本没有' + (language === 'chinese' ? '中文' : '英文') + '歌词，请选择其他语言或更换版本');
  }

  let selected;
  let translatedRows = 0;
  if (language === 'original' || language === 'bilingual') {
    selected = groups.map((group) => {
      const paired = language === 'bilingual' ? group.translations : [];
      translatedRows += paired.length;
      return { t: group.t, texts: [group.original, ...paired] };
    });
  } else {
    const seen = new Set();
    selected = [...originals.map((line) => ({ ...line, translated: false })),
      ...translations.map((line) => ({ ...line, translated: true }))]
      .filter((line) => languageOf(line.x) === language)
      .sort((a, b) => a.t - b.t)
      .flatMap((line) => {
        const key = line.t + '|' + line.x;
        if (seen.has(key)) return [];
        seen.add(key);
        if (line.translated) translatedRows++;
        return [{ t: line.t, texts: [line.x] }];
      });
  }
  const rows = format === 'lrc' ? [`[ti:${metadata(title)}]`, `[ar:${metadata(artist)}]`, '']
    : format === 'md' ? ['# ' + escapeMarkdown(title || '歌词'), '', ...(artist ? ['歌手：' + escapeMarkdown(artist), ''] : [])]
      : [[cleanText(title), cleanText(artist)].filter(Boolean).join(' — '), ''];
  for (const group of selected) {
    const prefix = timestamp(group.t) + (format === 'lrc' ? '' : ' ');
    for (const text of group.texts) {
      rows.push(prefix + (format === 'md' ? escapeMarkdown(text) + '  ' : text));
    }
    if (format === 'md') rows.push('');
  }
  return {
    content: rows.join('\r\n') + '\r\n',
    filename: filename(title, artist, format, language),
    extension: format,
    lines: selected.length,
    translatedRows,
  };
}

module.exports = { createExport, inspectLyrics, timestamp, filename };
