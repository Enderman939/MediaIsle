const test = require('node:test');
const assert = require('node:assert/strict');
const { unwrap, toState } = require('../lib/bridge/mpris-state');
const { parseMediaLine, parseVolumeLine } = require('../lib/bridge/macos-state');
const { friendlyName } = require('../lib/bridge/mpris');

test('mpris variants unwrap to plain values and map to island state frames', () => {
  assert.equal(unwrap({ type: 's', value: 'Playing' }), 'Playing');
  assert.equal(unwrap(7), 7);
  const props = {
    Metadata: {
      type: 'a{sv}',
      value: {
        'xesam:title': { type: 's', value: 'Song' },
        'xesam:artist': { type: 'as', value: ['A1', 'A2'] },
        'xesam:album': { type: 's', value: 'Album' },
        'mpris:length': { type: 'x', value: 180000000 },
        'mpris:artUrl': { type: 's', value: 'https://example.test/a.jpg' },
      },
    },
    PlaybackStatus: { type: 's', value: 'Playing' },
    Position: { type: 'x', value: 30000000 },
    CanPlay: { type: 'b', value: true },
    CanPause: { type: 'b', value: true },
    CanGoNext: { type: 'b', value: false },
    CanSeek: { type: 'b', value: true },
    LoopStatus: { type: 's', value: 'Track' },
    Shuffle: { type: 'b', value: true },
  };
  const st = toState({ player: 'Spotify', props, receivedAt: 123 });
  assert.equal(st.hasSession, true);
  assert.equal(st.title, 'Song');
  assert.equal(st.artist, 'A1/A2');
  assert.equal(st.duration, 180000);
  assert.equal(st.position, 30000);
  assert.equal(st.status, 'Playing');
  assert.equal(st.canNext, false);
  assert.equal(st.repeatMode, 1);
  assert.equal(st.isShuffle, true);
  assert.equal(st.artUrl, 'https://example.test/a.jpg');
  assert.equal(st.receivedAt, 123);
});

test('mpris stopped session without metadata stays sessionless', () => {
  const st = toState({ player: 'VLC', props: { PlaybackStatus: { type: 's', value: 'Stopped' } } });
  assert.equal(st.hasSession, false);
  assert.equal(st.status, 'Stopped');
});

test('friendlyName maps common players and prettifies the rest', () => {
  assert.equal(friendlyName('org.mpris.MediaPlayer2.spotify'), 'Spotify');
  assert.equal(friendlyName('org.mpris.MediaPlayer2.vlc'), 'VLC');
  assert.equal(friendlyName('org.mpris.MediaPlayer2.plash.instance21'), 'Plash');
  assert.equal(friendlyName('org.mpris.MediaPlayer2.unknown'), 'Unknown');
});

test('macos appleScript lines parse into media and volume states', () => {
  const media = parseMediaLine(['Song', 'Artist', 'Album', 'playing', '180000', '12.5'].join('\u0001'));
  assert.equal(media.title, 'Song');
  assert.equal(media.status, 'Playing');
  assert.equal(media.durationMs, 180000);
  assert.equal(media.positionSec, 12.5);
  const spotify = parseMediaLine(['Song2', 'A', '', 'playing', '90000'].join('\u0001'));
  assert.equal(spotify.positionSec, null);
  assert.equal(parseMediaLine('NOTRUN'), null);
  assert.equal(parseMediaLine(''), null);
  const vol = parseVolumeLine(['42', 'true'].join('\u0001'));
  assert.deepEqual(vol, { volume: 42, muted: true });
  assert.equal(parseVolumeLine('bad'), null);
});
