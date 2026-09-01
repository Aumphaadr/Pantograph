// glyphs/harmonize.js — согласование того, что в букве задумано одинаковым.
//
// Растр шумит несимметрично, и у «Ф» левая чаша выходит одной, а правая —
// другой, хотя рисовались они зеркальными. Здесь два правила:
//
//  1. Симметрия. Если контуры буквы совпадают со своим зеркалом в допуске —
//     буква и была симметричной, а расхождение — шум. Узлы усредняются с
//     зеркальными партнёрами, и симметрия становится ТОЧНОЙ. Оси — обе:
//     вертикальная («Ф», «А», «Т») и горизонтальная («Э», «З», «В»);
//     «О» и «Н» получают обе разом.
//
//  2. Толщины штрихов. Прямые осевые грани, стоящие напротив друг друга, —
//     это штрих; штрихи одной группы толщин по всему листу приводятся к
//     общей медиане. Слишком разные толщины не сливаются — у шрифта законно
//     бывают толстые и тонкие штрихи.
//
// Обе правки двигают узлы не дальше допуска: форма не выдумывается,
// одинаковым делается лишь то, что и так неотличимо от одинакового.

import { evalCubic } from '../core/bezier.js';

const avg = (a, b) => (a + b) / 2;

const mirrorPt = (p, kind, axis) => (kind === 'x'
  ? { x: 2 * axis - p.x, y: p.y }
  : { x: p.x, y: 2 * axis - p.y });

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

const bboxOf = (contours) => {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const c of contours) {
    for (const nd of c.nodes) {
      minX = Math.min(minX, nd.p.x); maxX = Math.max(maxX, nd.p.x);
      minY = Math.min(minY, nd.p.y); maxY = Math.max(maxY, nd.p.y);
    }
  }
  return { minX, minY, maxX, maxY };
};

// Центр контура — центр ГАБАРИТА, а не среднее узлов: лишний узел на одной
// стороне утягивает узловое среднее, и зеркальные чаши «не совпадают».
const centerOf = (c) => {
  const b = bboxOf([c]);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
};

/**
 * Найти зеркального партнёра каждому узлу. Возвращает пары индексов или null,
 * когда хоть один узел остался без пары в радиусе tol.
 * Пара может быть и самопарой — узел на самой оси.
 */
function pairNodes(aNodes, bNodes, kind, axis, tol) {
  const used = new Uint8Array(bNodes.length);
  const pairs = [];
  const t2 = tol * tol;
  for (let i = 0; i < aNodes.length; i += 1) {
    const want = mirrorPt(aNodes[i].p, kind, axis);
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < bNodes.length; j += 1) {
      if (used[j]) continue;
      const d = dist2(want, bNodes[j].p);
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0 || bd > t2) return null;
    used[best] = 1;
    pairs.push([i, best]);
  }
  return pairs;
}

/** Усреднить пару узлов с зеркалом; b становится точным зеркалом a. */
function reconcilePair(a, b, kind, axis) {
  const self = a === b;
  const mp = mirrorPt(b.p, kind, axis);
  const p = self
    ? (kind === 'x' ? { x: axis, y: a.p.y } : { x: a.p.x, y: axis })
    : { x: avg(a.p.x, mp.x), y: avg(a.p.y, mp.y) };

  // В зеркале обход разворачивается: out одного отвечает in другого.
  const mIn = b.in ? mirrorPt(b.in, kind, axis) : null;
  const mOut = b.out ? mirrorPt(b.out, kind, axis) : null;
  const out = a.out && mIn ? { x: avg(a.out.x, mIn.x), y: avg(a.out.y, mIn.y) } : a.out;
  const inn = a.in && mOut ? { x: avg(a.in.x, mOut.x), y: avg(a.in.y, mOut.y) } : a.in;
  const type = a.type === 'corner' || b.type === 'corner' ? 'corner' : 'smooth';

  a.p = p; a.out = out; a.in = inn; a.type = type;
  if (!self) {
    b.p = mirrorPt(p, kind, axis);
    b.in = out ? mirrorPt(out, kind, axis) : null;
    b.out = inn ? mirrorPt(inn, kind, axis) : null;
    b.type = type;
  } else {
    // Узел на оси: рычаги — точные зеркала друг друга.
    if (a.out && a.in) {
      const mo = mirrorPt(a.in, kind, axis);
      a.out = { x: avg(a.out.x, mo.x), y: avg(a.out.y, mo.y) };
      a.in = mirrorPt(a.out, kind, axis);
    }
  }
}

