// editor/ops.js — операции редактора. ЧИСТЫЕ функции над Shape, ни строчки DOM.
//
// Из чистоты бесплатно следует и отмена (снимки, а не обратные операции —
// Shape маленький), и тестируемость.

import { node, segment, segmentCount, pointOnSegment } from '../core/path.js';

export const key = (ci, ni) => `${ci}:${ni}`;
export const parseKey = (k) => { const [a, b] = k.split(':'); return { ci: +a, ni: +b }; };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Разбить кубику в параметре t по де Кастельжо. */
export function splitCubic([p0, p1, p2, p3], t) {
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}

const replaceContour = (shape, ci, contour) => ({
  contours: shape.contours.map((c, i) => (i === ci ? contour : c)),
});

const withNodes = (contour, nodes) => ({ ...contour, nodes });

/** Вставить узел на сегменте si в параметре t. Форма кривой не меняется. */
export function insertNode(shape, { ci, si, t }) {
  const c = shape.contours[ci];
  if (!c || t <= 0 || t >= 1) return shape;

  const [left, right] = splitCubic(segment(c, si), t);
  const n = c.nodes.length;
  const iA = si;
  const iB = (si + 1) % n;

  const nodes = c.nodes.map((nd, i) => {
    if (i === iA) return { ...nd, out: left[1] };
    if (i === iB) return { ...nd, in: right[2] };
    return nd;
  });
  nodes.splice(si + 1, 0, node(left[3], left[2], right[1], 'smooth'));
  return replaceContour(shape, ci, withNodes(c, nodes));
}

/** Убрать узлы. Контур, в котором осталось меньше двух узлов, исчезает целиком. */
export function removeNodes(shape, keys) {
  const byContour = new Map();
  for (const k of keys) {
    const { ci, ni } = parseKey(k);
    if (!byContour.has(ci)) byContour.set(ci, new Set());
    byContour.get(ci).add(ni);
  }
  const contours = [];
  shape.contours.forEach((c, ci) => {
    const drop = byContour.get(ci);
    if (!drop) { contours.push(c); return; }
    const nodes = c.nodes.filter((_, ni) => !drop.has(ni));
    if (nodes.length >= 2) contours.push(withNodes(c, nodes));
  });
  return { contours };
}

/** Сдвинуть узлы вместе с их рычагами. */
export function moveNodes(shape, keys, dx, dy, snap = 0) {
  const move = (p) => {
    if (!p) return null;
    const x = p.x + dx;
    const y = p.y + dy;
    return snap > 0
      ? { x: Math.round(x / snap) * snap, y: Math.round(y / snap) * snap }
      : { x, y };
  };
  const set = new Set(keys);
  return {
    contours: shape.contours.map((c, ci) => withNodes(c, c.nodes.map((nd, ni) => {
      if (!set.has(key(ci, ni))) return nd;
      // Рычаги едут за точкой без привязки: иначе гладкий узел ломается.
      const p = move(nd.p);
      const dxa = p.x - nd.p.x;
      const dya = p.y - nd.p.y;
      const shift = (h) => (h ? { x: h.x + dxa, y: h.y + dya } : null);
      return { ...nd, p, in: shift(nd.in), out: shift(nd.out) };
    }))),
  };
}

/**
 * Потянуть за рычаг. У гладкого узла противоположный рычаг разворачивается
 * следом, сохраняя свою длину. С break — узел становится угловым: рычаги
 * расходятся, и это ровно то, что человек имел в виду, нажав Alt.
 */
