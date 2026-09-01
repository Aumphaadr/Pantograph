// glyphs/metrics.js — из crop-пространства в glyph-пространство.
//
// ЕДИНСТВЕННОЕ место во всей системе, где переворачивается ось Y (инвариант 2).
// В кропе Y растёт вниз, в шрифте — вверх от базовой линии.
//
// Базовую линию и высоты из картинки не вывести надёжно, поэтому их тянет
// человек. Здесь только догадка для начального положения и вся арифметика.

import { transform, bounds } from '../core/path.js';

export const DEFAULTS = {
  upm: 1000,        // единиц на кегельную площадку
  capUnits: 700,    // во что превращается высота прописных
  spaceUnits: 250,  // ширина пробела, если её нечем измерить
};

/** Медиана. Устойчивее среднего: одна кривая буква не утащит весь шрифт. */
export function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Базовая линия каждой строки: медиана низов внутри строки. */
export function rowBaselines(glyphs) {
  const byRow = new Map();
  for (const g of glyphs) {
    const r = g.row ?? 0;
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push(g.bbox.y + g.bbox.h);
  }
  return new Map([...byRow.entries()].map(([r, bottoms]) => [r, median(bottoms)]));
}

/**
 * Догадка о направляющих. Значения — Y в crop-пространстве, меньше значит выше.
 *
 * У КАЖДОЙ СТРОКИ своя базовая линия, а высоты — общие смещения от неё.
 * Иначе на шрифтовом листе из шести рядов медиана низов ложится между рядами,
 * а «глубина выносных» оказывается расстоянием до нижнего ряда: у листа
 * 1254 px выходило −4023 единицы вместо полутора сотен.
 *
 * Четыре направляющие, которые тянет человек, описывают ОДНУ строку —
 * самую населённую, у неё статистика надёжнее. Остальные следуют за своими
 * базовыми линиями сами.
 */
export function guessGuides(glyphs) {
  if (!glyphs.length) {
    return { baseline: 0, xHeight: 0, capHeight: 0, descender: 0, rows: new Map() };
  }
  const rows = rowBaselines(glyphs);
  const base = (g) => rows.get(g.row ?? 0) ?? 0;

  // Смещения считаются от базовой линии СВОЕЙ строки — тогда шесть рядов
  // дают ту же статистику, что и один.
  const heights = glyphs.map((g) => base(g) - g.bbox.y).sort((a, b) => a - b);
  const depth = Math.max(0, ...glyphs.map((g) => g.bbox.y + g.bbox.h - base(g)));

  let cut = -1;
  let widest = 0;
  for (let i = 1; i < heights.length; i += 1) {
    const gap = heights[i] - heights[i - 1];
    if (gap > widest) { widest = gap; cut = i; }
  }
  const span = heights[heights.length - 1] - heights[0];
  const split = span > 0 && widest > span * 0.35 && cut > 0;

  // Высокие — прописные, низкие — строчные. Ряд отсортирован по возрастанию.
  const capOffset = median(split ? heights.slice(cut) : heights);
  const xOffset = split
    ? median(heights.slice(0, cut))
    // Все буквы одного роста — строчных нет. Ставим по обычному соотношению,
    // чтобы направляющая была осмысленной, а не легла на базовую.
    : capOffset * 0.72;

  // Эталон — самая населённая строка.
  const counts = new Map();
  for (const g of glyphs) counts.set(g.row ?? 0, (counts.get(g.row ?? 0) ?? 0) + 1);
  const mainRow = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const baseline = rows.get(mainRow) ?? 0;

  return {
    baseline,
    capHeight: baseline - capOffset,
    xHeight: baseline - xOffset,
    descender: baseline + depth,
    rows,
  };
}

/** Привести направляющие к порядку: прописные выше строчных, выносные ниже базовой. */
export function normalizeGuides(g) {
  const capHeight = Math.min(g.capHeight, g.baseline - 1);
  const xHeight = Math.max(capHeight, Math.min(g.xHeight, g.baseline - 0.5));
  return {
    capHeight,
    xHeight,
    baseline: g.baseline,
    descender: Math.max(g.descender, g.baseline),
    rows: g.rows ?? new Map(),
  };
}

