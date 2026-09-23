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

function start({ onEvent, onError, fsEnabled }) {
  let stopped = false;
  let currentApp = null;
  let preferredApp = null;
  let playingSince = 0;
  let basePos = 0;
  let lastVolumeSig = '';
  let fsLast = null;
  let fsFails = 0;

  async function listRunning() {
    // 经 System Events 查询运行中的播放器, 避免 AppleScript 直接拉起未运行的应用
    const running = [];
    for (const app of APPS) {
      const r = await osa(`tell application "System Events" to (name of processes) contains "${app}"`);
      if (/true/i.test(r)) running.push(app);
    }
    return running;
  }

  async function readFullscreenMac() {
    // AXFullScreen 需要辅助功能权限; 连续失败后静默停用
    if (fsFails >= 5) return null;
    const out = await osa([
      'tell application "System Events"',
      '  set fp to first application process whose frontmost is true',
      '  tell fp',
      '    if (count of windows) > 0 then',
      '      return (value of attribute "AXFullScreen" of window 1) as text',
      '    end if',
      '  end tell',
      'end tell',
      'return "false"',
    ].join('\n'));
    if (out === '') { fsFails++; return null; }
    fsFails = 0;
    return /true/i.test(out);
  }

  async function readVolume() {
    const out = await osa('set v to (get volume settings)\nreturn (output volume of v as text) & "\u0001" & ((output muted of v) as text)');
    return parseVolumeLine(out);
  }

  async function tick() {
    if (stopped) return;
    try {
      const running = await listRunning();
      const read = [];
      for (const app of running) {
        read.push({ app, parsed: parseMediaLine(await osa(READ_MEDIA(app))) });
      }
      const sources = running.map((app) => ({ id: app, name: app }));
      const chosenApp = (preferredApp && running.includes(preferredApp)) ||
        (read.find((r) => r.parsed?.status === 'Playing')?.app) || running[0] || null;
      const chosen = read.find((r) => r.app === chosenApp)?.parsed || null;
      const state = {
        type: 'state',
        hasSession: !!chosen,
        sources,
        selApp: chosenApp || '',
        receivedAt: Date.now(),
      };
      if (chosen) {
        currentApp = chosenApp;
        const playing = chosen.status === 'Playing';
        if (playing && !playingSince) { playingSince = Date.now(); basePos = 0; }
        if (!playing) { basePos = chosen.positionSec ?? basePos; playingSince = 0; }
        const position = chosen.positionSec ?? (playing ? basePos + (Date.now() - playingSince) / 1000 : basePos);
        Object.assign(state, {
          appId: chosenApp,
          source: chosenApp,
          title: chosen.title,
          artist: chosen.artist,
          album: chosen.album,
          status: chosen.status,
          position: Math.max(0, Math.round(position * 1000)),
          duration: Math.round(chosen.durationMs),
          posAge: 0,
          canPlay: !playing,
          canPause: playing,
          canNext: true,
          canPrev: true,
          canSeek: chosenApp === 'Music',
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
      if (fsEnabled && fsEnabled()) {
        const fs = await readFullscreenMac();
        if (fs !== null && fs !== fsLast) { fsLast = fs; onEvent({ type: 'fs', v: fs }); }
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
        if (cmd === 'switch-source') {
          preferredApp = String(val || '');
          return;
        }
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
