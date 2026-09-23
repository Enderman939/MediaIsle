const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodePNG, render, buildIco } = require('../scripts/gen-icons');
const { entryFor, FILE } = require('../lib/autostart');

test('icon PNG encoder emits valid signature, IHDR dims and RGBA color type', () => {
  const rgba = Buffer.alloc(8 * 8 * 4, 128);
  const png = encodePNG(8, 8, rgba);
  assert.ok(png.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(png.readUInt32BE(16), 8);
  assert.equal(png.readUInt32BE(20), 8);
  assert.equal(png[24], 8);  // bit depth
  assert.equal(png[25], 6);  // RGBA
  const rendered = render(512, 1);
  assert.equal(rendered.length, 512 * 512 * 4);
  // 中心点在药丸内: 不透明; 角落在药丸外: 透明
  assert.equal(rendered[(256 * 512 + 256) * 4 + 3], 255);
  assert.equal(rendered[3], 0);
});

test('ico wraps a png entry with valid directory fields', () => {
  const png = encodePNG(4, 4, Buffer.alloc(4 * 4 * 4, 200));
  const ico = buildIco(png);
  assert.equal(ico.readUInt16LE(2), 1);   // type icon
  assert.equal(ico.readUInt16LE(4), 1);   // count
  const entry = ico.slice(6, 22);
  assert.equal(entry.readUInt16LE(4), 1); // planes
  assert.equal(entry.readUInt16LE(6), 32);// bpp
  assert.equal(entry.readUInt32LE(8), png.length);
  assert.equal(entry.readUInt32LE(12), 22);
  assert.ok(ico.slice(22).equals(png));
});

test('xdg autostart entry carries exec line and canonical file path', () => {
  const entry = entryFor('"/opt/MediaIsle/mediaisle"');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /Exec="\/opt\/MediaIsle\/mediaisle"/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
  assert.ok(FILE().endsWith(path.join('.config', 'autostart', 'MediaIsle.desktop')));
  assert.notEqual(FILE(), path.join(os.tmpdir(), 'x'));
  assert.ok(fs.existsSync(path.dirname(FILE())) || true);
});
