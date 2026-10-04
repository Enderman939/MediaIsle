const test = require('node:test');
const assert = require('node:assert/strict');
const { createExport, inspectLyrics, timestamp, filename } = require('../lib/lyrics-export');

const song = { title: '歌曲', artist: '歌手', lines: [{ t: 62.345, x: 'Second' }, { t: 1, x: 'First' }],
  trans: [{ t: 62.345, x: '第二句' }] };

test('original LRC sorts timestamps, preserves precision and excludes translation', () => {
  const result = createExport(song);
  assert.equal(result.filename, '歌曲 - 歌手.lrc');
  assert.equal(result.content, '[ti:歌曲]\r\n[ar:歌手]\r\n\r\n[00:01.00]First\r\n[01:02.35]Second\r\n');
  assert.equal(result.lines, 2);
  assert.equal(result.translatedRows, 0);
  assert.equal(song.lines[0].x, 'Second', 'input is not mutated');
});

test('bilingual LRC aligns sparse translations by timestamp and keeps original timestamp', () => {
  const result = createExport({ ...song, format: 'lrc', language: 'bilingual', trans: [{ t: 62.39, x: '第二句' }] });
  assert.equal(result.filename, '歌曲 - 歌手.bilingual.lrc');
  assert.match(result.content, /\[01:02\.35\]Second\r\n\[01:02\.35\]第二句/);
  assert.equal(result.translatedRows, 1);
  assert.doesNotMatch(result.content, /\[00:01\.00\]第二句/);
});

test('TXT preserves original and aligned translation timestamps', () => {
  const result = createExport({ ...song, format: 'txt', language: 'bilingual' });
  assert.equal(result.filename, '歌曲 - 歌手.bilingual.txt');
  assert.equal(result.content, '歌曲 — 歌手\r\n\r\n[00:01.00] First\r\n[01:02.35] Second\r\n[01:02.35] 第二句\r\n');
  assert.equal(result.extension, 'txt');
});

test('exports reject missing originals, unsupported formats and unavailable bilingual lyrics', () => {
  assert.throws(() => createExport({ lines: [] }), /没有可下载/);
  assert.throws(() => createExport({ ...song, format: 'html' }), /不支持/);
  assert.throws(() => createExport({ ...song, language: 'bilingual', trans: [] }), /没有译文/);
  assert.throws(() => createExport({ ...song, language: 'bilingual', trans: [{ t: 30, x: 'Unrelated' }] }), /无法对齐/);
  assert.throws(() => createExport({ ...song, language: 'french' }), /不支持/);
});

test('invalid rows are skipped and line breaks cannot inject LRC metadata', () => {
  const result = createExport({ title: 'Song\n[evil]', artist: 'A\0', lines: [null, { t: -1, x: 'bad' },
    { t: NaN, x: 'bad' }, { t: Infinity, x: 'bad' }, { t: '1', x: 'bad' }, { t: 1, x: ' ' },
    { t: 2, x: 'Line\r\nnext\0part' }] });
  assert.equal(result.lines, 1);
  assert.match(result.content, /^\[ti:Song evil\]/);
  assert.match(result.content, /\[00:02\.00\]Line next part\r\n$/);
});

test('centisecond rounding carries into minutes and supports tracks longer than one hour', () => {
  assert.equal(timestamp(59.999), '[01:00.00]');
  assert.equal(timestamp(3600.12), '[60:00.12]');
  assert.equal(timestamp(0), '[00:00.00]');
});

test('default filenames strip Windows path characters and reserved names', () => {
  assert.equal(filename('CON', '', 'lrc'), '_CON.lrc');
  assert.equal(filename('../Song:*?', 'A/B', 'txt'), '.._Song___ - A_B.txt');
  assert.equal(filename('... ', '', 'lrc'), '歌词.lrc');
  assert.equal(filename('NUL.txt', '', 'lrc'), '_NUL.txt.lrc');
  assert.ok([...filename('歌'.repeat(300), '', 'lrc', 'bilingual')].length <= 134);
});

test('Chinese and English selections work independently of original vs translation', () => {
  const englishOriginal = { title: 'Song', lines: [{ t: 1, x: 'Hello world' }], trans: [{ t: 1, x: '你好世界' }] };
  const chineseOriginal = { ...englishOriginal, lines: englishOriginal.trans, trans: englishOriginal.lines };
  for (const fixture of [englishOriginal, chineseOriginal]) {
    const chinese = createExport({ ...fixture, format: 'txt', language: 'chinese' });
    const english = createExport({ ...fixture, format: 'md', language: 'english' });
    assert.match(chinese.content, /你好世界/);
    assert.doesNotMatch(chinese.content, /Hello world/);
    assert.match(english.content, /Hello world/);
    assert.doesNotMatch(english.content, /你好世界/);
    assert.match(chinese.filename, /\.zh\.txt$/);
    assert.match(english.filename, /\.en\.md$/);
  }
});

test('every file format supports each language independently', () => {
  for (const format of ['md', 'txt', 'lrc']) {
    for (const language of ['original', 'chinese', 'english', 'bilingual']) {
      const result = createExport({ ...song, format, language });
      assert.equal(result.extension, format);
      assert.ok(result.content.length > 0);
      assert.match(result.content, /\[01:02\.35\]/);
      assert.doesNotMatch(result.content, /^\[by:/m);
    }
  }
});

test('Markdown escapes lyric markup and HTML while preserving readable line breaks', () => {
  const result = createExport({ title: '# [title]', artist: 'A * B', format: 'md', lines: [{ t: 1, x: '<script> *line* [link](url)' }] });
  assert.match(result.content, /^# \\# \\\[title\\\]/);
  assert.ok(result.content.includes('[00:01.00] \\<script\\> \\*line\\* \\[link\\]\\(url\\)  \r\n'));
  assert.doesNotMatch(result.content, /<script>/);
});

test('Markdown and TXT align bilingual timestamps and round minute boundaries', () => {
  for (const format of ['md', 'txt']) {
    const result = createExport({ title: 'Song', format, language: 'bilingual',
      lines: [{ t: 59.999, x: 'Hello' }], trans: [{ t: 60.04, x: '你好' }] });
    assert.match(result.content, /\[01:00\.00\] Hello(?:  )?\r\n\[01:00\.00\] 你好/);
    assert.doesNotMatch(result.content, /^\[by:/m);
  }
});

test('unavailable languages remain unavailable and Japanese is not labelled English', () => {
  const chineseOnly = { lines: [{ t: 1, x: '你好世界' }] };
  assert.deepEqual(inspectLyrics(chineseOnly).languages, ['original', 'chinese']);
  assert.throws(() => createExport({ ...chineseOnly, language: 'english' }), /没有英文/);
  const japanese = { lines: [{ t: 1, x: '君が好き' }], trans: [{ t: 1, x: '我喜欢你' }] };
  assert.deepEqual(inspectLyrics(japanese).languages, ['original', 'chinese', 'bilingual']);
  assert.throws(() => createExport({ ...japanese, language: 'english' }), /没有英文/);
});

test('language-only exports keep unaligned translation rows and duplicate translation is not bilingual', () => {
  const fixture = { lines: [{ t: 1, x: 'Hello' }], trans: [{ t: 1.3, x: '你好' }] };
  assert.match(createExport({ ...fixture, language: 'chinese' }).content, /\[00:01\.30\]你好/);
  assert.throws(() => createExport({ ...fixture, language: 'bilingual' }), /无法对齐/);
  assert.deepEqual(inspectLyrics({ lines: fixture.lines, trans: fixture.lines }).languages, ['original', 'english']);
});