/** Одна ось. Возвращает true, если симметрия найдена и наведена. */
function reconcileAxis(shape, kind, tol) {
  const box = bboxOf(shape.contours);
  let axis = kind === 'x' ? avg(box.minX, box.maxX) : avg(box.minY, box.maxY);

  // Контуры разбиваются на партнёров: сам с собой или пара чаш «Ф».
  const cs = shape.contours;
  const centers = cs.map(centerOf);
  const cUsed = new Uint8Array(cs.length);
  const cPairs = [];
  for (let i = 0; i < cs.length; i += 1) {
    if (cUsed[i]) continue;
    const want = mirrorPt(centers[i], kind, axis);
    let best = -1;
    let bd = Infinity;
    for (let j = i; j < cs.length; j += 1) {
      if (cUsed[j]) continue;
      const d = dist2(want, centers[j]);
      if (d < bd) { bd = d; best = j; }
    }
    if (best < 0 || bd > (tol * 3) ** 2 || cs[i].nodes.length !== cs[best].nodes.length) return false;
    cUsed[i] = 1; cUsed[best] = 1;
    cPairs.push([i, best]);
  }

  // Узлы: сперва пары по грубой оси, затем ось уточняется по парам,
  // и только после этого — сверка допуска. Иначе честная симметрия при
  // оси, сдвинутой шумом габарита, отвергалась бы.
  const all = [];
  for (const [i, j] of cPairs) {
    const pairs = pairNodes(cs[i].nodes, cs[j].nodes, kind, axis, tol * 3);
    if (!pairs) return false;
    all.push({ i, j, pairs });
  }
  let sum = 0;
  let cnt = 0;
  for (const { i, j, pairs } of all) {
    for (const [ai, bj] of pairs) {
      const a = cs[i].nodes[ai].p;
      const b = cs[j].nodes[bj].p;
      sum += kind === 'x' ? avg(a.x, b.x) : avg(a.y, b.y);
      cnt += 1;
    }
  }
  axis = sum / cnt;

  const t2 = tol * tol;
  for (const { i, j, pairs } of all) {
    for (const [ai, bj] of pairs) {
      const a = cs[i].nodes[ai];
      const b = cs[j].nodes[bj];
      if (dist2(mirrorPt(a.p, kind, axis), b.p) > t2 * 4) return false;
    }
  }

  for (const { i, j, pairs } of all) {
    const seen = new Set();
    for (const [ai, bj] of pairs) {
      const key = i === j ? [Math.min(ai, bj), Math.max(ai, bj)].join(':') : `${ai}:${bj}`;
      if (seen.has(key)) continue;   // пара обрабатывается один раз
      seen.add(key);
      reconcilePair(cs[i].nodes[ai], cs[j].nodes[bj], kind, axis);
    }
  }
  return true;
}

/**
 * Навести на букву её собственную симметрию, если она есть.
 * @returns {{shape, axes: string[]}}
 */
export function symmetrizeShape(shape, { tol = 1.2 } = {}) {
  const axes = [];
  if (reconcileAxis(shape, 'x', tol)) axes.push('x');
  if (reconcileAxis(shape, 'y', tol)) axes.push('y');
  return { shape, axes };
}

