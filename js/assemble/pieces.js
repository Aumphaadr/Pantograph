// assemble/pieces.js — ломаная осевой → цепочка кусков «отрезок | дуга».
//
// Монолайн-иконка рисуется циркулем и линейкой: скруглённый прямоугольник —
// четыре отрезка и четыре четверти окружности, «D» уха робота — отрезок, дуга,
// отрезок. Кубики Безье такое описывают, но не называют; здесь называется.
//
// Разбор — наименьшим числом кусков (см. segmentChain); дуга чуть дороже
// отрезка: на прямой с шумом окружность огромного радиуса «ляжет» всегда,
// и без этого правила прямые уходили бы в дуги.

import { fitCircle } from '../core/primitives.js';
import { dist } from '../core/bezier.js';

const TAU = Math.PI * 2;

/** Расстояние от точки до отрезка ab. */
export function distToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 0 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y);
}

/** Отрезок по точкам i..j: хорда и наибольшее отклонение внутренних точек. */
export function linePiece(pts, i, j) {
  const a = pts[i];
  const b = pts[j];
  let err = 0;
  for (let k = i + 1; k < j; k += 1) {
    const d = distToSegment(pts[k], a, b);
    if (d > err) err = d;
  }
  return { kind: 'line', a: { ...a }, b: { ...b }, err, from: i, to: j };
}

const angleOf = (c, p) => Math.atan2(p.y - c.y, p.x - c.x);
/** Разница углов в (−π, π]. */
const turn = (from, to) => {
  let d = to - from;
  while (d <= -Math.PI) d += TAU;
  while (d > Math.PI) d -= TAU;
  return d;
};

/**
 * Дуга по точкам i..j: окружность наименьшими квадратами, концы — на точках,
 * направление — по середине. Ошибка — наибольшее отклонение от окружности,
 * плюс требование монотонности: точки идут по дуге в одну сторону, иначе это
 * не дуга, а что-то вроде «S».
 *
 * @returns {null|{kind:'arc', c, r, a, b, a0, sweep, err, from, to}}
 *   sweep — знаковый угол от a к b (по часовой в экранных осях — положительный).
 */
export function arcPiece(pts, i, j, { maxRadius = Infinity } = {}) {
  if (j - i < 2) return null;
  const slice = pts.slice(i, j + 1);
  const fit = fitCircle(slice);
  if (!fit || !(fit.r > 0) || fit.r > maxRadius) return null;
  const { c, r } = fit;
  let err = 0;
  for (const p of slice) {
    const d = Math.abs(dist(p, c) - r);
    if (d > err) err = d;
  }
  const a0 = angleOf(c, pts[i]);
  const mid = angleOf(c, pts[i + ((j - i) >> 1)]);
  const a1 = angleOf(c, pts[j]);
  // Направление обхода — куда от начала лежит середина.
  const toMid = turn(a0, mid);
  const dir = toMid >= 0 ? 1 : -1;
  let sweep = turn(a0, a1);
  if (dir > 0 && sweep < 0) sweep += TAU;
  if (dir < 0 && sweep > 0) sweep -= TAU;
  // Монотонность: каждый следующий угол — дальше по обходу, не назад.
  let prev = a0;
  let acc = 0;
  for (let k = i + 1; k <= j; k += 1) {
    const ang = angleOf(c, pts[k]);
    const step = turn(prev, ang) * dir;
    if (step < -0.05) return null;
    acc += step;
    prev = ang;
  }
  if (Math.abs(acc - Math.abs(sweep)) > 0.2 && Math.abs(sweep) < TAU - 0.2) return null;
  return { kind: 'arc', c: { ...c }, r, a: { ...pts[i] }, b: { ...pts[j] }, a0, sweep, err, from: i, to: j };
}

/** Точки вдоль куска с шагом step (концы включены). */
export function samplePiece(piece, step = 1) {
  if (piece.kind === 'line') {
    const n = Math.max(1, Math.ceil(dist(piece.a, piece.b) / step));
    const out = [];
    for (let k = 0; k <= n; k += 1) {
      const t = k / n;
      out.push({ x: piece.a.x + (piece.b.x - piece.a.x) * t, y: piece.a.y + (piece.b.y - piece.a.y) * t });
    }
    return out;
  }
  const n = Math.max(2, Math.ceil((Math.abs(piece.sweep) * piece.r) / step));
  const out = [];
  for (let k = 0; k <= n; k += 1) {
    const ang = piece.a0 + (piece.sweep * k) / n;
    out.push({ x: piece.c.x + piece.r * Math.cos(ang), y: piece.c.y + piece.r * Math.sin(ang) });
  }
  // Концы — ровно на точках цепочки, чтобы куски стыковались без щелей.
  out[0] = { ...piece.a };
  out[out.length - 1] = { ...piece.b };
  return out;
}

