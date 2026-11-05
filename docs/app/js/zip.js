// Minimal store-only (uncompressed) ZIP writer with UTF-8 names and unix modes.
import { checkSymlinks, isSymlinkMode, visible } from './model.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{path:string, data:Uint8Array, mode?:number}[]} files package-relative paths; `root` is prepended to every entry name */
export function buildZip(files, now = new Date(), root = '') {
  // Checked before the root prefix: with it, ../../x would resolve to a zip-root path and pass.
  const { rejected } = checkSymlinks(files.map((f) => ({ path: f.path, bytes: f.data, mode: f.mode })));
  if (rejected.length) throw new Error(`Unsafe symlink ${visible(rejected[0].path)}: ${rejected[0].reason}`);
  const prefix = root ? `${root}/` : '';
  const enc = new TextEncoder();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const entries = files.map((f) => {
    const name = enc.encode(prefix + f.path);
    // Extractors apply the unix permission bits, so a link stored as 120000 would extract with mode 000.
    const mode = isSymlinkMode(f.mode) ? 0o120777 : f.mode || 0o100644;
    return { name, data: f.data, crc: crc32(f.data), mode, offset: 0 };
  });

  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  if (size > 0xffffffff || entries.length > 0xffff) throw new Error('Package too large for a ZIP archive');

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let p = 0;

  for (const e of entries) {
    e.offset = p;
    view.setUint32(p, 0x04034b50, true);
    view.setUint16(p + 4, 20, true);
    view.setUint16(p + 6, 0x0800, true);
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, dosTime, true);
    view.setUint16(p + 12, dosDate, true);
    view.setUint32(p + 14, e.crc, true);
    view.setUint32(p + 18, e.data.length, true);
    view.setUint32(p + 22, e.data.length, true);
    view.setUint16(p + 26, e.name.length, true);
    view.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }

  const cdStart = p;
  for (const e of entries) {
    view.setUint32(p, 0x02014b50, true);
    view.setUint16(p + 4, (3 << 8) | 20, true);
    view.setUint16(p + 6, 20, true);
    view.setUint16(p + 8, 0x0800, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, dosTime, true);
    view.setUint16(p + 14, dosDate, true);
    view.setUint32(p + 16, e.crc, true);
    view.setUint32(p + 20, e.data.length, true);
    view.setUint32(p + 24, e.data.length, true);
    view.setUint16(p + 28, e.name.length, true);
    view.setUint16(p + 30, 0, true);
    view.setUint16(p + 32, 0, true);
    view.setUint16(p + 34, 0, true);
    view.setUint16(p + 36, 0, true);
    view.setUint32(p + 38, (e.mode << 16) >>> 0, true);
    view.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }

  view.setUint32(p, 0x06054b50, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, p - cdStart, true);
  view.setUint32(p + 16, cdStart, true);
  return out;
}
