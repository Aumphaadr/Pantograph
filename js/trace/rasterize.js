// trace/rasterize.js — рендер контура обратно в растр и метрика расхождения.
//
// Качество обводки до сих пор судилось глазами. Здесь оно становится числом:
// контур рисуется в маску тем же ненулевым правилом, что и в SVG, и сверяется
// с бинарной маской, по которой обводили. Расхождение — доля площади
// симметрической разности; отдельно — разница числа компонент, чтобы
// потерянная точка над «ё» не тонула в общем проценте.
//
// Никакого DOM: сканлайн свой, работает и в воркере, и в Node.

import { segment, segmentCount } from '../core/path.js';
import { evalCubic } from '../core/bezier.js';

/** Контур → ломаная. Точек по десять на сегмент — для метрики хватает. */
export function flattenContour(contour, steps = 10) {
  const pts = [];
  const n = segmentCount(contour);
  for (let i = 0; i < n; i += 1) {
    const bez = segment(contour, i);
    for (let t = 0; t < steps; t += 1) pts.push(evalCubic(bez, t / steps));
  }
  if (contour.closed === false && contour.nodes.length) {
    pts.push({ ...contour.nodes[contour.nodes.length - 1].p });
  }
  return pts;
}

/**
 * Shape → бинарная маска w×h. Координаты контура умножаются на scale:
 * контур живёт в пикселях кропа, маска — в увеличенных.
 * Заполнение ненулевым правилом, пиксель берётся по своему центру.
 */
export function rasterizeShape(shape, w, h, scale = 1, steps = 10) {
  const out = new Uint8Array(w * h);
  const edges = [];
  for (const c of shape.contours) {
    if (c.closed === false) continue;      // осевые линии площади не имеют
    const pts = flattenContour(c, steps);
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ay = a.y * scale;
      const by = b.y * scale;
      if (ay !== by) edges.push([a.x * scale, ay, b.x * scale, by]);
    }
  }
  if (!edges.length) return out;

  const xs = [];
  for (let row = 0; row < h; row += 1) {
    const y = row + 0.5;
    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        xs.push({ x: x0 + (x1 - x0) * t, w: y1 > y0 ? 1 : -1 });
      }
    }
    if (!xs.length) continue;
    xs.sort((p, q) => p.x - q.x);
    let wind = 0;
    let from = 0;
    for (const c of xs) {
      const wasIn = wind !== 0;
      wind += c.w;
      if (!wasIn && wind !== 0) from = c.x;
      else if (wasIn && wind === 0) {
        const first = Math.max(0, Math.ceil(from - 0.5));
        const last = Math.min(w - 1, Math.ceil(c.x - 0.5) - 1);
        for (let px = first; px <= last; px += 1) out[row * w + px] = 1;
      }
    }
  }
  return out;
}

/** Пиксели края: единица, у которой хоть один сосед по стороне — ноль. */
export function edgeCount(data, w, h) {
  let edge = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!data[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
        || !data[i - 1] || !data[i + 1] || !data[i - w] || !data[i + w]) edge += 1;
    }
  }
  return edge;
}

/** Число связных кусков не мельче minArea, соседство по четырём сторонам. */
export function countComponents(data, w, h, minArea = 1) {
  const seen = new Uint8Array(w * h);
  const stack = [];
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (!data[i] || seen[i]) continue;
    let size = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      size += 1;
      const x = j % w;
      if (x > 0 && data[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < w - 1 && data[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; stack.push(j + 1); }
      if (j >= w && data[j - w] && !seen[j - w]) { seen[j - w] = 1; stack.push(j - w); }
      if (j + w < data.length && data[j + w] && !seen[j + w]) { seen[j + w] = 1; stack.push(j + w); }
    }
    // Крапина, отсеянная «Мусором мельче», — не потерянный кусок фигуры.
    if (size >= minArea) count += 1;
  }
  return count;
}

/**
 * Расхождение контура с маской, по которой его обводили.
 *
 * Главная мера — drift: площадь симметрической разности, делённая на длину
 * края, то есть СРЕДНИЙ УВОД КРАЯ В ПИКСЕЛЯХ маски. Доля от площади здесь
 * не годится: у тонкоштриховой иконки площадь мала, а периметр велик, и
 * честные полпикселя гуляния края выглядели бы страшными пятнадцатью
 * процентами, а у жирной буквы — невинным одним.
 *
 * @param {{w,h,data}} bin — бинарная маска (Float32 или Uint8, 0/1)
 * @param {object} shape — контур в пикселях КРОПА
 * @param {number} scale — во сколько раз маска крупнее кропа
 * @param {number} minComp — компоненты мельче этого (px маски) не считаются
 */
export function mismatch(bin, shape, scale = 1, minComp = 1) {
  const ren = rasterizeShape(shape, bin.w, bin.h, scale);
  let diff = 0;
  let area = 0;
  for (let i = 0; i < ren.length; i += 1) {
    const a = bin.data[i] > 0 ? 1 : 0;
    area += a;
    if (a !== ren[i]) diff += 1;
  }
  const edge = Math.max(1, edgeCount(bin.data, bin.w, bin.h));
  return {
    diff,
    area,
    edge,
    share: diff / Math.max(1, area),
    drift: diff / edge,
    compBin: countComponents(bin.data, bin.w, bin.h, minComp),
    compRen: countComponents(ren, bin.w, bin.h, minComp),
  };
}
