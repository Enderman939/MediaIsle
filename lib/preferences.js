'use strict';

const DEFAULT_SHORTCUTS = {
  toggle: 'Ctrl+Alt+Space', prev: 'Ctrl+Alt+Left', next: 'Ctrl+Alt+Right',
  desktopLyrics: 'Ctrl+Alt+L', favorite: 'Ctrl+Alt+F',
};

function trackKey(title, artist) {
  return JSON.stringify([String(title || '').trim().toLowerCase(), String(artist || '').trim().toLowerCase()]);
}

function clampOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('偏移量必须是数字');
  return Math.round(Math.max(-10, Math.min(10, n)) * 10) / 10;
}

function effectiveOffset(cfg, title, artist) {
  const perTrack = cfg.lyrOffsets && cfg.lyrOffsets[trackKey(title, artist)];
  return clampOffset(Number.isFinite(perTrack) ? perTrack : Number(cfg.lyrOffset) || 0);
}

function normalizeShortcut(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length > 80) throw new Error('快捷键过长');
  const parts = raw.split('+').map((x) => x.trim());
  const aliases = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super' };
  const modifiers = parts.slice(0, -1).map((x) => aliases[x.toLowerCase()]);
  if (!modifiers.length || modifiers.some((x) => !x) || new Set(modifiers).size !== modifiers.length) throw new Error('快捷键需包含 Ctrl、Alt、Shift 或 Super 修饰键');
  const keys = { space: 'Space', left: 'Left', right: 'Right', up: 'Up', down: 'Down', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
  const input = parts.at(-1);
  const key = keys[input.toLowerCase()] || (/^(?:[a-z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(input) ? input.toUpperCase() : null);
  if (!key) throw new Error('不支持的按键');
  return ['Ctrl', 'Alt', 'Shift', 'Super'].filter((m) => modifiers.includes(m)).concat(key).join('+');
}

module.exports = { DEFAULT_SHORTCUTS, trackKey, clampOffset, effectiveOffset, normalizeShortcut };
