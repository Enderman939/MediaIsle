'use strict';

// macOS 媒体桥接: osascript 驱动 Spotify 与 Music.app (无原生依赖)。
// Spotify 的 AppleScript 不提供播放位置: 播放中用本地时钟推算 (canSeek=false);
// Music.app 提供 player position, 支持精确 seek。

const { execFile } = require('child_process');
const { parseMediaLine, parseVolumeLine } = require('./macos-state');

const APPS = ['Spotify', 'Music'];

function osa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

const READ_MEDIA = (app) => [
  `tell application "${app}"`,
  '  if it is running then',
  '    try',
  '      if player state is stopped then return "STOPPED"',
  '      set t to current track',
  `      return (name of t) & "\u0001" & (artist of t) & "\u0001" & (album of t) & "\u0001" & ((player state as text)) & "\u0001" & ((duration of t) as text)${app === 'Music' ? ' & "\u0001" & ((player position) as text)' : ''}`,
  '    on error',
  '      return "STOPPED"',
  '    end try',
  '  else',
  '    return "NOTRUN"',
  '  end if',
  'end tell',
].join('\n');

function start({ onEvent, onError }) {
  let stopped = false;
  let currentApp = null;
  let playingSince = 0;
  let basePos = 0;
  let lastVolumeSig = '';

  async function readVolume() {
    const out = await osa('set v to (get volume settings)\nreturn (output volume of v as text) & "\u0001" & ((output muted of v) as text)');
    return parseVolumeLine(out);
  }

  async function tick() {
    if (stopped) return;
    try {
      let media = null;
      for (const app of APPS) {
        const parsed = parseMediaLine(await osa(READ_MEDIA(app)));
        if (!parsed) continue;
        media = { ...parsed, app };
        break;
      }
      const state = {
        type: 'state',
        hasSession: !!media,
        receivedAt: Date.now(),
      };
      if (media) {
        currentApp = media.app;
        const playing = media.status === 'Playing';
        if (playing && !playingSince) { playingSince = Date.now(); basePos = 0; }
        if (!playing) { basePos = media.positionSec ?? basePos; playingSince = 0; }
        const position = media.positionSec ?? (playing ? basePos + (Date.now() - playingSince) / 1000 : basePos);
        Object.assign(state, {
          appId: media.app,
          source: media.app,
          title: media.title,
          artist: media.artist,
          album: media.album,
          status: media.status,
          position: Math.max(0, Math.round(position * 1000)),
          duration: Math.round(media.durationMs),
          posAge: 0,
          canPlay: !playing,
          canPause: playing,
          canNext: true,
          canPrev: true,
          canSeek: media.app === 'Music',
          canShuffle: false,
          isShuffle: false,
          repeatMode: 0,
        });
      } else {
        currentApp = null;
        playingSince = 0;
        basePos = 0;
      }
      onEvent(state);
      const vol = await readVolume();
      if (vol) {
        const sig = `${vol.volume}|${vol.muted}`;
        if (sig !== lastVolumeSig) { lastVolumeSig = sig; onEvent({ type: 'volume', volume: vol.volume, mute: vol.muted }); }
      }
    } catch (e) {
      onError(e);
    }
    if (!stopped) setTimeout(tick, 500);
  }
  tick();

  return {
    stop() { stopped = true; },
    async sendCommand(cmd, val) {
      try {
        if (cmd === 'volume') {
          await osa(`set volume output volume ${Math.max(0, Math.min(100, Math.round(Number(val) || 0)))}`);
          return;
        }
        if (cmd === 'toggle-mute') {
          const cur = await readVolume();
          await osa(`set volume output muted ${cur && !cur.muted ? 'true' : 'false'}`);
          return;
        }
        if (!currentApp) return;
        if (cmd === 'toggle') await osa(`tell application "${currentApp}" to playpause`);
        else if (cmd === 'play') await osa(`tell application "${currentApp}" to play`);
        else if (cmd === 'pause') await osa(`tell application "${currentApp}" to pause`);
        else if (cmd === 'next') await osa(`tell application "${currentApp}" to next track`);
        else if (cmd === 'prev') await osa(`tell application "${currentApp}" to previous track`);
        else if (cmd === 'seek' && currentApp === 'Music') {
          await osa(`tell application "Music" to set player position to ${Math.max(0, Math.round(Number(val) || 0))}`);
        }
      } catch (e) { onError(e); }
    },
  };
}

module.exports = { start };
