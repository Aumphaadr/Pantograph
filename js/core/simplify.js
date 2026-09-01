// core/simplify.js — упрощение полилиний. Чистые функции.

const distSqToSegment = (p, a, b) => {
  let vx = b.x - a.x;
  let vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  let t = len === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  vx = a.x + t * vx - p.x;
  vy = a.y + t * vy - p.y;
  return vx * vx + vy * vy;
};

/** Рамер — Дуглас — Пекер для разомкнутой полилинии. */
export function rdp(points, eps) {
  if (points.length < 3 || eps <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const epsSq = eps * eps;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [i0, i1] = stack.pop();
    let worst = -1;
    let worstD = epsSq;
    for (let i = i0 + 1; i < i1; i += 1) {
      const d = distSqToSegment(points[i], points[i0], points[i1]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([i0, worst], [worst, i1]);
  }

  const out = [];
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * То же для замкнутого контура. Начальная точка выбирается не абы как:
 * берём самую дальнюю от центра тяжести пару, иначе результат зависит от того,
 * с какого пикселя маршевые квадраты начали обход.
 */
export function rdpClosed(points, eps) {
  const n = points.length;
  if (n < 4 || eps <= 0) return points.slice();

  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;

  let a = 0, bestA = -1;
  for (let i = 0; i < n; i += 1) {
    const d = (points[i].x - cx) ** 2 + (points[i].y - cy) ** 2;
    if (d > bestA) { bestA = d; a = i; }
  }
  let b = 0, bestB = -1;
  for (let i = 0; i < n; i += 1) {
    const d = (points[i].x - points[a].x) ** 2 + (points[i].y - points[a].y) ** 2;
    if (d > bestB) { bestB = d; b = i; }
  }

  const arc = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(points[i]);
      if (i === to) break;
    }
    return out;
  };

  const first = rdp(arc(a, b), eps);
  const second = rdp(arc(b, a), eps);
  return first.slice(0, -1).concat(second.slice(0, -1));
}
