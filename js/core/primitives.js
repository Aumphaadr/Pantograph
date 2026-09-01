// core/primitives.js — узнавание простых фигур.
//
// Из растра круг выходит картошкой с лишними узлами, хотя по смыслу это
// четыре точки с симметричными рычагами и одной кривизной. Здесь контур
// сверяется с примитивами и, если ложится в допуск, может быть заменён.
//
// Заменяет не этот модуль: он только СУДИТ. Решение остаётся за человеком —
// иногда картошка и задумана картошкой.

import { flatten, signedArea, node, reverseContour } from './path.js';

/** Рычаг круговой дуги в четверть: столько от радиуса, чтобы кубика легла на окружность. */
export const KAPPA = 0.5522847498307936;

const P = (x, y) => ({ x, y });
const hypot = Math.hypot;

// ─── меры расстояния до фигуры ──────────────────────────────────────────────

const distCircle = (p, c, r) => Math.abs(hypot(p.x - c.x, p.y - c.y) - r);

/** Приближение расстояния до эллипса: невязка, поделённая на длину градиента. */
function distEllipse(p, c, a, b) {
  const u = (p.x - c.x) / a;
  const v = (p.y - c.y) / b;
  const k = u * u + v * v;
  const g = hypot((2 * u) / a, (2 * v) / b);
  return g > 1e-12 ? Math.abs(k - 1) / g : Math.abs(k - 1);
}

/** Знаковое расстояние до прямоугольника со скруглением r (нуль — обычный). */
export function distRoundRect(p, c, halfW, halfH, r) {
  const qx = Math.abs(p.x - c.x) - (halfW - r);
  const qy = Math.abs(p.y - c.y) - (halfH - r);
  const outside = hypot(Math.max(qx, 0), Math.max(qy, 0));
  return Math.abs(outside + Math.min(Math.max(qx, qy), 0) - r);
}

const distSegment = (p, a, b) => {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  let t = len === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return hypot(a.x + t * vx - p.x, a.y + t * vy - p.y);
};

const distPolygon = (p, pts) => {
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = distSegment(p, pts[i], pts[(i + 1) % pts.length]);
    if (d < best) best = d;
  }
  return best;
};

const worst = (pts, fn) => pts.reduce((m, p) => Math.max(m, fn(p)), 0);

// ─── подгонка ───────────────────────────────────────────────────────────────

function boundsOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/** Круг наименьшими квадратами: линейная задача в алгебраической форме. */
export function fitCircle(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y; sz += z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z;
  }
  // Нормальные уравнения для x² + y² + Dx + Ey + F = 0
  const a = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const rhs = [-sxz, -syz, -sz];
  const sol = solve3(a, rhs);
  if (!sol) return null;
  const [d, e, f] = sol;
  const cx = -d / 2;
  const cy = -e / 2;
  const rr = cx * cx + cy * cy - f;
  if (!(rr > 0)) return null;
  return { c: P(cx, cy), r: Math.sqrt(rr) };
}

/** Метод Гаусса для трёх неизвестных. */
function solve3(m, b) {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i += 1) {
    let piv = i;
    for (let j = i + 1; j < 3; j += 1) if (Math.abs(a[j][i]) > Math.abs(a[piv][i])) piv = j;
    if (Math.abs(a[piv][i]) < 1e-12) return null;
    [a[i], a[piv]] = [a[piv], a[i]];
    for (let j = i + 1; j < 3; j += 1) {
      const k = a[j][i] / a[i][i];
      for (let c = i; c < 4; c += 1) a[j][c] -= k * a[i][c];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i -= 1) {
    let sum = a[i][3];
    for (let j = i + 1; j < 3; j += 1) sum -= a[i][j] * x[j];
    x[i] = sum / a[i][i];
  }
  return x;
}

/** Лучший радиус скругления для прямоугольника: перебор с сужением. */
function fitCornerRadius(pts, c, halfW, halfH) {
  const max = Math.min(halfW, halfH);
  let best = { r: 0, err: worst(pts, (p) => distRoundRect(p, c, halfW, halfH, 0)) };
  let step = max / 8;
  let centre = max / 2;
  for (let pass = 0; pass < 4; pass += 1) {
    for (let k = -8; k <= 8; k += 1) {
      const r = Math.max(0, Math.min(max, centre + k * step));
      const err = worst(pts, (p) => distRoundRect(p, c, halfW, halfH, r));
      if (err < best.err) best = { r, err };
    }
    centre = best.r;
    step /= 4;
  }
  return best;
}

