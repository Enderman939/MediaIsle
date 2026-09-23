'use strict';

// Linux 媒体桥接: 通过 D-Bus MPRIS2 读取/控制播放器 (Spotify/VLC/mpv/浏览器等)。
// 系统音量经 pactl (PulseAudio / PipeWire-pulse)。所有失败均降级, 不影响岛体其它功能。

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sessionBus, variant } = require('dbus-next');
const { toState } = require('./mpris-state');

const PLAYER_PREFIX = 'org.mpris.MediaPlayer2.';
const FRIENDLY = {
  spotify: 'Spotify', vlc: 'VLC', mpv: 'mpv', rhythmbox: 'Rhythmbox', clementine: 'Clementine',
  chromium: 'Chrome', googlechromecrust: 'Chrome', firefox: 'Firefox', audacious: 'Audacious',
  lollypop: 'Lollipop', strawberry: 'Strawberry', elisa: 'Elisa', totem: 'Videos', cmus: 'cmus',
  ncspot: 'ncspot', amberol: 'Amberol', quodlibet: 'Quod Libet', smplayer: 'SMPlayer', celo: 'Celo',
};

function friendlyName(mprisName) {
  const short = mprisName.slice(PLAYER_PREFIX.length).split('.instance')[0].toLowerCase();
  return FRIENDLY[short] || short.charAt(0).toUpperCase() + short.slice(1);
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

const artCache = { url: null, data: null };
async function artData(url) {
  if (!url) return null;
  if (artCache.url === url) return artCache.data;
  let data = null;
  try {
    if (url.startsWith('file://')) {
      const file = decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/^\/([A-Za-z]:)/, '$1');
      const buf = await fs.promises.readFile(path.normalize(file));
      data = `data:${sniffMime(buf)};base64,${buf.toString('base64')}`;
    } else if (/^https?:\/\//.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        data = `data:${res.headers.get('content-type') || sniffMime(buf)};base64,${buf.toString('base64')}`;
      }
    }
  } catch { }
  artCache.url = url;
  artCache.data = data;
  return data;
}

async function readVolume() {
  try {
    const [vol, mute] = await Promise.all([
      exec('pactl', ['get-sink-volume', '@DEFAULT_SINK@']),
      exec('pactl', ['get-sink-mute', '@DEFAULT_SINK@']),
    ]);
    const m = /(\d+)%/.exec(vol);
    if (!m) return null;
    return { volume: Number(m[1]), mute: /yes/i.test(mute) };
  } catch { return null; }
}