/** Множитель перевода: сколько единиц шрифта в одном пикселе кропа. */
export function scaleFor(guides, opts = {}) {
  const { capUnits } = { ...DEFAULTS, ...opts };
  const capPx = guides.baseline - guides.capHeight;
  return capPx > 1e-6 ? capUnits / capPx : 1;
}

/**
 * Контур в glyph-пространство: начало на базовой линии у левого края буквы,
 * ось Y вверх.
 *
 * Переворот Y меняет направление обхода, и это ровно то, что нужно: в кропе
 * внешний контур идёт по часовой, а CFF ждёт против. Пересчитывать обход
 * после переворота НЕ надо — он выправляется сам.
 */
export function toGlyphSpace(shape, guides, { originX = 0, lsb = 0, baseline, ...opts } = {}) {
  const k = scaleFor(guides, opts);
  // Масштаб общий (по эталонной строке), а базовая линия — своей строки.
  const base = Number.isFinite(baseline) ? baseline : guides.baseline;
  return transform(shape, (p) => ({
    x: (p.x - originX) * k + lsb,
    y: (base - p.y) * k,
  }));
}

/**
 * Боковые отступы по картинке: между соседними буквами в строке измеряются
 * зазоры, берётся медиана, делится пополам. Это лучше числа с потолка —
 * рисовавший иконку уже выбрал расстояние между буквами, надо его прочитать.
 */
export function measureGaps(glyphs) {
  const rows = new Map();
  for (const g of glyphs) {
    if (!rows.has(g.row)) rows.set(g.row, []);
    rows.get(g.row).push(g);
  }
  const gaps = [];
  for (const row of rows.values()) {
    const line = [...row].sort((a, b) => a.bbox.x - b.bbox.x);
    for (let i = 1; i < line.length; i += 1) {
      gaps.push(line[i].bbox.x - (line[i - 1].bbox.x + line[i - 1].bbox.w));
    }
  }
  return gaps;
}

/** Медианный зазор между буквами и медиана «широких» зазоров — это пробелы. */
export function guessSpacing(glyphs, guides, opts = {}) {
  const k = scaleFor(guides, opts);
  const gaps = measureGaps(glyphs).filter((v) => v >= 0);
  const letter = median(gaps);
  const wide = gaps.filter((v) => v > letter * 2.2);
  return {
    sideBearing: Math.round((letter / 2) * k),
    spaceUnits: wide.length
      ? Math.round(median(wide) * k)
      : ({ ...DEFAULTS, ...opts }).spaceUnits,
  };
}

/** Один глиф целиком: контур в единицах шрифта плюс его ширины. */
export function buildGlyph(glyph, guides, opts = {}) {
  const o = { ...DEFAULTS, sideBearing: 0, ...opts };
  const k = scaleFor(guides, o);
  const shape = toGlyphSpace(glyph.shape, guides, {
    originX: glyph.bbox.x,
    lsb: o.sideBearing,
    baseline: guides.rows?.get(glyph.row ?? 0),
    ...o,
  });
  const b = bounds(shape);
  return {
    codepoint: glyph.codepoint ?? null,
    shape,
    lsb: o.sideBearing,
    rsb: o.sideBearing,
    advance: Math.round(glyph.bbox.w * k + o.sideBearing * 2),
    bbox: b,
  };
}

/** Метрики шрифта в целом. */
export function fontMetrics(guides, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const k = scaleFor(guides, o);
  const cap = Math.round((guides.baseline - guides.capHeight) * k);
  return {
    upm: o.upm,
    scale: k,
    capHeight: cap,
    xHeight: Math.round((guides.baseline - guides.xHeight) * k),
    // Восходящая чуть выше прописных: иначе строки лепятся друг к другу.
    ascender: Math.round(cap * 1.05),
    descender: -Math.round((guides.descender - guides.baseline) * k),
  };
}
