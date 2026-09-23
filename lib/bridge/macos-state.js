'use strict';

// macOS AppleScript 输出解析 (纯函数, 便于测试)
// Spotify/Music 返回 \u0001 分隔的字段行; 音量返回 "音量\u0001静音"。

function parseMediaLine(raw) {
  const parts = String(raw || '').split('\u0001');
  if (parts[0] === 'NOTRUN' || parts[0] === 'STOPPED' || !parts[0]) return null;
  const [title, artist, album, status, durationMs, positionSec] = parts;
  if (!title) return null;
  return {
    title: String(title || ''),
    artist: String(artist || ''),
    album: String(album || ''),
    status: String(status || '').toLowerCase() === 'playing' ? 'Playing' : 'Paused',
    durationMs: Number(durationMs) || 0,
    positionSec: positionSec === undefined || positionSec === '' ? null : Number(positionSec),
  };
}

function parseVolumeLine(raw) {
  const [vol, mute] = String(raw || '').split('\u0001');
  const volume = Number(vol);
  if (!Number.isFinite(volume)) return null;
  return { volume, muted: String(mute).trim() === 'true' };
}

module.exports = { parseMediaLine, parseVolumeLine };
