// export/font.js — сборка шрифта из глифов.
//
// Кривые кубические с самого начала: такими их строит трассировщик, такими их
// принимает SVG, такими их принимает таблица CFF. Здесь это окупается — ни
// одного преобразования, `curveTo` берёт наши точки как есть.

import opentype from '../../vendor/opentype.module.js';
import { segment, segmentCount } from '../core/path.js';

const r = Math.round;

/** Имя глифа по кодовой точке. Латиница и пробел — по-человечески, прочее — uniXXXX. */
export function glyphName(code) {
  if (code === 32) return 'space';
  if (code >= 65 && code <= 90) return String.fromCodePoint(code);
  if (code >= 97 && code <= 122) return String.fromCodePoint(code);
  if (code >= 48 && code <= 57) return `${['zero', 'one', 'two', 'three', 'four', 'five',
    'six', 'seven', 'eight', 'nine'][code - 48]}`;
  return `uni${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Наш контур → путь opentype. Координаты округляются: единицы шрифта целые. */
export function toOpenPath(shape, Path = opentype.Path) {
  const p = new Path();
  for (const c of shape.contours) {
    if (!c.nodes.length) continue;
    p.moveTo(r(c.nodes[0].p.x), r(c.nodes[0].p.y));
    for (let i = 0; i < segmentCount(c); i += 1) {
      const [, p1, p2, p3] = segment(c, i);
      p.curveTo(r(p1.x), r(p1.y), r(p2.x), r(p2.y), r(p3.x), r(p3.y));
    }
    if (c.closed) p.close();
  }
  return p;
}

/**
 * Отобрать по одному глифу на кодовую точку.
 * Дубликаты — не ошибка (в панграмме про булки «е» встречается пять раз), но в шрифт идёт
 * один. Берём первый по порядку чтения и честно возвращаем список отброшенных,
 * чтобы интерфейс мог о них сказать.
 */
export function pickUnique(glyphs) {
  const chosen = new Map();
  const dropped = [];
  for (const g of glyphs) {
    if (g.codepoint == null) continue;
    if (chosen.has(g.codepoint)) dropped.push(g);
    else chosen.set(g.codepoint, g);
  }
  return { chosen, dropped };
}

/**
 * Собрать шрифт.
 * @param {Array} glyphs — глифы в единицах шрифта (после glyphs/metrics)
 * @param {object} fm — метрики шрифта: upm, ascender, descender
 */
export function buildFont(glyphs, fm, opts = {}) {
  const {
    familyName = 'Пантограф', styleName = 'Regular',
    spaceUnits = 250, designer = '', Font = opentype.Font, Glyph = opentype.Glyph,
    Path: PathCtor = opentype.Path,
  } = opts;

  const { chosen, dropped } = pickUnique(glyphs);

  // Нулевым обязан идти .notdef — таково устройство шрифта, а не наша прихоть.
  const list = [new Glyph({ name: '.notdef', unicode: 0, advanceWidth: r(spaceUnits), path: new PathCtor() })];

  if (!chosen.has(32)) {
    list.push(new Glyph({ name: 'space', unicode: 32, advanceWidth: r(spaceUnits), path: new PathCtor() }));
  }

  for (const [code, g] of [...chosen.entries()].sort((a, b) => a[0] - b[0])) {
    list.push(new Glyph({
      name: glyphName(code),
      unicode: code,
      advanceWidth: Math.max(1, r(g.advance)),
      path: toOpenPath(g.shape, PathCtor),
    }));
  }

  const font = new Font({
    familyName,
    styleName,
    postScriptName: postScriptName(familyName, styleName),
    unitsPerEm: fm.upm,
    ascender: fm.ascender,
    descender: fm.descender,   // отрицательный, как того требуют таблицы
    designer: designer || undefined,
    glyphs: list,
  });

  return { font, dropped, count: list.length };
}

export const toArrayBuffer = (font) => font.toArrayBuffer();

// Кириллица в латиницу — для PostScript-имени. По спецификации оно обязано
// быть печатной латиницей без пробелов и скобок, и это не придирка: opentype.js
// пишет его в CFF побайтово, и «Горная Долина» превращается в кашу
// с управляющими символами, которую отвергает санитайзер шрифтов в браузере.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

export function translit(text) {
  return [...String(text ?? '')].map((ch) => {
    const low = ch.toLowerCase();
    const rep = TRANSLIT[low];
    if (rep === undefined) return ch;
    return ch === low ? rep : cap(rep);
  }).join('');
}

/**
 * PostScript-имя: печатная латиница, без пробелов и знаков, запрещённых
 * спецификацией, не длиннее шестидесяти трёх символов.
 */
export function postScriptName(familyName, styleName = 'Regular') {
  const clean = (t) => translit(t)
    .normalize('NFKD')
    .replace(/[^\x21-\x7E]/g, '')
    .replace(/[[\](){}<>/%]/g, '');
  const fam = clean(familyName) || 'PantographFont';
  const sty = clean(styleName) || 'Regular';
  return `${fam}-${sty}`.slice(0, 63);
}

/**
 * Имя файла без сюрпризов. Буквы любого алфавита остаются — кириллица в имени
 * файла давно никого не смущает, а «Горная Долина», превращённая в «font»,
 * смущает сразу. Выбрасывается только то, что ломает пути.
 */
export function fileName(familyName, ext = 'otf') {
  const base = String(familyName || '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'font';
  return `${base}.${ext}`;
}