// ─── зеркальная пересборка ──────────────────────────────────────────────────
//
// Парное усреднение узлов работает, только когда обе стороны одинаково
// устроены. Трассировка же и на свёрнутой маске даёт сторонам разное
// СТРОЕНИЕ: лишний узел на одной перекладине — и пар больше нет. Поэтому,
// когда маска уже признала букву симметричной, контур режется по оси и
// худшая сторона заменяется зеркалом лучшей: точная симметрия по построению.

const EPS_T = 1e-4;

/** Де Кастельжо: разрезать кубику в t. */
function splitCubic(bez, t) {
  const lerp = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const [p0, p1, p2, p3] = bez;
  const q0 = lerp(p0, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  return [[p0, q0, r0, m], [m, r1, q2, p3]];
}

const coord = (p, kind) => (kind === 'x' ? p.x : p.y);

/**
 * Подготовить контур к разрезу: узлы в шаге от оси притягиваются НА ось,
 * настоящие пересечения получают вставленный узел. После этого «на оси»
 * значит ровно «coord === axis» — счёт детерминирован.
 */
function insertAxisNodes(contour, kind, axis, tol) {
  for (const nd of contour.nodes) {
    const d = coord(nd.p, kind) - axis;
    if (d !== 0 && Math.abs(d) <= tol * 0.6) {
      if (kind === 'x') {
        nd.p.x = axis;
        if (nd.in) nd.in.x -= d;
        if (nd.out) nd.out.x -= d;
      } else {
        nd.p.y = axis;
        if (nd.in) nd.in.y -= d;
        if (nd.out) nd.out.y -= d;
      }
    }
  }
  for (let guard = 0; guard < 8; guard += 1) {
    const n = contour.nodes.length;
    let done = true;
    for (let i = 0; i < n; i += 1) {
      const a = contour.nodes[i];
      const b = contour.nodes[(i + 1) % n];
      const ca = coord(a.p, kind) - axis;
      const cb = coord(b.p, kind) - axis;
      if (ca === 0 || cb === 0) continue;
      if (ca * cb >= 0) continue;
      // пересечение: бисекция по t
      const bez = [a.p, a.out ?? a.p, b.in ?? b.p, b.p];
      let lo = 0;
      let hi = 1;
      const at = (t) => {
        const u = 1 - t;
        return u * u * u * coord(bez[0], kind) + 3 * u * u * t * coord(bez[1], kind)
          + 3 * u * t * t * coord(bez[2], kind) + t * t * t * coord(bez[3], kind);
      };
      const sLo = Math.sign(at(0) - axis);
      for (let it = 0; it < 40; it += 1) {
        const mid = (lo + hi) / 2;
        if (Math.sign(at(mid) - axis) === sLo) lo = mid; else hi = mid;
      }
      const t = (lo + hi) / 2;
      if (t < EPS_T || t > 1 - EPS_T) continue;
      const [l, r] = splitCubic(bez, t);
      const p = { ...l[3] };
      if (kind === 'x') p.x = axis; else p.y = axis;   // точно на ось
      a.out = a.out ? { ...l[1] } : null;
      b.in = b.in ? { ...r[2] } : null;
      contour.nodes.splice(i + 1, 0, {
        p, in: { ...l[2] }, out: { ...r[1] }, type: 'smooth',
      });
      done = false;
      break;
    }
    if (done) return;
  }
}

/** Выборка цепочки узлов (разомкнутой): по восемь точек на сегмент. */
function chainSamples(nodes) {
  const pts = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const bez = [a.p, a.out ?? a.p, b.in ?? b.p, b.p];
    for (let t = 0; t < 8; t += 1) pts.push(evalCubic(bez, t / 8));
  }
  if (nodes.length) pts.push({ ...nodes[nodes.length - 1].p });
  return pts;
}

