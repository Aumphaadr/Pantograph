import {
  parseLines, autoAssign, roster, coverage, setCode, label, ALPHABETS,
} from '../js/glyphs/assign.js';

/** Глифы в порядке чтения: index — сквозной, row — номер строки. */
const glyphs = (rows) => {
  const out = [];
  rows.forEach((n, row) => {
    for (let i = 0; i < n; i += 1) out.push({ index: out.length, row });
  });
  return out;
};

const codesOf = (res) => res.codes.map(label).join('');

// ─── разбор текста ──────────────────────────────────────────────────────────

test('parseLines делит по переводам строки', () => {
  eq(parseLines('АБ\nВГ').map((l) => l.map((c) => c.ch).join('')), ['АБ', 'ВГ']);
});

test('пустые строки выбрасываются — букв в них нет', () => {
  eq(parseLines('АБ\n\n\nВГ\n').length, 2);
});

test('пробел помечается, но остаётся в строке', () => {
  const line = parseLines('А Б')[0];
  eq(line.length, 3);
  eq(line.map((c) => c.space), [false, true, false]);
});

test('parseLines переживает разные переводы строк', () => {
  eq(parseLines('А\r\nБ\rВ').length, 3);
});

test('код точки берётся правильно для не-ASCII', () => {
  eq(parseLines('Ж')[0][0].code, 'Ж'.codePointAt(0));
});

test('пустой ввод даёт ноль строк', () => {
  eq(parseLines('').length, 0);
  eq(parseLines(null).length, 0);
});

// ─── привязка ───────────────────────────────────────────────────────────────

test('привязка идёт в порядке чтения', () => {
  const res = autoAssign(glyphs([3]), parseLines('АБВ'));
  eq(codesOf(res), 'АБВ');
});

test('пробел не потребляет глиф, но считается', () => {
  const res = autoAssign(glyphs([5]), parseLines('АБ ВГ'));
  eq(codesOf(res), 'АБВГ');
  eq(res.spaces, [1], 'пробел запомнен для ширины пробельного глифа');
});

test('несколько строк ложатся на несколько рядов', () => {
  const res = autoAssign(glyphs([2, 3]), parseLines('АБ\nВГД'));
  eq(codesOf(res), 'АБВГД');
});

test('лишние глифы остаются без символа', () => {
  const res = autoAssign(glyphs([4]), parseLines('АБ'));
  eq(res.codes.map((c) => c == null), [false, false, true, true]);
});

test('лишние символы попадают в остаток', () => {
  const res = autoAssign(glyphs([2]), parseLines('АБВГ'));
  eq(res.spare.map((s) => s.ch), ['В', 'Г']);
});

test('расхождение числа строк видно в цифрах', () => {
  const res = autoAssign(glyphs([3]), parseLines('АБВ\nГДЕ'));
  eq([res.rowCount, res.lineCount], [1, 2]);
});

test('строка без текста оставляет свой ряд пустым', () => {
  const res = autoAssign(glyphs([2, 2]), parseLines('АБ'));
  eq(codesOf(res), 'АБ');
  eq(res.codes.slice(2), [null, null]);
});

// ─── разбор набора ──────────────────────────────────────────────────────────

test('roster показывает, кто чем занят', () => {
  const g = glyphs([3]);
  const { codes } = autoAssign(g, parseLines('АБВ'));
  const r = roster(g, codes);
  eq(r.covered.size, 3);
  eq(r.duplicates.length, 0);
  eq(r.unassigned.length, 0);
});

test('дубликаты видны списком', () => {
  // «ГОРНАЯ ДОЛИНА»: А, Н и О встречаются дважды
  const g = glyphs([12]);
  const { codes } = autoAssign(g, parseLines('ГОРНАЯ ДОЛИНА'));
  const r = roster(g, codes);
  eq(r.duplicates.map(([c]) => label(c)).sort(), ['А', 'Н', 'О']);
  eq(r.duplicates.every(([, list]) => list.length === 2), true);
  eq(r.covered.size, 9, 'девять разных букв на двенадцать глифов');
});

test('глифы без символа перечислены', () => {
  const g = glyphs([4]);
  const { codes } = autoAssign(g, parseLines('АБ'));
  eq(roster(g, codes).unassigned, [2, 3]);
});

// ─── покрытие алфавита ──────────────────────────────────────────────────────

test('покрытие показывает недостающие буквы', () => {
  const g = glyphs([12]);
  const { codes } = autoAssign(g, parseLines('ГОРНАЯ ДОЛИНА'));
  const { covered } = roster(g, codes);
  const cov = coverage(covered, ALPHABETS['Русские прописные']);
  eq(cov.have.join(''), 'АГДИЛНОРЯ');
  eq(cov.missing.includes('Ё'), true, 'Ё среди недостающих');
  eq(cov.have.length + cov.missing.length, 33, 'весь алфавит разобран');
});

test('полное покрытие не оставляет пропусков', () => {
  const alpha = ALPHABETS.Цифры;
  const g = glyphs([10]);
  const { codes } = autoAssign(g, parseLines(alpha));
  const cov = coverage(roster(g, codes).covered, alpha);
  eq(cov.missing.length, 0);
  eq(cov.ratio, 1);
});

test('в алфавитах нет повторов и они непустые', () => {
  for (const [name, alpha] of Object.entries(ALPHABETS)) {
    eq(new Set([...alpha]).size, [...alpha].length, `${name}: без повторов`);
    eq(alpha.length > 0, true, `${name}: непустой`);
  }
});

// ─── правка руками ──────────────────────────────────────────────────────────

test('setCode меняет один символ, не трогая остальных', () => {
  const g = glyphs([3]);
  const { codes } = autoAssign(g, parseLines('АБВ'));
  const next = setCode(codes, 1, 'Я');
  eq(next.map(label).join(''), 'АЯВ');
  eq(codes.map(label).join(''), 'АБВ', 'исходный массив не тронут');
});

test('пустая строка снимает привязку', () => {
  const g = glyphs([2]);
  const { codes } = autoAssign(g, parseLines('АБ'));
  eq(setCode(codes, 0, '')[0], null);
});

test('из введённого берётся первый символ', () => {
  eq(label(setCode([null], 0, 'Абв')[0]), 'А');
});
