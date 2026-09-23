'use strict';

// MPRIS 属性 → MediaIsle 状态帧 (与 bridge.ps1 输出同构, main.js handleBridgeLine 直接消费)
// dbus-next 的返回值可能带 variant 包装 { type, value }, 逐层解包。

function unwrap(value) {
  let v = value;
  while (v && typeof v === 'object' && Object.keys(v).length === 2 && 'type' in v && 'value' in v) v = v.value;
  return v;
}

const LOOP_STATUS = { None: 0, Track: 1, Playlist: 2 };

function toState({ player, props, receivedAt = Date.now() }) {
  const meta = unwrap(props.Metadata) || {};
  const status = String(unwrap(props.PlaybackStatus) || 'Stopped');
  const artists = unwrap(meta['xesam:artist']);
  const title = String(unwrap(meta['xesam:title']) || '');
  const artist = Array.isArray(artists) ? artists.filter(Boolean).join('/') : String(artists || '');
  const lengthUs = Number(unwrap(meta['mpris:length']) || 0);
  const hasTrack = !!(title || artist);
  return {
    type: 'state',
    hasSession: hasTrack,
    appId: player,
    source: player,
    title,
    artist,
    album: String(unwrap(meta['xesam:album']) || ''),
    status: status === 'Playing' ? 'Playing' : status === 'Paused' ? 'Paused' : 'Stopped',
    position: Math.max(0, Math.round(Number(unwrap(props.Position) || 0) / 1000)),
    duration: Math.round(lengthUs / 1000),
    posAge: 0,
    canPlay: !!unwrap(props.CanPlay),
    canPause: !!unwrap(props.CanPause),
    canNext: !!unwrap(props.CanGoNext),
    canPrev: !!unwrap(props.CanGoPrevious),
    canSeek: !!unwrap(props.CanSeek),
    canShuffle: !!unwrap(props.CanControl),
    isShuffle: !!unwrap(props.Shuffle),
    repeatMode: LOOP_STATUS[String(unwrap(props.LoopStatus))] ?? 0,
    artUrl: String(unwrap(meta['mpris:artUrl']) || ''),
    receivedAt,
  };
}

module.exports = { unwrap, toState };
