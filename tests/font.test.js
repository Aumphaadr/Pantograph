import {
  glyphName, toOpenPath, pickUnique, buildFont, toArrayBuffer, fileName,
  translit, postScriptName,
} from '../js/export/font.js';
import { node } from '../js/core/path.js';

const P = (x, y) => ({ x, y });

/** Квадрат в единицах шрифта: Y вверх, низ на базовой линии. */
const box = (w = 500, h = 700) => ({
  contours: [{
    closed: true,
    nodes: [
      node(P(0, 0), P(0, 0), P(0, 0), 'corner'),
      node(P(w, 0), P(w, 0), P(w, 0), 'corner'),
      node(P(w, h), P(w, h), P(w, h), 'corner'),
      node(P(0, h), P(0, h), P(0, h), 'corner'),
    ],
  }],
});

const g = (code, adv = 600) => ({ codepoint: code, shape: box(), advance: adv });
const FM = { upm: 1000, ascender: 735, descender: -144 };

// ─── имена глифов ───────────────────────────────────────────────────────────

test('имена глифов человеческие там, где это принято', () => {
  eq(glyphName(32), 'space');
  eq(glyphName('A'.codePointAt(0)), 'A');
  eq(glyphName('z'.codePointAt(0)), 'z');
  eq(glyphName('7'.codePointAt(0)), 'seven');
});

test('кириллица получает имя вида uniXXXX', () => {
  eq(glyphName('Ф'.codePointAt(0)), 'uni0424');
  eq(glyphName('я'.codePointAt(0)), 'uni044F');
});

// ─── путь ───────────────────────────────────────────────────────────────────

test('контур переносится в путь opentype целиком', () => {
  const p = toOpenPath(box(300, 400));
  const kinds = p.commands.map((c) => c.type).join('');
  eq(kinds, 'MCCCCZ', `команды ${kinds}: перенос, четыре кривые, замыкание`);
});

test('координаты округляются — единицы шрифта целые', () => {
  const shape = { contours: [{ closed: true, nodes: [
    node(P(1.4, 2.6), P(1.4, 2.6), P(3.5, 4.5), 'corner'),
    node(P(9.7, 8.2), P(6.5, 6.5), P(9.7, 8.2), 'corner'),
  ] }] };
  const p = toOpenPath(shape);
  const all = p.commands.flatMap((c) => [c.x, c.y, c.x1, c.y1, c.x2, c.y2])
    .filter((v) => v !== undefined);
  eq(all.every(Number.isInteger), true, `все координаты целые: ${all.join(',')}`);
});

// ─── отбор ──────────────────────────────────────────────────────────────────

test('на кодовую точку идёт один глиф, первый по порядку', () => {
  const list = [g(65, 600), g(66, 610), g(65, 620)];
  const { chosen, dropped } = pickUnique(list);
  eq(chosen.size, 2);
  eq(chosen.get(65).advance, 600, 'остался первый');
  eq(dropped.length, 1);
});

test('глифы без символа в шрифт не попадают', () => {
  const { chosen } = pickUnique([g(65), { codepoint: null, shape: box(), advance: 1 }]);
  eq(chosen.size, 1);
});

// ─── сборка ─────────────────────────────────────────────────────────────────

test('нулевым глифом идёт .notdef — таково устройство шрифта', () => {
  const { font } = buildFont([g(65)], FM);
  eq(font.glyphs.get(0).name, '.notdef');
});

test('пробел добавляется сам, если его не нашлось на картинке', () => {
  const { font } = buildFont([g(65)], FM, { spaceUnits: 300 });
  const names = [];
  for (let i = 0; i < font.glyphs.length; i += 1) names.push(font.glyphs.get(i).name);
  eq(names.includes('space'), true, `глифы: ${names.join(', ')}`);
  eq(font.glyphs.get(1).advanceWidth, 300);
});

test('глифы идут по возрастанию кодовой точки', () => {
  const { font } = buildFont([g(90), g(65), g(70)], FM);
  const codes = [];
  for (let i = 2; i < font.glyphs.length; i += 1) codes.push(font.glyphs.get(i).unicode);
  eq(codes, [65, 70, 90]);
});

test('метрики шрифта переносятся как есть', () => {
  const { font } = buildFont([g(65)], FM, { familyName: 'Проба' });
  eq(font.unitsPerEm, 1000);
  eq(font.ascender, 735);
  eq(font.descender, -144, 'глубина выносных отрицательна');
  eq(font.names.fontFamily.en, 'Проба');
});