/** Равны ли стороны и углы: правильный многоугольник или просто многоугольник. */
export function isRegular(corners, slack = 0.12) {
  const n = corners.length;
  if (n < 3) return false;
  const sides = [];
  const angles = [];
  for (let i = 0; i < n; i += 1) {
    const a = corners[(i - 1 + n) % n];
    const b = corners[i];
    const c = corners[(i + 1) % n];
    sides.push(hypot(c.x - b.x, c.y - b.y));
    const u = { x: b.x - a.x, y: b.y - a.y };
    const v = { x: c.x - b.x, y: c.y - b.y };
    const lu = hypot(u.x, u.y);
    const lv = hypot(v.x, v.y);
    if (lu < 1e-9 || lv < 1e-9) return false;
    angles.push(Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)))));
  }
  const spread = (arr) => {
    const mean = arr.reduce((s2, v) => s2 + v, 0) / arr.length;
    return mean > 1e-9 ? (Math.max(...arr) - Math.min(...arr)) / mean : 0;
  };
  return spread(sides) < slack && spread(angles) < slack * 2;
}

/** Вершины многоугольника: самые дальние от вписанной окружности точки. */
function polygonCorners(pts, n) {
  const b = boundsOf(pts);
  const c = P(b.cx, b.cy);
  const ang = pts.map((p) => Math.atan2(p.y - c.y, p.x - c.x));
  const rad = pts.map((p) => hypot(p.x - c.x, p.y - c.y));
  const corners = [];
  for (let k = 0; k < n; k += 1) {
    const target = -Math.PI + ((k + 0.5) * 2 * Math.PI) / n;
    let bestI = -1;
    let bestR = -Infinity;
    for (let i = 0; i < pts.length; i += 1) {
      const diff = Math.abs(((ang[i] - target + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff < Math.PI / n && rad[i] > bestR) { bestR = rad[i]; bestI = i; }
    }
    if (bestI >= 0) corners.push(pts[bestI]);
  }
  return corners;
}

// ─── построение замены ──────────────────────────────────────────────────────

const closed = (nodes) => ({ closed: true, nodes });

export function circleContour(c, r) {
  const k = r * KAPPA;
  return closed([
    node(P(c.x, c.y - r), P(c.x - k, c.y - r), P(c.x + k, c.y - r)),
    node(P(c.x + r, c.y), P(c.x + r, c.y - k), P(c.x + r, c.y + k)),
    node(P(c.x, c.y + r), P(c.x + k, c.y + r), P(c.x - k, c.y + r)),
    node(P(c.x - r, c.y), P(c.x - r, c.y + k), P(c.x - r, c.y - k)),
  ]);
}

export function ellipseContour(c, a, b) {
  const ka = a * KAPPA;
  const kb = b * KAPPA;
  return closed([
    node(P(c.x, c.y - b), P(c.x - ka, c.y - b), P(c.x + ka, c.y - b)),
    node(P(c.x + a, c.y), P(c.x + a, c.y - kb), P(c.x + a, c.y + kb)),
    node(P(c.x, c.y + b), P(c.x + ka, c.y + b), P(c.x - ka, c.y + b)),
    node(P(c.x - a, c.y), P(c.x - a, c.y + kb), P(c.x - a, c.y - kb)),
  ]);
}

export function rectContour(c, halfW, halfH, r = 0) {
  const x0 = c.x - halfW;
  const x1 = c.x + halfW;
  const y0 = c.y - halfH;
  const y1 = c.y + halfH;
  if (r <= 1e-6) {
    return closed([
      node(P(x0, y0), null, null, 'corner'),
      node(P(x1, y0), null, null, 'corner'),
      node(P(x1, y1), null, null, 'corner'),
      node(P(x0, y1), null, null, 'corner'),
    ]);
  }
  // Обход по часовой (Y вниз). У каждого узла ИСХОДЯЩИЙ рычаг смотрит вперёд
  // по обходу, входящий — назад; прямые стороны обходятся без рычагов вовсе.
  const k = r * KAPPA;
  return closed([
    node(P(x0 + r, y0), P(x0 + r - k, y0), null),
    node(P(x1 - r, y0), null, P(x1 - r + k, y0)),
    node(P(x1, y0 + r), P(x1, y0 + r - k), null),
    node(P(x1, y1 - r), null, P(x1, y1 - r + k)),
    node(P(x1 - r, y1), P(x1 - r + k, y1), null),
    node(P(x0 + r, y1), null, P(x0 + r - k, y1)),
    node(P(x0, y1 - r), P(x0, y1 - r + k), null),
    node(P(x0, y0 + r), null, P(x0, y0 + r - k)),
  ]);
}

export const polygonContour = (pts) =>
  closed(pts.map((p) => node(P(p.x, p.y), null, null, 'corner')));

// ─── суд ────────────────────────────────────────────────────────────────────

export const NAMES = {
  circle: 'круг',
  ellipse: 'эллипс',
  rect: 'прямоугольник',
  roundRect: 'скруглённый прямоугольник',
  polygon: 'многоугольник',
};

const SIDE_NAMES = ['', '', '', 'треугольник', 'четырёхугольник', 'пятиугольник',
  'шестиугольник', 'семиугольник', 'восьмиугольник'];

/** Человеческое имя совпадения. */
export function nameOf(match) {
  if (!match) return '';
  if (match.kind !== 'polygon') return NAMES[match.kind];
  const base = SIDE_NAMES[match.sides] || `${match.sides}-угольник`;
  return match.regular ? `правильный ${base}` : base;
}

/**
 * На что похож контур. Порядок от простого к сложному, побеждает первый
 * уложившийся в допуск: иначе круг всякий раз признавался бы эллипсом
 * с равными осями.
 *
 * Мера считается по УПЛОЩЁННОМУ контуру, а не по узлам: узлы стоят где попало,
 * а форма — это кривая. Допуск — в тех же единицах, что и координаты.
 */
export function detect(contour, share = 0.03, { steps = 24, absolute = null } = {}) {
  const pts = flatten(contour, steps);
  if (pts.length < 8) return null;
  const b = boundsOf(pts);
  if (b.w < 1e-6 || b.h < 1e-6) return null;
  // Допуск соразмерен САМОМУ КОНТУРУ, а не кропу: у рамки в пятьсот пикселей
  // и у кружка в полсотни «похоже» означает разную абсолютную точность.
  const tol = absolute ?? share * Math.max(b.w, b.h);
  const c = P(b.cx, b.cy);
  const out = [];

  const circle = fitCircle(pts);
  if (circle && circle.r > 0) {
    out.push({ kind: 'circle', error: worst(pts, (p) => distCircle(p, circle.c, circle.r)),
      make: () => circleContour(circle.c, circle.r), params: circle });
  }

  const a = b.w / 2;
  const bb = b.h / 2;
  out.push({ kind: 'ellipse', error: worst(pts, (p) => distEllipse(p, c, a, bb)),
    make: () => ellipseContour(c, a, bb), params: { c, a, b: bb } });

  out.push({ kind: 'rect', error: worst(pts, (p) => distRoundRect(p, c, a, bb, 0)),
    make: () => rectContour(c, a, bb, 0), params: { c, halfW: a, halfH: bb } });

  const round = fitCornerRadius(pts, c, a, bb);
  if (round.r > 1e-6) {
    out.push({ kind: 'roundRect', error: round.err,
      make: () => rectContour(c, a, bb, round.r), params: { c, halfW: a, halfH: bb, r: round.r } });
  }

  for (let n = 3; n <= 8; n += 1) {
    const corners = polygonCorners(pts, n);
    if (corners.length !== n) continue;
    out.push({ kind: 'polygon', sides: n, regular: isRegular(corners),
      error: worst(pts, (p) => distPolygon(p, corners)),
      make: () => polygonContour(corners), params: { corners } });
  }

  const order = ['circle', 'ellipse', 'rect', 'roundRect', 'polygon'];
  const fits = out.filter((o) => o.error <= tol)
    .sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
  const best = fits[0] ?? out.reduce((m, o) => (o.error < m.error ? o : m), out[0]);
  return { ...best, fits: fits.length > 0, tol, name: nameOf(best) };
}

/** Заменить контур примитивом, сохранив направление обхода. */
export function apply(contour, match) {
  const next = match.make();
  const before = signedArea(flatten(contour, 8));
  const after = signedArea(flatten(next, 8));
  return before * after < 0 ? reverseContour(next) : next;
}