/** Наибольшее расстояние от точек до ломаной. */
function worstTo(pts, line) {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy;
      let t = l2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = p.x - (a.x + vx * t);
      const dy = p.y - (a.y + vy * t);
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

/**
 * Стороны и вправду зеркальны? Иначе пересборка выдумала бы симметрию.
 * Порог — доля размера, а не константа: два пикселя расхождения на большой
 * букве — шум обводки, на маленькой фигуре — другая форма.
 */
function sidesMirror(aNodes, bNodes, kind, axis) {
  if (!aNodes.length || !bNodes.length) return false;
  const a = chainSamples(aNodes).map((p) => mirrorPt(p, kind, axis));
  const b = chainSamples(bNodes);
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of a.concat(b)) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  const lim = Math.max(1.2, Math.min(3, size * 0.045));
  return worstTo(a, b) <= lim && worstTo(b, a) <= lim;
}

const mirrorNode = (nd, kind, axis) => ({
  p: mirrorPt(nd.p, kind, axis),
  in: nd.out ? mirrorPt(nd.out, kind, axis) : null,
  out: nd.in ? mirrorPt(nd.in, kind, axis) : null,
  type: nd.type,
});

/** «Шероховатость» стороны: чем меньше узлов, тем чище обводка. */
const roughness = (nodes) => nodes.length;

/**
 * Самосимметричный контур: осевые узлы уже вставлены; между двумя осевыми
 * узлами лежат две стороны — худшая заменяется зеркалом лучшей.
 */
function mirrorSelf(contour, kind, axis, tol) {
  insertAxisNodes(contour, kind, axis, tol);
  // Два осевых узла подряд — это один разрез, размазанный шумом: сливаем.
  for (let i = contour.nodes.length - 1; i >= 0; i -= 1) {
    const n2 = contour.nodes.length;
    if (n2 <= 3) break;
    const a = contour.nodes[i];
    const b = contour.nodes[(i + 1) % n2];
    if (coord(a.p, kind) === axis && coord(b.p, kind) === axis
      && Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) < Math.max(1, tol)) {
      a.out = b.out;
      a.type = a.type === 'corner' || b.type === 'corner' ? 'corner' : 'smooth';
      contour.nodes.splice((i + 1) % n2, 1);
    }
  }
  const onAxis = [];
  contour.nodes.forEach((nd, i) => {
    if (coord(nd.p, kind) === axis) onAxis.push(i);
  });
  if (onAxis.length !== 2) return false;   // сложное сечение — не берёмся

  const [i0, i1] = onAxis;
  const sideA = contour.nodes.slice(i0 + 1, i1);
  const sideB = contour.nodes.slice(i1 + 1).concat(contour.nodes.slice(0, i0));
  const a0 = contour.nodes[i0];
  const a1 = contour.nodes[i1];

  // Осевые узлы — точно на ось, рычаги зеркалим.
  for (const nd of [a0, a1]) {
    if (kind === 'x') nd.p.x = axis; else nd.p.y = axis;
    if (nd.in && nd.out) {
      const mo = mirrorPt(nd.in, kind, axis);
      nd.out = { x: avg(nd.out.x, mo.x), y: avg(nd.out.y, mo.y) };
      nd.in = mirrorPt(nd.out, kind, axis);
    }
  }

  // Сверка: пересборка наводит симметрию, но не выдумывает её.
  // Обе цепочки — В ПОРЯДКЕ ОБХОДА: сторона A идёт от i0 к i1, сторона B —
  // от i1 к i0; перепутанные концы дают ложный отрезок через середину.
  const chainA = [contour.nodes[i0], ...sideA, contour.nodes[i1]];
  const chainB = [contour.nodes[i1], ...sideB, contour.nodes[i0]];
  if (!sidesMirror(chainA, chainB, kind, axis)) return false;

  const keepA = roughness(sideA) <= roughness(sideB);
  const src = keepA ? sideA : sideB;
  const dst = [...src].reverse().map((nd) => mirrorNode(nd, kind, axis));

  const next = keepA
    ? [a0, ...sideA, a1, ...dst]
    : [a0, ...dst, a1, ...sideB];
  contour.nodes = next;
  return true;
}

