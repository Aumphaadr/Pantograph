// glyphs/assign.js — какая буква где.
//
// Текст вводит человек, а не OCR: на декоративном шрифте распознавание врёт
// увереннее, чем помогает, и врёт молча. Человек смотрит на картинку и печатает
// то, что видит, — это занимает пять секунд и не ошибается.
//
// Сопоставление идёт в порядке чтения: строки сверху вниз, внутри строки слева
// направо. Пробел глифа не потребляет, но запоминается — на этапе метрик по
// нему считается ширина пробела.

/** Текст → строки символов. Пустые строки выбрасываются: букв в них нет. */
export function parseLines(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => [...line].map((ch) => ({
      ch,
      code: ch.codePointAt(0),
      space: /\s/u.test(ch),
    })))
    .filter((chars) => chars.some((c) => !c.space));
}

/** Глифы по строкам, в порядке чтения. */
function byRows(glyphs) {
  const map = new Map();
  for (const g of glyphs) {
    if (!map.has(g.row)) map.set(g.row, []);
    map.get(g.row).push(g);
  }
  return [...map.keys()].sort((a, b) => a - b).map((k) => map.get(k));
}

/**
 * Начальная привязка: строка текста к строке глифов, символ к глифу.
 * Расхождения не выравниваются хитростью — они возвращаются как есть,
 * чтобы человек увидел их и поправил руками.
 *
 * @returns {{codes:(number|null)[], spare:object[], rowCount:number, lineCount:number,
 *            spaces:number[]}}
 */
export function autoAssign(glyphs, lines) {
  const rows = byRows(glyphs);
  const codes = new Array(glyphs.length).fill(null);
  const spare = [];    // символы, которым не хватило глифа
  const spaces = [];   // сколько пробелов в каждой строке

  rows.forEach((rowGlyphs, i) => {
    const chars = lines[i] ?? [];
    const letters = chars.filter((c) => !c.space);
    spaces.push(chars.length - letters.length);
    rowGlyphs.forEach((g, j) => {
      if (j < letters.length) codes[g.index] = letters[j].code;
    });
    for (let j = rowGlyphs.length; j < letters.length; j += 1) {
      spare.push({ row: i, ...letters[j] });
    }
  });

  return { codes, spare, rowCount: rows.length, lineCount: lines.length, spaces };
}

/**
 * Что вышло: кто чем занят, где дубликаты, кто остался без символа.
 * Дубликаты — не ошибка сама по себе: в панграмме про французские булки «е» встречается
 * дважды. Но в шрифт идёт один глиф на кодовую точку, поэтому выбрать придётся.
 */
export function roster(glyphs, codes) {
  const covered = new Map();
  const unassigned = [];

  for (const g of glyphs) {
    const code = codes[g.index];
    if (code == null) { unassigned.push(g.index); continue; }
    if (!covered.has(code)) covered.set(code, []);
    covered.get(code).push(g.index);
  }

  const duplicates = [...covered.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => a[0] - b[0]);

  return { covered, duplicates, unassigned };
}

export const ALPHABETS = {
  'Русские прописные': 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
  'Русские строчные': 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
  'Латинские прописные': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'Латинские строчные': 'abcdefghijklmnopqrstuvwxyz',
  Цифры: '0123456789',
  Знаки: '.,:;!?()«»-—',
};

/**
 * Насколько набор покрывает алфавит.
 * Ради этого затевался проект: если кроп содержит лишь часть символов, человек
 * должен увидеть, каких именно не хватает, — и пойти сгенерировать картинку
 * с ними, а не гадать.
 */
export function coverage(covered, alphabet) {
  const have = [];
  const missing = [];
  for (const ch of alphabet) {
    (covered.has(ch.codePointAt(0)) ? have : missing).push(ch);
  }
  return { have, missing, ratio: alphabet.length ? have.length / [...alphabet].length : 1 };
}

/** Задать символ одному глифу. Пустая строка снимает привязку. */
export function setCode(codes, index, ch) {
  const next = codes.slice();
  next[index] = ch ? [...ch][0].codePointAt(0) : null;
  return next;
}

export const label = (code) => (code == null ? '' : String.fromCodePoint(code));