function start({ onEvent, onError, fsEnabled }) {
  let stopped = false;
  let bus = null;
  let preferred = null;   // 用户固定的播放器 (MPRIS 总线名)
  let currentPlayer = null; // 最近活跃播放器的 MPRIS 总线名
  let lastVolumeSig = '';
  let fsLast = null;

  async function listPlayers() {
    const obj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
    const dbus = obj.getInterface('org.freedesktop.DBus');
    const names = await dbus.ListNames();
    return names.filter((n) => n.startsWith(PLAYER_PREFIX));
  }

  async function readPlayer(name) {
    const obj = await bus.getProxyObject(name, '/org/mpris/MediaPlayer2');
    const props = obj.getInterface('org.freedesktop.DBus.Properties');
    const raw = await props.GetAll('org.mpris.MediaPlayer2.Player');
    const all = {};
    for (const key of Object.keys(raw)) all[key] = raw[key];
    try { all.Position = await props.Get('org.mpris.MediaPlayer2.Player', 'Position'); } catch { }
    const st = toState({ player: friendlyName(name), props: all, receivedAt: Date.now() });
    return { st, obj, props };
  }

  async function readFullscreenX11() {
    // X11 best-effort: xdotool 取活动窗口, xprop 查全屏状态。Wayland / 缺工具时静默停用。
    try {
      const id = (await exec('xdotool', ['getactivewindow'])).trim();
      if (!/^\d+$/.test(id)) return null;
      const out = await exec('xprop', ['-id', id, '_NET_WM_STATE']);
      if (!out) return null;
      return out.includes('_NET_WM_STATE_FULLSCREEN');
    } catch { return null; }
  }

  async function tick() {
    if (stopped) return;
    try {
      if (!bus) bus = sessionBus();
      const names = await listPlayers();
      const read = [];
      for (const name of names) {
        try {
          const { st } = await readPlayer(name);
          read.push({ name, st });
        } catch { }
      }
      const sources = read.map((r) => ({ id: r.name, name: r.st.source }));
      const chosen = (preferred && read.find((r) => r.name === preferred)) ||
        read.find((r) => r.st.status === 'Playing') || read[0] || null;
      currentPlayer = chosen?.name || null;
      if (chosen) {
        const best = chosen.st;
        const art = await artData(best.artUrl);
        delete best.artUrl;
        if (art) { best.art = art; best.artHash = crypto.createHash('sha1').update(best.artUrl || '').digest('hex'); }
        best.sources = sources;
        best.selApp = chosen.name;
        onEvent(best);
      } else {
        onEvent({ type: 'state', hasSession: false, sources, selApp: preferred || '', receivedAt: Date.now() });
      }
      const vol = await readVolume();
      if (vol) {
        const sig = `${vol.volume}|${vol.mute}`;
        if (sig !== lastVolumeSig) { lastVolumeSig = sig; onEvent({ type: 'volume', volume: vol.volume, mute: vol.mute }); }
      }
      if (fsEnabled && fsEnabled()) {
        const fs = await readFullscreenX11();
        if (fs !== null && fs !== fsLast) { fsLast = fs; onEvent({ type: 'fs', v: fs }); }
      }
    } catch (e) {
      try { bus?.disconnect(); } catch { }
      bus = null;
      onError(e);
    }
    if (!stopped) setTimeout(tick, 500);
  }
  tick();

  async function withPlayer(fn) {
    if (!bus || !currentPlayer) return;
    try {
      const obj = await bus.getProxyObject(currentPlayer, '/org/mpris/MediaPlayer2');
      fn(obj);
    } catch (e) { onError(e); }
  }

  return {
    stop() {
      stopped = true;
      try { bus?.disconnect(); } catch { }
    },
    async sendCommand(cmd, val) {
      try {
        if (cmd === 'switch-source') {
          preferred = String(val || '');
          return;
        }
        if (cmd === 'volume') {
          const v = Math.max(0, Math.min(100, Math.round(Number(val) || 0)));
          exec('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${v}%`]);
          return;
        }
        if (cmd === 'toggle-mute') {
          exec('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
          return;
        }
        if (!bus || !currentPlayer) return;
        const obj = await bus.getProxyObject(currentPlayer, '/org/mpris/MediaPlayer2');
        const props = obj.getInterface('org.freedesktop.DBus.Properties');
        const iface = obj.getInterface('org.mpris.MediaPlayer2.Player');
        if (cmd === 'play') iface.play();
        else if (cmd === 'pause') iface.pause();
        else if (cmd === 'toggle') iface.playPause();
        else if (cmd === 'next') iface.next();
        else if (cmd === 'prev') iface.previous();
        else if (cmd === 'seek') {
          const targetUs = Math.round(Number(val) * 1000);
          const meta = unwrap((await props.GetAll('org.mpris.MediaPlayer2.Player')).Metadata) || {};
          const trackId = unwrap(meta['mpris:trackid']);
          if (trackId && iface.SetPosition) iface.SetPosition(trackId, targetUs);
          else {
            const curUs = Number(unwrap(await props.Get('org.mpris.MediaPlayer2.Player', 'Position').catch(() => 0)) || 0);
            iface.Seek(Math.round(targetUs - curUs));
          }
        } else if (cmd === 'shuffle') {
          props.Set('org.mpris.MediaPlayer2.Player', 'Shuffle', variant('b', !!val));
        } else if (cmd === 'repeat') {
          const mode = Number(val) === 1 ? 'Track' : Number(val) === 2 ? 'Playlist' : 'None';
          props.Set('org.mpris.MediaPlayer2.Player', 'LoopStatus', variant('s', mode));
        }
      } catch (e) { onError(e); }
    },
  };
}

module.exports = { start, friendlyName };
