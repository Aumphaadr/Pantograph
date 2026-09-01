// export/zip.js — запись zip-архива.
//
// Без библиотеки: сжатие даёт сам движок через CompressionStream, а формат
// архива — это две сотни строк заголовков. Тащить ради этого стороннюю
// зависимость в проект, где их и так одна, незачем.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

const toBytes = (data) => (typeof data === 'string' ? utf8(data)
  : data instanceof Uint8Array ? data : new Uint8Array(data));

/** Сжать deflate-raw, если движок умеет; иначе положить как есть. */
async function deflate(bytes) {
  if (typeof CompressionStream !== 'function' || bytes.length === 0) return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return packed.length < bytes.length ? packed : null;   // раздулось — не надо
  } catch {
    return null;
  }
}

/** Время и дата в формате MS-DOS: иначе распакованные файлы получают «1980-00-00». */
export function dosStamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function put(view, offset, values) {
  let at = offset;
  for (const [size, value] of values) {
    if (size === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += size;
  }
  return at;
}

/**
 * @param {Array<{name:string, data:string|Uint8Array|ArrayBuffer}>} files
 * @returns {Promise<Blob>}
 */
export async function makeZip(files, { date = new Date() } = {}) {
  const stamp = dosStamp(date);
  const parts = [];
  const dir = [];
  let offset = 0;

  for (const file of files) {
    const raw = toBytes(file.data);
    const name = utf8(file.name);
    const packed = await deflate(raw);
    const body = packed ?? raw;
    const method = packed ? 8 : 0;
    const sum = crc32(raw);

    const head = new Uint8Array(30 + name.length);
    const hv = new DataView(head.buffer);
    put(hv, 0, [[4, 0x04034B50], [2, 20], [2, 0x0800], [2, method], [2, stamp.time], [2, stamp.date],
      [4, sum], [4, body.length], [4, raw.length], [2, name.length], [2, 0]]);
    head.set(name, 30);

    parts.push(head, body);
    dir.push({ name, method, sum, packed: body.length, raw: raw.length, offset });
    offset += head.length + body.length;
  }

  const central = [];
  let dirSize = 0;
  for (const e of dir) {
    const rec = new Uint8Array(46 + e.name.length);
    const rv = new DataView(rec.buffer);
    // Флаг 0x0800 — имена в UTF-8: иначе кириллица в именах файлов поедет.
    put(rv, 0, [[4, 0x02014B50], [2, 20], [2, 20], [2, 0x0800], [2, e.method],
      [2, stamp.time], [2, stamp.date],
      [4, e.sum], [4, e.packed], [4, e.raw], [2, e.name.length], [2, 0], [2, 0],
      [2, 0], [2, 0], [4, 0], [4, e.offset]]);
    rec.set(e.name, 46);
    central.push(rec);
    dirSize += rec.length;
  }

  const end = new Uint8Array(22);
  put(new DataView(end.buffer), 0, [[4, 0x06054B50], [2, 0], [2, 0],
    [2, dir.length], [2, dir.length], [4, dirSize], [4, offset], [2, 0]]);

  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** Распаковать deflate-raw, если движок умеет. */
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Разбор архива: имя → байты.
 *
 * Заголовки читаются подряд, а не через центральный каталог: этого хватает
 * для архивов, которые мы сами и написали, а чужие сюда не попадают.
 * Файлы с отложенным описателем (потоковая запись) не поддерживаются —
 * makeZip таких не делает.
 */
export async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  let at = 0;

  while (at + 30 <= bytes.length && dv.getUint32(at, true) === 0x04034B50) {
    const method = dv.getUint16(at + 8, true);
    const sum = dv.getUint32(at + 14, true);
    const packed = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extraLen = dv.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    const body = bytes.slice(start, start + packed);

    const data = method === 8 ? await inflate(body) : body;
    if (crc32(data) !== sum) throw new Error(`Файл «${name}» в архиве повреждён`);
    out.set(name, data);
    at = start + packed;
  }
  return out;
}