/**
 * Зеркальная пересборка фигуры по известным осям (их дала свёртка маски).
 * Контуры, пересекающие ось, зеркалятся сами в себе; пары контуров по обе
 * стороны (чаши «Ф») — худший заменяется зеркалом лучшего.
 */
export function mirrorReconcile(shape, kinds, axesAt, { tol = 1.2 } = {}) {
  const done = [];
  const cloneNodes = (c) => ({
    ...c,
    nodes: c.nodes.map((nd) => ({
      p: { ...nd.p },
      in: nd.in ? { ...nd.in } : null,
      out: nd.out ? { ...nd.out } : null,
      type: nd.type,
    })),
  });
  for (const kind of kinds) {
    const axis = axesAt[kind];
    if (axis === undefined) continue;
    let ok = true;
    // Работаем на клоне: неудавшаяся ось не должна оставлять полуправок.
    const backup = shape.contours;
    shape.contours = shape.contours.map(cloneNodes);
    const cs = shape.contours;
    const used = new Uint8Array(cs.length);
    for (let i = 0; i < cs.length; i += 1) {
      if (used[i]) continue;
      const lo = Math.min(...cs[i].nodes.map((nd) => coord(nd.p, kind)));
      const hi = Math.max(...cs[i].nodes.map((nd) => coord(nd.p, kind)));
      if (lo < axis - tol && hi > axis + tol) {
        used[i] = 1;
        if (!mirrorSelf(cs[i], kind, axis, tol)) ok = false;
        continue;
      }
      // контур целиком с одной стороны: ищем партнёра
      const want = mirrorPt(centerOf(cs[i]), kind, axis);
      let best = -1;
      let bd = Infinity;
      for (let j = 0; j < cs.length; j += 1) {
        if (used[j] || j === i) continue;
        const d = dist2(want, centerOf(cs[j]));
        if (d < bd) { bd = d; best = j; }
      }
      if (best < 0 || bd > (tol * 4) ** 2) { used[i] = 1; ok = false; continue; }
      const ringA = cs[i].nodes.concat([cs[i].nodes[0]]);
      const ringB = cs[best].nodes.concat([cs[best].nodes[0]]);
      if (!sidesMirror(ringA, ringB, kind, axis)) {
        used[i] = 1; used[best] = 1; ok = false; continue;
      }
      used[i] = 1; used[best] = 1;
      const keepI = roughness(cs[i].nodes) <= roughness(cs[best].nodes);
      const srcC = keepI ? cs[i] : cs[best];
      const dstIdx = keepI ? best : i;
      cs[dstIdx] = {
        ...cs[dstIdx],
        nodes: [...srcC.nodes].reverse().map((nd) => mirrorNode(nd, kind, axis)),
      };
    }
    if (ok) done.push(kind);
    else shape.contours = backup;   // откат: ось не взялась целиком
  }
  return done;
}

// ─── толщины штрихов ────────────────────────────────────────────────────────

const online = (h, a, b) => {
  if (!h) return true;
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = Math.hypot(vx, vy) || 1;
  return Math.abs(vx * (h.y - a.y) - vy * (h.x - a.x)) / len < 0.25;
};