/**
 * Разбор цепочки точек на отрезки и дуги в пределах допуска tol.
 *
 * Не жадно, а динамическим программированием по вершинам упрощённой
 * ломаной: ищется наименьшее число кусков, при равенстве — наименьшая
 * суммарная ошибка. Жадный разбор промахивался: отрезок, дотянувшийся в
 * допуске до начала скругления, съедал его начало, и на остаток ложилась дуга
 * не того радиуса. Проверка каждого куска — по ПЛОТНЫМ точкам между
 * вершинами, а не по вершинам: иначе дуга без свидетелей проходит любую.
 *
 * @param {{x,y}[]} pts — плотная ломаная (соседи в пикселе-двух)
 * @param {number} tol — допуск отклонения, в тех же единицах
 * @param {object} [o]
 * @param {number[]} [o.corners] — индексы плотной ломаной, где кусок обязан кончиться
 * @param {number} [o.maxRadius] — дуга радиусом больше этого — прямая
 * @param {number} [o.arcPenalty] — дуга дороже отрезка на столько кусков (0.5:
 *   две дуги никогда не дешевле отрезка и дуги, но дуга дешевле двух отрезков)
 * @returns {Array} куски по порядку; соседние делят концы
 */
export function segmentChain(pts, tol, o = {}) {
  const n = pts.length;
  if (n < 2) return [];
  const maxRadius = o.maxRadius ?? Infinity;
  const arcPenalty = o.arcPenalty ?? 0.5;

  // Вершины-кандидаты: упрощение с половиной допуска плюс обязательные углы
  // и концы. Кусок тянется от вершины к вершине.
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  for (const i of o.corners ?? []) if (i >= 0 && i < n) keep[i] = 1;
  const simp = rdpIndices(pts, tol * 0.5);
  for (const i of simp) keep[i] = 1;
  const verts = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) verts.push(i);
  const must = new Set(o.corners ?? []);

  const V = verts.length;
  const best = new Array(V).fill(null);   // {cost, err, prev, piece}
  best[0] = { cost: 0, err: 0, prev: -1, piece: null };
  for (let a = 0; a < V; a += 1) {
    if (!best[a]) continue;
    const i = verts[a];
    let misses = 0;
    for (let b = a + 1; b < V; b += 1) {
      const j = verts[b];
      const line = linePiece(pts, i, j);
      let piece = line.err <= tol ? line : null;
      let cost = 1;
      if (!piece) {
        const arc = arcPiece(pts, i, j, { maxRadius });
        if (arc && arc.err <= tol) { piece = arc; cost = 1 + arcPenalty; }
      }
      if (!piece) {
        misses += 1;
        if (misses > 3) break;
      } else {
        misses = 0;
        const total = best[a].cost + cost;
        const err = best[a].err + piece.err;
        if (!best[b] || total < best[b].cost - 1e-9 || (Math.abs(total - best[b].cost) < 1e-9 && err < best[b].err)) {
          best[b] = { cost: total, err, prev: a, piece };
        }
      }
      if (must.has(j)) break;   // через обязательный угол кусок не тянется
    }
  }
  if (!best[V - 1]) {
    // В допуск не легло даже от вершины к вершине (не должно случаться —
    // соседние вершины всегда соединимы отрезком); отдаём ломаную по вершинам.
    const out = [];
    for (let k = 1; k < V; k += 1) out.push(linePiece(pts, verts[k - 1], verts[k]));
    return out;
  }
  const out = [];
  for (let b = V - 1; b > 0; b = best[b].prev) out.push(best[b].piece);
  return out.reverse();
}

/** Индексы вершин упрощения Дугласа — Пекера (разомкнуто). */
function rdpIndices(pts, eps) {
  const out = [];
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = -1;
    let wd = eps;
    for (let k = i + 1; k < j; k += 1) {
      const d = distToSegment(pts[k], pts[i], pts[j]);
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst < 0) { out.push(i, j); continue; }
    stack.push([worst, j], [i, worst]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** d-атрибут пути из кусков: M, L и A; замкнутый — с Z. */
export function piecesToPathData(pieces, closed = false, prec = 2) {
  if (!pieces.length) return '';
  const f = (v) => {
    const s = v.toFixed(prec);
    return s.replace(/\.?0+$/, '') || '0';
  };
  const parts = [`M${f(pieces[0].a.x)} ${f(pieces[0].a.y)}`];
  for (const p of pieces) {
    if (p.kind === 'line') parts.push(`L${f(p.b.x)} ${f(p.b.y)}`);
    else {
      const large = Math.abs(p.sweep) > Math.PI ? 1 : 0;
      const sweepFlag = p.sweep > 0 ? 1 : 0;
      parts.push(`A${f(p.r)} ${f(p.r)} 0 ${large} ${sweepFlag} ${f(p.b.x)} ${f(p.b.y)}`);
    }
  }
  if (closed) parts.push('Z');
  return parts.join('');
}
