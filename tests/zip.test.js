import { crc32, dosStamp, makeZip } from '../js/export/zip.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

/** Разбор архива обратно: заголовки, распаковка, сверка с тем, что клали. */
async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(bytes.buffer);
  const files = [];
  let at = 0;
  while (at + 4 <= bytes.length && dv.getUint32(at, true) === 0x04034B50) {
    const method = dv.getUint16(at + 8, true);
    const flag = dv.getUint16(at + 6, true);
    const sum = dv.getUint32(at + 14, true);
    const packed = dv.getUint32(at + 18, true);
    const raw = dv.getUint32(at + 22, true);
    const nameLen = dv.getUint16(at + 26, true);
    const name = dec(bytes.slice(at + 30, at + 30 + nameLen));
    const body = bytes.slice(at + 30 + nameLen, at + 30 + nameLen + packed);
    let data = body;
    if (method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      data = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(ds))
        .arrayBuffer());
    }
    files.push({ name, method, flag, sum, raw, data });
    at += 30 + nameLen + packed;
  }
  return { files, tailSignature: dv.getUint32(at, true) };
}

test('crc32 совпадает с эталоном', () => {
  eq(crc32(enc('123456789')).toString(16), 'cbf43926');
  eq(crc32(new Uint8Array(0)), 0);
});

test('дата в формате MS-DOS раскладывается верно', () => {
  const { time, date } = dosStamp(new Date(2026, 8, 1, 12, 34, 56));
  eq((date >> 9) + 1980, 2026);
  eq((date >> 5) & 15, 9);
  eq(date & 31, 1);
  eq(time >> 11, 12);
  eq((time >> 5) & 63, 34);
});

test('дата раньше 1980 не роняет формат', () => {
  eq((dosStamp(new Date(1970, 0, 1)).date >> 9) + 1980, 1980);
});

test('архив начинается и заканчивается положенными подписями', async () => {
  const z = await readZip(await makeZip([{ name: 'a.txt', data: 'привет' }]));
  eq(z.files.length, 1);
  eq(z.tailSignature, 0x02014B50, 'за файлами идёт центральный каталог');
});

test('содержимое возвращается байт в байт', async () => {
  const text = 'Здравствуй, мир!\n'.repeat(60);
  const z = await readZip(await makeZip([{ name: 'привет.txt', data: text }]));
  eq(dec(z.files[0].data), text);
  eq(z.files[0].raw, enc(text).length);
});

test('повторяющийся текст действительно сжимается', async () => {
  const z = await readZip(await makeZip([{ name: 'x', data: 'а'.repeat(2000) }]));
  eq(z.files[0].method, 8, 'выбран дефлейт');
});

test('мелкий файл кладётся без сжатия, раз оно его раздувает', async () => {
  const z = await readZip(await makeZip([{ name: 'x', data: 'ab' }]));
  eq(z.files[0].method, 0);
});

test('имена помечены как UTF-8 — иначе кириллица поедет', async () => {
  const z = await readZip(await makeZip([{ name: 'контур.svg', data: 'x' }]));
  eq(z.files[0].name, 'контур.svg');
  eq(Boolean(z.files[0].flag & 0x800), true);
});

test('контрольная сумма считается от исходных байтов, а не сжатых', async () => {
  const text = 'мир'.repeat(500);
  const z = await readZip(await makeZip([{ name: 'x', data: text }]));
  eq(z.files[0].sum, crc32(enc(text)));
});

test('пустой файл не ломает архив', async () => {
  const z = await readZip(await makeZip([{ name: 'пусто', data: new Uint8Array(0) }]));
  eq(z.files[0].raw, 0);
  eq(z.files[0].data.length, 0);
});

test('несколько файлов лежат в порядке добавления', async () => {
  const z = await readZip(await makeZip([
    { name: 'один', data: 'a'.repeat(300) },
    { name: 'два', data: 'b' },
    { name: 'три', data: new Uint8Array([1, 2, 3]) },
  ]));
  eq(z.files.map((f) => f.name), ['один', 'два', 'три']);
  eq([...z.files[2].data], [1, 2, 3]);
});

test('пустой архив остаётся валидным', async () => {
  const blob = await makeZip([]);
  const dv = new DataView(await blob.arrayBuffer());
  eq(dv.getUint32(0, true), 0x06054B50, 'сразу конец центрального каталога');
});
