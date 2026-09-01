// core/path.js — контуры. На этом типе говорят все: трассировщик, упрощатель,
// редактор и сборщик шрифта.
//
//   Node    = { p, in, out, type: 'smooth'|'corner' }   рычаги АБСОЛЮТНЫЕ
//   Contour = { closed, nodes: Node[] }
//   Shape   = { contours: Contour[] }
//
// Рычаги абсолютны, а не относительны: так проще попадание курсором и тяга,
// а transform() всё равно двигает все три точки узла разом.

export const node = (p, inp = null, out = null, type = 'smooth') => ({ p, in: inp, out, type });

export const emptyShape = () => ({ contours: [] });

/** Исходящий рычаг узла; если его нет — сама точка. */
const outOf = (n) => n.out ?? n.p;
const inOf = (n) => n.in ?? n.p;

/** Кубический сегмент между соседними узлами. */
export function segment(contour, i) {
  const n = contour.nodes.length;
  const a = contour.nodes[i];
  const b = contour.nodes[(i + 1) % n];
  return [a.p, outOf(a), inOf(b), b.p];
}

export function segmentCount(contour) {
  return contour.closed ? contour.nodes.length : contour.nodes.length - 1;
}

/** Ломаная по контуру. steps — на сегмент. Для площади, попадания и показа. */
export function flatten(contour, steps = 12) {
  const out = [];
  for (let i = 0; i < segmentCount(contour); i += 1) {
    const [p0, p1, p2, p3] = segment(contour, i);
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const u = 1 - t;
      out.push({
        x: p0.x * u ** 3 + 3 * p1.x * u * u * t + 3 * p2.x * u * t * t + p3.x * t ** 3,
        y: p0.y * u ** 3 + 3 * p1.y * u * u * t + 3 * p2.y * u * t * t + p3.y * t ** 3,
      });
    }
  }
  return out;
}

/** Площадь со знаком в crop-пространстве (Y вниз): по часовой — положительная. */
export function signedArea(polygon) {
  let a = 0;
  for (let i = 0, n = polygon.length; i < n; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function contourArea(contour) {
  return signedArea(flatten(contour));
}

export function pointInPolygon(poly, pt) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y)
      && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Развернуть обход: порядок узлов задом наперёд, рычаги местами. */
export function reverseContour(contour) {
  const nodes = contour.nodes.slice().reverse()
    .map((n) => ({ p: n.p, in: n.out, out: n.in, type: n.type }));
  // После разворота первый узел должен остаться первым по точке, а не по рычагам.
  return { ...contour, nodes: nodes.slice(-1).concat(nodes.slice(0, -1)) };
}

/**
 * Привести обход к норме: внешние контуры по часовой, дырки против.
 * После переворота Y в glyph-пространстве это даёт то, чего ждёт CFF.
 * Вызывается после трассировки и после любой операции редактора,
 * способной развернуть контур.
 */
export function orient(shape) {
  const polys = shape.contours.map((c) => flatten(c));
  const contours = shape.contours.map((c, i) => {
    let depth = 0;
    for (let j = 0; j < polys.length; j += 1) {
      if (i !== j && pointInPolygon(polys[j], polys[i][0])) depth += 1;
    }
    const wantPositive = depth % 2 === 0;
    const area = signedArea(polys[i]);
    return (area > 0) === wantPositive ? c : reverseContour(c);
  });
  return { contours };
}

export function transform(shape, fn) {
  return {
    contours: shape.contours.map((c) => ({
      ...c,
      nodes: c.nodes.map((n) => ({
        p: fn(n.p),
        in: n.in ? fn(n.in) : null,
        out: n.out ? fn(n.out) : null,
        type: n.type,
      })),
    })),
  };
}

export const scaleShape = (shape, k) => transform(shape, (p) => ({ x: p.x * k, y: p.y * k }));

export const translateShape = (shape, dx, dy) =>
  transform(shape, (p) => ({ x: p.x + dx, y: p.y + dy }));

export function bounds(shape) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of shape.contours) {
    for (const p of flatten(c)) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Точка на кубическом сегменте контура. */
export function pointOnSegment(contour, si, t) {
  const [p0, p1, p2, p3] = segment(contour, si);
  const u = 1 - t;
  return {
    x: p0.x * u ** 3 + 3 * p1.x * u * u * t + 3 * p2.x * u * t * t + p3.x * t ** 3,
    y: p0.y * u ** 3 + 3 * p1.y * u * u * t + 3 * p2.y * u * t * t + p3.y * t ** 3,
  };
}

/**
 * Ближайшая к pt точка контура: грубая выборка плюс несколько шагов сужения.
 * Нужна, чтобы попадать курсором по кривой между узлами.
 */
export function nearestOnContour(contour, pt, samples = 16) {
  let best = { si: 0, t: 0, dist: Infinity, point: null };
  const d2 = (a) => (a.x - pt.x) ** 2 + (a.y - pt.y) ** 2;

  for (let si = 0; si < segmentCount(contour); si += 1) {
    let bt = 0;
    let bd = Infinity;
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const d = d2(pointOnSegment(contour, si, t));
      if (d < bd) { bd = d; bt = t; }
    }
    let step = 1 / samples;
    for (let k = 0; k < 12; k += 1) {
      step /= 2;
      for (const t of [bt - step, bt + step]) {
        if (t < 0 || t > 1) continue;
        const d = d2(pointOnSegment(contour, si, t));
        if (d < bd) { bd = d; bt = t; }
      }
    }
    if (bd < best.dist) {
      best = { si, t: bt, dist: bd, point: pointOnSegment(contour, si, bt) };
    }
  }
  best.dist = Math.sqrt(best.dist);
  return best;
}

export function countNodes(shape) {
  return shape.contours.reduce((s, c) => s + c.nodes.length, 0);
}
