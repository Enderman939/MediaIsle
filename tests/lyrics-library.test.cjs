const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLyrics, batchTracks, exportPreferences } = require('../lib/lyrics-library');

test('editor rejects invalid rows without silently losing user text', () => {
  for (const value of [NaN, Infinity, -1, 86401, '1']) assert.throws(() => validateLyrics({ lines: [{ t: value, x: 'Text' }] }), /时间/);
  for (const value of ['', '  ', 'Two\nlines', 'Null\u0000text']) assert.throws(() => validateLyrics({ lines: [{ t: 1, x: value }] }), /文本/);
  assert.throws(() => validateLyrics({ lines: [] }), /至少/);
  const source = { lines: [{ t: 2, x: ' Second ' }, { t: 0, x: 'First' }], trans: [{ t: 7, x: 'Unaligned translation' }] };
  const result = validateLyrics(source);
  assert.equal(result.lines[0].t, 0); assert.equal(result.lines[1].x, 'Second');
  assert.equal(result.trans[0].t, 7, 'Unaligned translations are preserved for editing');
  assert.equal(source.lines[0].x, ' Second ');
});

test('batch track identity is deduplicated and preferences ignore invalid choices', () => {
  assert.equal(batchTracks([{ title: 'Song', artist: 'A' }, { title: ' song ', artist: 'a' }]).length, 1);
  assert.throws(() => batchTracks([])); assert.throws(() => batchTracks([{ title: '' }]));
  assert.equal(exportPreferences({ format: 'exe', language: 'missing' }).format, 'txt');
  assert.equal(exportPreferences(null).language, 'bilingual');
});