/** Прямые осевые грани всех букв: заготовки штрихов. */
export function collectEdges(glyphs) {
  const edges = [];
  glyphs.forEach((g, gi) => {
    g.shape.contours.forEach((c, ci) => {
      if (c.closed === false) return;
      const n = c.nodes.length;
      c.nodes.forEach((a, i) => {
        const b = c.nodes[(i + 1) % n];
        if (!online(a.out, a.p, b.p) || !online(b.in, a.p, b.p)) return;
        const dx = b.p.x - a.p.x;
        const dy = b.p.y - a.p.y;
        if (Math.abs(dx) < 0.05 && Math.abs(dy) >= 3) {
          edges.push({
            gi, ci, i, kind: 'v', pos: a.p.x,
            lo: Math.min(a.p.y, b.p.y), hi: Math.max(a.p.y, b.p.y),
          });
        } else if (Math.abs(dy) < 0.05 && Math.abs(dx) >= 3) {
          edges.push({
            gi, ci, i, kind: 'h', pos: a.p.y,
            lo: Math.min(a.p.x, b.p.x), hi: Math.max(a.p.x, b.p.x),
          });
        }
      });
    });
  });
  return edges;
}

/**
 * Пары граней одной буквы, стоящие напротив: штрихи с их толщиной.
 * Потолок толщины — доля высоты буквы: пара «верх и низ стойки» отстоит
 * на весь рост, и это габарит, а не штрих.
 */
export function pairStems(edges, { maxShare = 0.4, heightOf = () => 120 } = {}) {
  const stems = [];
  const used = new Set();
  const overlap = (a, b) => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
  for (let i = 0; i < edges.length; i += 1) {
    if (used.has(i)) continue;
    const a = edges[i];
    const maxWidth = maxShare * heightOf(a.gi);
    let best = -1;
    let bw = Infinity;
    for (let j = i + 1; j < edges.length; j += 1) {
      if (used.has(j)) continue;
      const b = edges[j];
      if (b.gi !== a.gi || b.kind !== a.kind) continue;
      const w = Math.abs(b.pos - a.pos);
      if (w < 1.5 || w > maxWidth || w >= bw) continue;
      const ov = overlap(a, b);
      if (ov < 0.6 * Math.min(a.hi - a.lo, b.hi - b.lo)) continue;
      bw = w; best = j;
    }
    if (best < 0) continue;
    used.add(i); used.add(best);
    stems.push({ a, b: edges[best], width: bw, kind: a.kind });
  }
  return stems;
}

/**
 * Толщины штрихов листа — к общим значениям. Штрихи собираются в группы
 * близких толщин (в пределах spread), каждая группа приводится к своей
 * медиане; грань двигается не дальше cap.
 */
export function equalizeStems(glyphs, { cap = 0.8, spread = 1.6 } = {}) {
  const stems = pairStems(collectEdges(glyphs), {
    heightOf: (gi) => (glyphs[gi].bbox ? glyphs[gi].bbox.h : 120),
  });
  if (stems.length < 2) return 0;

  for (const kind of ['v', 'h']) {
    const ours = stems.filter((s) => s.kind === kind).sort((x, y) => x.width - y.width);
    let start = 0;
    for (let i = 1; i <= ours.length; i += 1) {
      if (i < ours.length && ours[i].width - ours[i - 1].width <= spread) continue;
      const group = ours.slice(start, i);
      start = i;
      if (group.length < 2) continue;
      const target = group[group.length >> 1].width;
      for (const s of group) {
        const d = (target - s.width) / 2;
        if (d === 0 || Math.abs(d) > cap) continue;
        const sign = Math.sign(s.b.pos - s.a.pos) || 1;
        moveEdge(glyphs, s.a, -sign * d);
        moveEdge(glyphs, s.b, sign * d);
      }
    }
  }
  return stems.length;
}

/** Сдвинуть грань по её нормали: оба узла с рычагами. */
function moveEdge(glyphs, e, d) {
  const c = glyphs[e.gi].shape.contours[e.ci];
  const n = c.nodes.length;
  for (const nd of [c.nodes[e.i], c.nodes[(e.i + 1) % n]]) {
    if (e.kind === 'v') {
      nd.p.x += d;
      if (nd.in) nd.in.x += d;
      if (nd.out) nd.out.x += d;
    } else {
      nd.p.y += d;
      if (nd.in) nd.in.y += d;
      if (nd.out) nd.out.y += d;
    }
  }
}
