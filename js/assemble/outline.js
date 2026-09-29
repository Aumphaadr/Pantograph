// assemble/outline.js — контур заливки из отрезков и дуг.
//
// Обводчик (trace/traceMask) кладёт на изолинию кривые Безье в допуске — для
// рисованной формы это то, что нужно. У геометричного значка (прямоугольники
// со скруглением, круги, прямые) кривые в допуске гуляют: прямая кромка
// выходит едва заметной волной, особенно после сдвига края на долю пикселя
// (prep/weight.js), который сетка растра квантует ступеньками. Здесь та же
// изолиния разбирается на наименьшее число отрезков и дуг в допуске
// (pieces.segmentChain — тот же разбор, что у «Сборки» по осевой): прямая —
// один отрезок, скругление — одна дуга, острый угол — пересечение прямых;
// дуги отдаются кубиками.

import { isolines, detectCorners } from '../trace/trace.js';
import { gaussian } from '../prep/mask.js';
import { rdpClosed } from '../core/simplify.js';
import { orient, transform } from '../core/path.js';
import { dist } from '../core/bezier.js';
import { segmentChain } from './pieces.js';
import { assemblyToShape } from './assemble.js';

export const DEFAULTS = {
  blur: 1.5,         // размытие перед изолинией, px: у двоичной маски изолиния идёт лесенкой
  level: 0.5,        // уровень изолинии
  tol: 1.0,          // допуск отрезка и дуги, px маски: поглощает лесенку сдвига края
  arcPenalty: 0.25,  // дуга дороже отрезка на столько кусков: мало — иначе окружность
                     // в допуске пикселя выкладывается хордами по 20 px
  errWeight: 1,      // пиксель отклонения стоит куска: точный разбор дороже короткого
  stride: 4,         // кандидаты вершин ещё и через столько точек изолинии
  simplify: 1,       // упрощение для поиска углов, px маски
  cornerAngle: 60,   // острый угол: поворот круче этого на коротком окне
  cornerSpan: 6,     // окно, px маски. Короткое: скругление в 16 px — не угол, а дуга
  cornerGap: 3,      // столько точек у вершины угла выбрасывается: размытие скругляет
                     // острый угол, и отрезок через скругление в допуск не ложится
  minArea: 16,       // петли мельче (px²) — мусор
};

const TAU = Math.PI * 2;
const offLine = (q, a, b) => {
  const L = dist(a, b) || 1;
  return Math.abs((b.x - a.x) * (a.y - q.y) - (a.x - q.x) * (b.y - a.y)) / L;
};

/** Прямая наименьших квадратов (ортогональная) по точкам: точка и направление. */
function fitLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(ang), y: Math.sin(ang) } };
}
const project = (q, L) => {
  const t = (q.x - L.p.x) * L.d.x + (q.y - L.p.y) * L.d.y;
  return { x: L.p.x + t * L.d.x, y: L.p.y + t * L.d.y };
};
function intersect(A, B) {
  const cross = A.d.x * B.d.y - A.d.y * B.d.x;
  if (Math.abs(cross) < 0.05) return null;          // почти параллельны — пересечение далеко и неустойчиво
  const t = ((B.p.x - A.p.x) * B.d.y - (B.p.y - A.p.y) * B.d.x) / cross;
  return { x: A.p.x + t * A.d.x, y: A.p.y + t * A.d.y };
}

/** Куски разбора — с точками изолинии, по которым они легли (для уточнения прямых). */
function chainPieces(pts, o) {
  const pieces = segmentChain(pts, o.tol, { maxRadius: o.maxRadius, arcPenalty: o.arcPenalty, errWeight: o.errWeight, stride: o.stride });
  return pieces.map((p) => ({ ...p, pts: pts.slice(p.from, p.to + 1) }));
}

/**
 * Короткий отрезок, оба конца которого лежат на окружности соседней дуги, —
 * часть этой дуги. Так выходит у полного круга: дуга не бывает в 360° (концы
 * разные), и разбор берёт дугу почти во весь круг плюс хорду в пару пикселей.
 */
