'use strict';

function baseVersion(value) {
  return String(value || '').split('+')[0];
}

function parseRelease(info) {
  if (!info || !/^\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(info.version || '')) throw new Error('无效的更新版本');
  if (!/^MediaIsle-[\w.+-]+-portable\.zip$/.test(info.zip || '')) throw new Error('无效的更新文件名');
  if (!/^[a-f0-9]{64}$/i.test(info.sha256 || '')) throw new Error('更新缺少 SHA256 校验值');
  if (!Number.isFinite(Date.parse(info.buildDate || ''))) throw new Error('无效的更新日期');
  return {
    version: info.version, zip: info.zip, buildDate: info.buildDate,
    sha256: info.sha256.toLowerCase(),
    notes: Array.isArray(info.notes) ? info.notes.filter((x) => typeof x === 'string').slice(0, 30) : [],
  };
}

function isNewer(remote, localVersion, localDate) {
  const r = baseVersion(remote.version).split('.').map(Number);
  const l = baseVersion(localVersion).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i];
  }
  return Date.parse(remote.buildDate) - Date.parse(localDate || '') > 60000;
}

function resolveNotice({ pending, version, previous, existingInstall, notes }) {
  if (pending && pending.to === version) {
    return { ...pending, to: version, notes, completed: true };
  }
  if (existingInstall && previous !== version && !pending) {
    return { from: previous || '', to: version, notes, completed: true };
  }
  return null;
}

module.exports = { baseVersion, parseRelease, isNewer, resolveNotice };
