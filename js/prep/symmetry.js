// prep/symmetry.js — выправление симметричных фигур.
//
// Симметризуется МАСКА, и до порога. Соблазн выпрямлять готовый контур —
// найти ось, спарить узлы, усреднить — обманчив: слева узлов может быть пять,
// справа семь, и всякое сопоставление окажется догадкой. Отражённое и сложенное
// поле даёт симметричный контур по построению, вместе с узлами и рычагами.
//
// Ещё один шаг Mask → Mask, встающий между увеличением и порогом: складывать
// надо полутона, иначе теряется субпиксельный край.

import { createMask } from './mask.js';

/** Значение поля в дробной точке, с линейной интерполяцией по строке. */
function sampleRow(data, w, row, x) {
  if (x < 0 || x > w - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  const a = data[row + i];
  const b = i + 1 <= w - 1 ? data[row + i + 1] : a;
  return a + (b - a) * f;
}

/** Отражение относительно вертикальной оси x = axis. Ось может быть дробной. */
export function mirrorX(mask, axis) {
  const { w, h, data } = mask;
  const out = createMask(w, h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) out.data[row + x] = sampleRow(data, w, row, 2 * axis - x);
  }
  return out;
}

/** Отражение относительно горизонтальной оси y = axis. */
export function mirrorY(mask, axis) {
  const { w, h, data } = mask;
  const out = createMask(w, h);
  for (let y = 0; y < h; y += 1) {
    const sy = 2 * axis - y;
    const i = Math.floor(sy);
    const f = sy - i;
    for (let x = 0; x < w; x += 1) {
      if (sy < 0 || sy > h - 1) { out.data[y * w + x] = 0; continue; }
      const a = data[i * w + x];
      const b = i + 1 <= h - 1 ? data[(i + 1) * w + x] : a;
      out.data[y * w + x] = a + (b - a) * f;
    }
  }
  return out;
}

export const MODES = {
  average: (a, b) => (a + b) / 2,      // форма посередине между половинами
  union: (a, b) => Math.max(a, b),     // всё, что есть хоть на одной
  intersection: (a, b) => Math.min(a, b), // только общее
};

export function combine(a, b, mode = 'average') {
  const fn = MODES[mode] ?? MODES.average;
  const out = createMask(a.w, a.h);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = fn(a.data[i], b.data[i]);
  return out;
}

/**
 * Насколько поле расходится со своим отражением: 0 — идеальная симметрия,
 * 1 — ничего общего. Это число надо показывать человеку ДО применения:
 * несимметричную фигуру симметризация уничтожит.
 */
export function mismatch(a, b) {
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    diff += Math.abs(a.data[i] - b.data[i]);
    total += Math.max(a.data[i], b.data[i]);
  }
  return total > 1e-9 ? diff / total : 0;
}

/** Центр тяжести зажжённого — с него разумно начинать поиск оси. */
export function centroid(mask) {
  let sx = 0;
  let sy = 0;
  let sum = 0;
  for (let y = 0; y < mask.h; y += 1) {
    for (let x = 0; x < mask.w; x += 1) {
      const v = mask.data[y * mask.w + x];
      if (v <= 0) continue;
      sx += x * v; sy += y * v; sum += v;
    }
  }
  return sum > 0 ? { x: sx / sum, y: sy / sum } : { x: (mask.w - 1) / 2, y: (mask.h - 1) / 2 };
}

/**
 * Поиск оси: грубый проход вокруг центра тяжести, затем сужение шага.
 * Считается по увеличенной маске за миллисекунды — перебирать незачем.
 */
function search(mask, mirror, start, span) {
  let best = { axis: start, mismatch: Infinity };
  let step = span / 8;
  let centre = start;

  for (let pass = 0; pass < 5; pass += 1) {
    for (let k = -8; k <= 8; k += 1) {
      const axis = centre + k * step;
      const m = mismatch(mask, mirror(mask, axis));
      if (m < best.mismatch) best = { axis, mismatch: m };
    }
    centre = best.axis;
    step /= 4;
  }
  return best;
}

export const findAxisX = (mask, span = Math.max(4, mask.w * 0.15)) =>
  search(mask, mirrorX, centroid(mask).x, span);

export const findAxisY = (mask, span = Math.max(4, mask.h * 0.15)) =>
  search(mask, mirrorY, centroid(mask).y, span);

/**
 * Насколько у фигуры вообще есть ось симметрии, от 0 до 1.
 *
 * Само расхождение на лучшей оси читать нельзя: у штриха толщиной в пиксель
 * даже полпикселя перекоса дают огромную долю, и симметричная фигура выходит
 * «на 24% несимметричным». Поэтому сравниваем лучшую ось с заведомо неверной,
 * сдвинутой на седьмую часть ширины: если лучшая заметно лучше — ось есть.
 */
export function symmetryScore(mask, mirror, best, span) {
  const bad = Math.min(
    mismatch(mask, mirror(mask, best.axis + span)),
    mismatch(mask, mirror(mask, best.axis - span)),
  );
  if (bad <= 1e-9) return 0;
  return Math.max(0, Math.min(1, 1 - best.mismatch / bad));
}

export const scoreX = (mask) => {
  const best = findAxisX(mask);
  return { ...best, score: symmetryScore(mask, mirrorX, best, Math.max(3, mask.w / 7)) };
};

export const scoreY = (mask) => {
  const best = findAxisY(mask);
  return { ...best, score: symmetryScore(mask, mirrorY, best, Math.max(3, mask.h / 7)) };
};

export const DEFAULTS = { axis: 'none', mode: 'average', shiftX: 0, shiftY: 0 };

/**
 * Симметризовать поле.
 * @returns {{mask, axisX:number|null, axisY:number|null, mismatchX:number, mismatchY:number}}
 */
export function symmetrize(mask, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const want = { x: o.axis === 'x' || o.axis === 'both', y: o.axis === 'y' || o.axis === 'both' };
  const out = {
    mask, axisX: null, axisY: null, mismatchX: 0, mismatchY: 0, scoreX: 0, scoreY: 0,
  };
  if (!want.x && !want.y) return out;

  // atX/atY — готовая ось со стороны. Нужна слоям: каждый ищет свою ось по
  // своим чернилам и находит РАЗНЫЕ, отчего слои расходятся на пиксель-другой.
  // Ось находится один раз по общей маске и навязывается всем.
  if (want.x) {
    const given = Number.isFinite(o.atX);
    const found = given ? null : scoreX(out.mask);
    out.axisX = given ? o.atX : found.axis + (o.shiftX ?? 0);
    out.mismatchX = mismatch(out.mask, mirrorX(out.mask, out.axisX));
    out.scoreX = given ? 0 : found.score;
    out.mask = combine(out.mask, mirrorX(out.mask, out.axisX), o.mode);
  }
  if (want.y) {
    const given = Number.isFinite(o.atY);
    const found = given ? null : scoreY(out.mask);
    out.axisY = given ? o.atY : found.axis + (o.shiftY ?? 0);
    out.mismatchY = mismatch(out.mask, mirrorY(out.mask, out.axisY));
    out.scoreY = given ? 0 : found.score;
    out.mask = combine(out.mask, mirrorY(out.mask, out.axisY), o.mode);
  }
  return out;
}
