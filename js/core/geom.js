// core/geom.js — чистая геометрия прямоугольников.
// Никакого DOM, никаких экранных координат: все точки здесь — image-пространство.

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Прямоугольник по двум углам, в любом порядке. */
export function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** К целым пикселям исходника. Округляем границы, а не размер: кроп не должен «плыть». */
export function roundRect(r) {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
}

/** Обрезать по границам картинки (двигаются края). Для изменения размера. */
export function clipRect(r, bounds) {
  const x0 = Math.max(0, Math.min(r.x, bounds.w));
  const y0 = Math.max(0, Math.min(r.y, bounds.h));
  const x1 = Math.max(0, Math.min(r.x + r.w, bounds.w));
  const y1 = Math.max(0, Math.min(r.y + r.h, bounds.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Вдвинуть внутрь границ целиком (двигается сам прямоугольник). Для перетаскивания. */
export function clampRectInside(r, bounds) {
  const w = Math.min(r.w, bounds.w);
  const h = Math.min(r.h, bounds.h);
  return {
    x: Math.max(0, Math.min(r.x, bounds.w - w)),
    y: Math.max(0, Math.min(r.y, bounds.h - h)),
    w,
    h,
  };
}

export function moveRect(r, dx, dy, bounds) {
  return clampRectInside({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, bounds);
}

/** Восемь точек-ручек по краям и углам. */
export function handlePoints(r) {
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  return {
    nw: { x: r.x, y: r.y }, n: { x: mx, y: r.y }, ne: { x: x1, y: r.y },
    e:  { x: x1,  y: my  }, se: { x: x1, y: y1 }, s:  { x: mx, y: y1 },
    sw: { x: r.x, y: y1  }, w:  { x: r.x, y: my },
  };
}

/** Ближайшая ручка в пределах tol, иначе null. tol — в единицах image-пространства. */
export function hitHandle(r, p, tol) {
  const pts = handlePoints(r);
  let best = null;
  let bestD = tol * tol;
  for (const k of HANDLES) {
    const dx = pts[k].x - p.x;
    const dy = pts[k].y - p.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = k; }
  }
  return best;
}

export function pointInRect(r, p) {
  return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
}

/** Потянуть за ручку. Прямоугольник может вывернуться — normRect это чинит. */
export function resizeRect(r, handle, p, bounds) {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  if (handle.includes('w')) x0 = p.x;
  if (handle.includes('e')) x1 = p.x;
  if (handle.includes('n')) y0 = p.y;
  if (handle.includes('s')) y1 = p.y;
  return clipRect(normRect({ x: x0, y: y0 }, { x: x1, y: y1 }), bounds);
}

/** Масштаб, при котором картинка целиком влезает в окно с отступом pad (в px окна). */
export function fitScale(content, view, pad = 24) {
  const w = Math.max(1, view.w - pad * 2);
  const h = Math.max(1, view.h - pad * 2);
  if (content.w <= 0 || content.h <= 0) return 1;
  return Math.min(w / content.w, h / content.h);
}