test('нулевая ширина не пропускается — она ломает набор', () => {
  const { font } = buildFont([g(65, 0)], FM);
  eq(font.glyphs.get(font.glyphs.length - 1).advanceWidth >= 1, true);
});

// ─── байты ──────────────────────────────────────────────────────────────────

test('на выходе настоящий OpenType с кубическими кривыми', () => {
  const { font } = buildFont([g(65), g(66)], FM);
  const buf = new Uint8Array(toArrayBuffer(font));
  // Подпись OTTO означает контуры в CFF: ровно то, ради чего кривые кубические.
  eq(String.fromCharCode(...buf.slice(0, 4)), 'OTTO');
  eq(buf.length > 500, true, `размер ${buf.length} байт`);
});

test('буква без символа не попадает в байты', () => {
  const a = toArrayBuffer(buildFont([g(65)], FM).font).byteLength;
  const b = toArrayBuffer(buildFont([g(65), { codepoint: null, shape: box(), advance: 5 }], FM).font).byteLength;
  eq(a, b);
});

// ─── имя файла ──────────────────────────────────────────────────────────────

test('имя файла без сюрпризов', () => {
  eq(fileName('Горная Долина'), 'Горная-Долина.otf');
  eq(fileName('a/b\\c:d'), 'a-b-c-d.otf');
  eq(fileName(''), 'font.otf');
  eq(fileName('Проба', 'woff'), 'Проба.woff');
});


// ─── PostScript-имя ─────────────────────────────────────────────────────────

test('транслитерация сохраняет регистр', () => {
  eq(translit('Горная Долина'), 'Gornaya Dolina');
  eq(translit('щука'), 'shchuka');
  eq(translit('ЩУКА'), 'ShchUKA');
});

test('латиница транслитерацию переживает без изменений', () => {
  eq(translit('Hello World 42'), 'Hello World 42');
});

test('PostScript-имя — печатная латиница без пробелов', () => {
  const n = postScriptName('Горная Долина', 'Regular');
  eq(n, 'GornayaDolina-Regular');
  eq(/^[\x21-\x7E]+$/.test(n), true, 'только печатный ASCII');
});

test('запрещённые спецификацией знаки выбрасываются', () => {
  eq(postScriptName('a[b](c){d}<e>/f%g'), 'abcdefg-Regular');
});

test('пустое имя не даёт пустого PostScript-имени', () => {
  eq(postScriptName('', ''), 'PantographFont-Regular');
  eq(postScriptName('«»'), 'PantographFont-Regular');
});

test('длина PostScript-имени ограничена', () => {
  eq(postScriptName('Ы'.repeat(200)).length <= 63, true);
});

test('в шрифт попадает именно очищенное PostScript-имя', () => {
  const { font } = buildFont([g(65)], FM, { familyName: 'Горная Долина' });
  eq(font.names.postScriptName.en, 'GornayaDolina-Regular');
  eq(font.names.fontFamily.en, 'Горная Долина', 'а семейство остаётся как есть');
});

/** Имя шрифта из Name INDEX таблицы CFF — там и пряталась порча. */
function cffName(buffer) {
  const b = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  for (let i = 0; i < dv.getUint16(4); i += 1) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(...b.slice(rec, rec + 4)) !== 'CFF ') continue;
    const off = dv.getUint32(rec + 8);
    const idx = off + b[off + 2];                 // сразу за заголовком CFF
    const offSize = b[idx + 2];
    const at = (k) => {
      let v = 0;
      for (let j = 0; j < offSize; j += 1) v = (v << 8) | b[idx + 3 + k * offSize + j];
      return v;
    };
    const data = idx + 3 + (dv.getUint16(idx) + 1) * offSize - 1;
    return String.fromCharCode(...b.slice(data + at(0), data + at(1)));
  }
  return null;
}

test('кириллическое название не портит имя внутри CFF', () => {
  // Раньше opentype.js писал такое имя побайтово, с управляющими символами
  // внутри, и браузер отвергал файл целиком.
  const buf = toArrayBuffer(buildFont([g(65)], FM, { familyName: 'Горная Долина' }).font);
  eq(String.fromCharCode(...new Uint8Array(buf, 0, 4)), 'OTTO');
  const name = cffName(buf);
  eq(name, 'GornayaDolina-Regular');
  eq(/^[\x21-\x7E]+$/.test(name), true, `имя в CFF «${name}» — печатный ASCII`);
});

test('латинское название доходит до CFF как есть', () => {
  eq(cffName(toArrayBuffer(buildFont([g(65)], FM, { familyName: 'Pantograph' }).font)),
    'Pantograph-Regular');
});