export function moveHandle(shape, { ci, ni, which }, pt, { break: brk = false } = {}) {
  const c = shape.contours[ci];
  if (!c) return shape;
  const nd = c.nodes[ni];
  if (!nd) return shape;

  const other = which === 'in' ? 'out' : 'in';
  let next = { ...nd, [which]: pt };

  if (brk) {
    next.type = 'corner';
  } else if (nd.type === 'smooth' && nd[other]) {
    const len = dist(nd.p, nd[other]);
    const vx = nd.p.x - pt.x;
    const vy = nd.p.y - pt.y;
    const l = Math.hypot(vx, vy);
    if (l > 1e-9) {
      next[other] = { x: nd.p.x + (vx / l) * len, y: nd.p.y + (vy / l) * len };
    }
  }
  return replaceContour(shape, ci, withNodes(c, c.nodes.map((x, i) => (i === ni ? next : x))));
}

/** Переключить тип узла. Гладкий выпрямляет рычаги по их средней прямой. */
export function setNodeType(shape, { ci, ni }, type) {
  const c = shape.contours[ci];
  if (!c) return shape;
  const nd = c.nodes[ni];
  if (!nd) return shape;
  if (type === 'corner') {
    return replaceContour(shape, ci,
      withNodes(c, c.nodes.map((x, i) => (i === ni ? { ...x, type: 'corner' } : x))));
  }

  // Направление берём по хорде между соседними узлами — так узел садится
  // на естественную касательную, а не на случайную биссектрису рычагов.
  const n = c.nodes.length;
  const prev = c.nodes[(ni - 1 + n) % n];
  const nextN = c.nodes[(ni + 1) % n];
  const vx = nextN.p.x - prev.p.x;
  const vy = nextN.p.y - prev.p.y;
  const l = Math.hypot(vx, vy);
  if (l < 1e-9) return shape;
  const ux = vx / l;
  const uy = vy / l;

  const lenIn = nd.in ? dist(nd.p, nd.in) : l / 4;
  const lenOut = nd.out ? dist(nd.p, nd.out) : l / 4;
  const fixed = {
    ...nd,
    type: 'smooth',
    in: { x: nd.p.x - ux * lenIn, y: nd.p.y - uy * lenIn },
    out: { x: nd.p.x + ux * lenOut, y: nd.p.y + uy * lenOut },
  };
  return replaceContour(shape, ci, withNodes(c, c.nodes.map((x, i) => (i === ni ? fixed : x))));
}

/** Что под курсором: рычаг, узел или кривая. Допуск — в единицах crop-пространства. */
export function hitTest(shape, pt, tol, { selection = new Set() } = {}) {
  // Рычаги только у выделенных узлов — иначе они закрывают собой всё.
  for (let ci = 0; ci < shape.contours.length; ci += 1) {
    const c = shape.contours[ci];
    for (let ni = 0; ni < c.nodes.length; ni += 1) {
      if (!selection.has(key(ci, ni))) continue;
      for (const which of ['in', 'out']) {
        const h = c.nodes[ni][which];
        if (h && dist(h, pt) <= tol) return { kind: 'handle', ci, ni, which };
      }
    }
  }
  for (let ci = 0; ci < shape.contours.length; ci += 1) {
    const c = shape.contours[ci];
    for (let ni = 0; ni < c.nodes.length; ni += 1) {
      if (dist(c.nodes[ni].p, pt) <= tol) return { kind: 'node', ci, ni };
    }
  }
  return null;
}

/** Ближайшая кривая под курсором — для вставки узла. */
export function hitCurve(shape, pt, tol, nearest) {
  let best = null;
  for (let ci = 0; ci < shape.contours.length; ci += 1) {
    const n = nearest(shape.contours[ci], pt);
    if (n.dist <= tol && (!best || n.dist < best.dist)) best = { kind: 'curve', ci, ...n };
  }
  return best;
}

/** Ключи узлов внутри прямоугольника — для выделения рамкой. */
export function nodesInRect(shape, r) {
  const out = [];
  shape.contours.forEach((c, ci) => c.nodes.forEach((nd, ni) => {
    if (nd.p.x >= r.x && nd.p.y >= r.y && nd.p.x <= r.x + r.w && nd.p.y <= r.y + r.h) {
      out.push(key(ci, ni));
    }
  }));
  return out;
}

export { segmentCount, pointOnSegment };
