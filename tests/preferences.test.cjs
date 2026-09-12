const test = require('node:test');
const assert = require('node:assert/strict');
const { trackKey, clampOffset, effectiveOffset, normalizeShortcut } = require('../lib/preferences');
const { parseRelease, isNewer, resolveNotice } = require('../lib/release');

test('per-track offsets override global zero, persist identity, and reset', () => {
  const cfg = { lyrOffset: 1.2, lyrOffsets: { [trackKey(' Song ', 'ARTIST')]: 0 } };
  assert.equal(effectiveOffset(cfg, 'song', 'artist'), 0);
  assert.equal(effectiveOffset(cfg, 'different', 'artist'), 1.2);
  delete cfg.lyrOffsets[trackKey('song', 'artist')];
  assert.equal(effectiveOffset(cfg, 'Song', 'Artist'), 1.2);
  assert.equal(clampOffset(100), 10);
  assert.equal(clampOffset(-100), -10);
  assert.throws(() => clampOffset(Infinity));
  assert.notEqual(trackKey('a|b', 'c'), trackKey('a', 'b|c'));
});

test('shortcut canonicalization prevents aliases and malformed shortcuts', () => {
  assert.equal(normalizeShortcut('alt+control+space'), 'Ctrl+Alt+Space');
  assert.equal(normalizeShortcut('Ctrl+Alt+f'), 'Ctrl+Alt+F');
  assert.equal(normalizeShortcut(''), '');
  for (const invalid of ['F', 'Ctrl+Ctrl+F', 'cmd+X', 'Ctrl++', 'Alt+Invalid']) assert.throws(() => normalizeShortcut(invalid));
});

const release = { version: '1.2.0', buildDate: '2026-09-12T00:00:00Z', zip: 'MediaIsle-1.2.0-portable.zip', sha256: 'a'.repeat(64) };
test('release manifests cannot introduce paths or omit integrity checks', () => {
  assert.deepEqual(parseRelease(release).notes, []);
  for (const zip of ['../app.zip', 'folder/app.zip', 'https://example.test/app.zip', 'app.exe']) assert.throws(() => parseRelease({ ...release, zip }));
  assert.throws(() => parseRelease({ ...release, sha256: '' }));
  assert.throws(() => parseRelease({ ...release, buildDate: 'unknown' }));
  assert.equal(isNewer(release, '1.1.1+20260905.1827', '2027-01-01'), true);
  assert.equal(isNewer(release, '1.3.0', '2020-01-01'), false);
  assert.equal(isNewer(release, '1.2.0', release.buildDate), false);
});

test('update notice only claims completion for the installed target', () => {
  const notes = ['Current bundled changes'];
  assert.equal(resolveNotice({ pending: { from: '1.1.1', to: '1.2.0' }, version: '1.1.1', notes, existingInstall: true }), null);
  assert.deepEqual(resolveNotice({ pending: { from: '1.1.1', to: '1.2.0', notes: ['obsolete'] }, version: '1.2.0', notes }), {
    from: '1.1.1', to: '1.2.0', notes, completed: true,
  });
  assert.equal(resolveNotice({ version: '1.2.0', previous: '1.2.0', existingInstall: true, notes }), null);
  assert.equal(resolveNotice({ version: '1.2.0', existingInstall: false, notes }), null);
  assert.equal(resolveNotice({ version: '1.2.0', existingInstall: true, notes }).completed, true);
});