function absorbShortLines(pieces, tol, maxLen = 8) {
  const out = pieces.slice();
  const onCircle = (q, arc) => Math.abs(dist(q, arc.c) - arc.r) <= tol;
  const angleOf = (arc, q) => Math.atan2(q.y - arc.c.y, q.x - arc.c.x);
  // Приращение угла — кратчайшее, в (−π, π]. Раньше оно насильно шло вперёд по
  // обходу, и конец хорды на волос позади конца дуги давал почти лишний оборот:
  // дуга обходила круг и заливала полкартинки (phrase-library набора SignoreBot).
  const step = (from, to) => {
    let d = to - from;
    while (d > Math.PI) d -= TAU;
    while (d <= -Math.PI) d += TAU;
    return d;
  };
  for (let changed = true; changed && out.length > 1;) {
    changed = false;
    for (let i = 0; i < out.length; i += 1) {
      const p = out[i];
      if (p.kind !== 'line' || p.bridge || dist(p.a, p.b) > maxLen) continue;
      const ip = (i - 1 + out.length) % out.length;
      const iN = (i + 1) % out.length;
      const prev = out[ip];
      const next = out[iN];
      // Хорда продолжает дугу, только если идёт по её обходу (назад — не своя).
      const grow = (arc, d) => d * Math.sign(arc.sweep) >= 0 && Math.abs(arc.sweep + d) <= TAU + 1e-6;
      const dPrev = prev.kind === 'arc' ? step(angleOf(prev, prev.b), angleOf(prev, p.b)) : 0;
      const dNext = next.kind === 'arc' ? step(angleOf(next, p.a), angleOf(next, next.a)) : 0;
      if (prev.kind === 'arc' && onCircle(p.a, prev) && onCircle(p.b, prev) && grow(prev, dPrev)) {
        out[ip] = { ...prev, b: { ...p.b }, sweep: prev.sweep + dPrev };
      } else if (next.kind === 'arc' && onCircle(p.a, next) && onCircle(p.b, next) && grow(next, dNext)) {
        out[iN] = { ...next, a: { ...p.a }, a0: angleOf(next, p.a), sweep: next.sweep + dNext };
      } else continue;
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * Уточнение. Отрезок разбора идёт от точки изолинии до точки изолинии, и у
 * скругления или угла эти точки лежат не на прямой — кромка наклоняется на
 * доли пикселя. Поэтому каждая прямая переставляется по наименьшим квадратам
 * своих точек; стык двух прямых — в их пересечение (мостик через угол и
 * фаска исчезают, острый угол становится острым), стык прямой с дугой — в
 * проекцию на прямую; дуга пересчитывает углы к новым концам.
 */
function refine(pieces, reach) {
  if (pieces.length < 2) return pieces;
  let lines = pieces.map((p) => (p.kind === 'line' && !p.bridge && p.pts && p.pts.length >= 3 ? fitLine(p.pts) : null));
  // Мостик через острый угол и фаска: короткий отрезок между двумя прямыми,
  // чьё пересечение рядом, — снимаем, соседи сойдутся в угол.
  const keep = pieces.map(() => true);
  pieces.forEach((p, i) => {
    if (p.kind !== 'line' || (!p.bridge && dist(p.a, p.b) > 4)) return;
    const a = (i - 1 + pieces.length) % pieces.length;
    const b = (i + 1) % pieces.length;
    if (a === b || !keep[a] || !lines[a] || !lines[b]) return;
    const X = intersect(lines[a], lines[b]);
    const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    if (X && dist(X, mid) <= reach) keep[i] = false;
  });
  const kept = pieces.filter((_, i) => keep[i]);
  lines = lines.filter((_, i) => keep[i]);
  const n = kept.length;
  if (n < 2) return pieces;
  const out = kept.map((p) => ({ ...p, a: { ...p.a }, b: { ...p.b } }));
  for (let i = 0; i < n; i += 1) {
    const k = (i + 1) % n;
    const A = lines[i], B = lines[k];
    const J = out[i].b;
    let Jn = J;
    if (A && B) {
      const X = intersect(A, B);
      Jn = X && dist(X, J) <= reach ? X : project(project(J, A), B);
    } else if (A && !out[k].bridge) Jn = project(J, A);
    else if (B && !out[i].bridge) Jn = project(J, B);
    out[i].b = { ...Jn };
    out[k].a = { ...Jn };
  }
  for (const p of out) {
    if (p.kind !== 'arc') continue;
    const a0 = Math.atan2(p.a.y - p.c.y, p.a.x - p.c.x);
    const a1 = Math.atan2(p.b.y - p.c.y, p.b.x - p.c.x);
    let sweep = a1 - a0;
    while (sweep - p.sweep > Math.PI) sweep -= TAU;
    while (p.sweep - sweep > Math.PI) sweep += TAU;
    p.a0 = a0;
    p.sweep = sweep;
  }
  return out;
}

/** Вершины острых углов на петле: поворот на коротком окне, разрез — в вершину скругления. */
function cornersOf(loop, o) {
  const simp = rdpClosed(loop, o.simplify);
  const found = detectCorners(simp, o.cornerAngle, o.cornerSpan, Math.min(o.cornerSpan, 1.6), true);
  const L = loop.length;
  const reach = Math.max(2, Math.round(o.cornerSpan));
  return [...new Set(found.map((k) => {
    let near = 0;
    let bd = Infinity;
    loop.forEach((p, i) => { const d = dist(p, simp[k]); if (d < bd) { bd = d; near = i; } });
    const a = loop[(near - reach + L) % L];
    const b = loop[(near + reach) % L];
    let apex = near;
    let far = -1;
    for (let t = -reach; t <= reach; t += 1) {
      const q = loop[(near + t + L) % L];
      const d = offLine(q, a, b);
      if (d > far) { far = d; apex = (near + t + L) % L; }
    }
    return apex;
  }))].sort((a, b) => a - b);
}

/** Одна петля → куски. */
function loopPieces(loop, o) {
  const L = loop.length;
  const corners = cornersOf(loop, o);
  if (!corners.length) {
    // Без углов кольцо режется на стыке кусков первого прохода: шов посреди
    // дуги оставлял обрезок-отрезок в пару пикселей.
    const at = (start) => chainPieces(loop.slice(start).concat(loop.slice(0, start + 1)), o);
    let pieces = at(0);
    if (pieces.length >= 3) pieces = at(pieces[1].from % L);
    return absorbShortLines(pieces, o.tol);
  }
  // С углами: стороны между углами разбираются порознь, без точек скругления
  // у вершин; через каждый угол — мостик, его снимет уточнение.
  const g = o.cornerGap;
  const pieces = [];
  corners.forEach((c, i) => {
    const next = corners[(i + 1) % corners.length] + (i + 1 === corners.length ? L : 0);
    const from = c + g;
    const to = next - g;
    const side = [];
    for (let k = from; k <= to; k += 1) side.push(loop[k % L]);
    if (side.length >= 2) pieces.push(...absorbShortLines(chainPieces(side, o), o.tol));
    const here = pieces.length ? pieces[pieces.length - 1].b : loop[from % L];
    pieces.push({ kind: 'line', a: { ...here }, b: { ...loop[(next + g) % L] }, err: 0, bridge: true });
  });
  // Мостики соединяют конец стороны с началом следующей: концы кусков совпадают.
  for (let i = 0; i < pieces.length; i += 1) {
    if (pieces[i].bridge) pieces[i].b = { ...pieces[(i + 1) % pieces.length].a };
  }
  return pieces;
}

/**
 * Маска → Shape из отрезков и дуг (кубиками), в px маски; отсчёт — центр
 * пикселя, как у traceMask. Контуры ориентированы: дыры против внешних.
 *
 * @param {{w,h,data}} mask — мягкая или двоичная маска
 * @param {object} [opts] — см. DEFAULTS
 * @returns {{contours:object[]}}
 */
export function outlineArcs(mask, opts = {}) {
  const o = { ...DEFAULTS, maxRadius: 4 * Math.max(mask.w, mask.h), ...opts };
  const field = o.blur > 0 ? gaussian(mask, o.blur) : mask;
  const contours = [];
  for (const loop of isolines(field, o.level)) {
    let area = 0;
    for (let i = 0; i < loop.length; i += 1) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      area += p.x * q.y - q.x * p.y;
    }
    if (Math.abs(area / 2) < o.minArea) continue;
    const pieces = refine(loopPieces(loop, o), Math.max(4, 2 * o.cornerGap + 2));
    const c = assemblyToShape({ parts: [{ kind: 'path', pieces, closed: true }], width: 1 }).contours[0];
    if (c) contours.push({ closed: true, nodes: c.nodes });
  }
  return orient(transform({ contours }, (p) => ({ x: p.x + 0.5, y: p.y + 0.5 })));
}
