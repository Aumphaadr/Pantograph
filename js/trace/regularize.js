// trace/regularize.js — выравнивание обведённого контура.
//
// Растровая буква никогда не бывает идеальной: прямая кромка гуляет на
// полпикселя, прямой угол — на пару градусов, круглая точка — чуть овальна.
// Подгонка честно повторяет этот шум, но человек-то рисовал прямую. Здесь
// контуру возвращается замысел: что неотличимо от прямой в допуске подгонки —
// становится прямой; прямая в паре градусов от осевой — осевой; контур,
// неотличимый от прямоугольника или эллипса, — им самим.
//
// Порог всюду один — допуск подгонки. Выравнивание не выдумывает форму,
// а выбирает из неотличимых кандидатов самый правильный.

import { detect, apply } from '../core/primitives.js';
import { evalCubic, fitCurves, endTangent } from '../core/bezier.js';

const DEG = Math.PI / 180;

const clone = (c) => ({
  ...c,
  nodes: c.nodes.map((n) => ({
    p: { ...n.p },
    in: n.in ? { ...n.in } : null,
    out: n.out ? { ...n.out } : null,
    type: n.type,
  })),
});

/** Наибольший отход кривой сегмента от своей хорды. */
export function segmentSag(p0, p1, p2, p3) {
  const vx = p3.x - p0.x;
  const vy = p3.y - p0.y;
  const chord = Math.hypot(vx, vy);
  if (chord < 1e-9) return 0;
  let worst = 0;
  for (let t = 0.1; t < 0.95; t += 0.1) {
    const q = evalCubic([p0, p1, p2, p3], t);
    const d = Math.abs(vx * (q.y - p0.y) - vy * (q.x - p0.x)) / chord;
    if (d > worst) worst = d;
  }
  return worst;
}

const SNAP_KINDS = new Set(['circle', 'ellipse', 'rect', 'roundRect']);

/**
 * Один контур. Возвращает { contour, snapped } — snapped назван, когда контур
 * целиком приведён к примитиву.
 */
export function regularizeContour(contour, opts = {}) {
  const o = { lineTol: 0.35, axisDeg: 4, primShare: 0.025, ...opts };
  const n = contour.nodes.length;
  if (n < 2) return { contour, snapped: null };

  // 1. Целиком примитив? Многоугольник намеренно исключён: внешний контур
  // буквы — и есть многоугольник, приводить его значит терять букву.
  //
  // detect ВСЕГДА возвращает «наименее плохой» примитив — прошёл ли он
  // допуск, лежит рядом во флаге fits. Без проверки флага буква «Н»
  // приводилась к своему наименее плохому кругу — целиком.
  // Допуск примитива — тот же, что у всего канона (primTol), а не доля
  // габарита: доля в 2.5 % от «О» в сорок пикселей — целый пиксель, и буква
  // Lato, которая эллипсом не рисовалась, уводилась от истины на треть
  // пикселя при узлах ровно на экстремумах, где ей и так хватило бы четырёх.
  if (o.primShare > 0 && contour.closed !== false && n >= 3) {
    const match = detect(contour, o.primShare, { absolute: o.primTol ?? null });
    if (match && match.fits && SNAP_KINDS.has(match.kind)) {
      const snapped = apply(contour, match);
      if (contour.width !== undefined) snapped.width = contour.width;
      return { contour: snapped, snapped: match.kind };
    }
  }

  const out = clone(contour);
  const closed = out.closed !== false;

  // 2. Пробеги между углами пересобираются по КАНОНУ ШРИФТОВ: узлы — на
  // экстремумах по x и y, рычаги там строго осевые, кусок не длиннее
  // квадранта. Это одновременно лечит «полуокружность одной кубикой с
  // рычагами поперёк хорды» (законный, но уродливый выход Шнайдера) и
  // описывает эллиптические дуги, из которых состоят буквы. Замена
  // принимается только если пересобранное неотличимо от исходного.
  rebuildRuns(out, o);

  const n2 = out.nodes.length;
  const segs = closed ? n2 : n2 - 1;
  const at = (i) => out.nodes[i % n2];

  // 2а. Сегменты, неотличимые от своей хорды, — прямые.
  const isLine = new Array(segs).fill(false);
  for (let i = 0; i < segs; i += 1) {
    const a = at(i);
    const b = at(i + 1);
    const p1 = a.out ?? a.p;
    const p2 = b.in ?? b.p;
    if (segmentSag(a.p, p1, p2, b.p) <= o.lineTol) isLine[i] = true;
  }

  // 3. Прямые в паре градусов от осевых — осевые. Узел общий для двух
  // сегментов, поэтому сдвиги собираются по узлам и применяются разом:
  // горизонтали правят y, вертикали правят x — прямой угол получает оба
  // снапа без конфликта.
  const tan = Math.tan(o.axisDeg * DEG);
  const cap = o.lineTol * 1.5;              // дальше этого не двигаем: не наш шум
  const wantX = new Map();
  const wantY = new Map();
  const put = (m, i, v) => m.set(i, (m.get(i) ?? []).concat(v));

  for (let i = 0; i < segs; i += 1) {
    if (!isLine[i]) continue;
    const a = at(i).p;
    const b = at(i + 1).p;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    if (dy <= dx * tan && dy > 0 && dy / 2 <= cap) {
      const y = (a.y + b.y) / 2;
      put(wantY, i % n2, y);
      put(wantY, (i + 1) % n2, y);
    } else if (dx <= dy * tan && dx > 0 && dx / 2 <= cap) {
      const x = (a.x + b.x) / 2;
      put(wantX, i % n2, x);
      put(wantX, (i + 1) % n2, x);
    }
  }

  const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
  const shift = (node, dx, dy) => {
    node.p.x += dx; node.p.y += dy;
    if (node.in) { node.in.x += dx; node.in.y += dy; }
    if (node.out) { node.out.x += dx; node.out.y += dy; }
  };
  for (const [i, xs] of wantX) shift(out.nodes[i], avg(xs) - out.nodes[i].p.x, 0);
  for (const [i, ys] of wantY) shift(out.nodes[i], 0, avg(ys) - out.nodes[i].p.y);

  // 4. У прямой рычаги лежат на ней самой; гладкий стык прямой с кривой
  // остаётся гладким — рычаг кривой стороны разворачивается вдоль прямой.
  for (let i = 0; i < segs; i += 1) {
    if (!isLine[i]) continue;
    const a = at(i);
    const b = at(i + 1);
    const dx = b.p.x - a.p.x;
    const dy = b.p.y - a.p.y;
    a.out = { x: a.p.x + dx / 3, y: a.p.y + dy / 3 };
    b.in = { x: b.p.x - dx / 3, y: b.p.y - dy / 3 };

    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const before = closed || i > 0 ? (i + n2 - 1) % n2 : -1;
    const after = closed || i + 1 < segs ? (i + 1) % segs : -1;
    if (a.type === 'smooth' && a.in && before >= 0 && !isLine[before]) {
      const l = Math.hypot(a.in.x - a.p.x, a.in.y - a.p.y);
      a.in = { x: a.p.x - ux * l, y: a.p.y - uy * l };
    }
    if (b.type === 'smooth' && b.out && after >= 0 && !isLine[after]) {
      const l = Math.hypot(b.out.x - b.p.x, b.out.y - b.p.y);
      b.out = { x: b.p.x + ux * l, y: b.p.y + uy * l };
    }
  }

  // 5. Узел между двумя коллинеарными прямыми не несёт ничего: после снапа
  // осевые кромки часто состоят из двух-трёх кусков там, где кромка одна.
  dropCollinear(out, o.lineTol);

  // 6. Пробное удаление: узлы, без которых кривая неотличима, — лишние.
  dropRedundantNodes(out, o.lineTol);

  // 7. Рычаги в паре градусов от красивого угла — точно на него.
  snapHandleAngles(out, o);

  // 8. Тип узла обязан совпадать с геометрией — последним словом.
  honestTypes(out);

  return { contour: out, snapped: null };
}


/** Точки вдоль пробега сегментов [from..from+count) контура. */
function sampleRun(nodes, from, count, per = 12) {
  const n = nodes.length;
  const pts = [];
  for (let k = 0; k < count; k += 1) {
    const a = nodes[(from + k) % n];
    const b = nodes[(from + k + 1) % n];
    const bez = [a.p, a.out ?? a.p, b.in ?? b.p, b.p];
    for (let t = 0; t < per; t += 1) pts.push(evalCubic(bez, t / per));
  }
  pts.push({ ...nodes[(from + count) % n].p });
  return pts;
}

/**
 * Экстремумы хода по осям: индексы выборки, где направление движения по x
 * или y разворачивается. Дребезг гасится гистерезисом: разворот считается,
 * только если с прошлого разворота по этой оси пройдено не меньше minMove.
 */
export function findExtrema(pts, minMove = 0.8) {
  const out = [];
  for (const axis of ['x', 'y']) {
    let dir = 0;
    let extent = 0;
    let armAt = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const d = pts[i][axis] - pts[i - 1][axis];
      if (d === 0) continue;
      const sgn = Math.sign(d);
      if (dir === 0) { dir = sgn; extent = Math.abs(d); armAt = i - 1; continue; }
      if (sgn === dir) { extent += Math.abs(d); continue; }
      // разворот: значим, только когда до него успели пройти minMove
      if (extent >= minMove) {
        out.push({ idx: i - 1, axis, sinceArm: armAt });
      }
      dir = sgn;
      extent = Math.abs(d);
      armAt = i - 1;
    }
  }
  // на концах пробега экстремум не ставится — там уже стоят узлы
  return out
    .filter((e) => e.idx > 1 && e.idx < pts.length - 2)
    .sort((a, b) => a.idx - b.idx)
    .filter((e, i, arr) => i === 0 || e.idx - arr[i - 1].idx > 2);
}

/** Касательная хода в экстремуме: строго осевая, знак — по ходу другой оси. */
function extremumTangent(pts, e) {
  const a = pts[Math.max(0, e.idx - 2)];
  const b = pts[Math.min(pts.length - 1, e.idx + 2)];
  if (e.axis === 'x') return { x: 0, y: Math.sign(b.y - a.y) || 1 };
  return { x: Math.sign(b.x - a.x) || 1, y: 0 };
}

/** Наибольшее расстояние от точек до ломаной (по отрезкам). */
function worstToPolyline(pts, line) {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
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
 * Пересобрать один пробег по экстремумам. Возвращает цепочку кубик или null,
 * если пересборка вышла хуже допуска.
 */
function rebuildRun(nodes, from, count, tol) {
  const pts = sampleRun(nodes, from, count);
  if (pts.length < 6) return null;

  // Пробег, неотличимый от прямой хорды, — ПРЯМАЯ, под любым углом.
  // Осевой снап прямит только горизонтали и вертикали, а диагональ «И»
  // оставалась цепочкой пологих кривых с гладкими узлами внутри.
  {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord > 1e-6) {
      let worst = 0;
      for (const p of pts) {
        const d = Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / chord;
        if (d > worst) worst = d;
      }
      if (worst <= tol) {
        const third = { x: (b.x - a.x) / 3, y: (b.y - a.y) / 3 };
        return [[{ ...a }, { x: a.x + third.x, y: a.y + third.y },
          { x: b.x - third.x, y: b.y - third.y }, { ...b }]];
      }
    }
  }

  const extrema = findExtrema(pts, Math.max(0.8, tol));
  const cuts = [0, ...extrema.map((e) => e.idx), pts.length - 1];
  // Все касательные — ВПЕРЁД по ходу пробега. endTangent с отрицательным
  // шагом смотрит назад, поэтому концевую надо развернуть здесь, один раз:
  // развернув её второй раз при подгонке, получаешь конец, торчащий наружу,
  // и Шнайдер дробит даже идеальную прямую.
  const back = endTangent(pts, pts.length - 1, -2);
  const tangents = [endTangent(pts, 0, 2),
    ...extrema.map((e) => extremumTangent(pts, e)),
    { x: -back.x, y: -back.y }];

  const cubics = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const piece = pts.slice(cuts[i], cuts[i + 1] + 1);
    if (piece.length < 2) return null;
    const tStart = tangents[i];
    const tEnd = { x: -tangents[i + 1].x, y: -tangents[i + 1].y };
    const got = fitCurves(piece, tStart, tEnd, tol);
    if (!got.length) return null;
    cubics.push(...got);
  }

  // Проверка: пересобранное неотличимо от исходного в допуске.
  const rebuilt = [];
  for (const bez of cubics) {
    for (let t = 0; t < 10; t += 1) rebuilt.push(evalCubic(bez, t / 10));
  }
  rebuilt.push(cubics[cubics.length - 1][3]);
  if (worstToPolyline(pts, rebuilt) > tol * 1.1) return null;
  return cubics;
}

/**
 * Все пробеги между угловыми узлами — заново, по канону. Концы пробегов
 * стоят на месте (это чужие узлы), меняются внутренние узлы и рычаги концов.
 */
function rebuildRuns(contour, o) {
  const closed = contour.closed !== false;
  if (contour.nodes.length < 2) return;

  if (closed) {
    const c0 = contour.nodes.findIndex((nd) => nd.type === 'corner');
    if (c0 < 0) {
      // Сплошь гладкое кольцо (каунтеры «В», «Р», «Ф»): углов нет, резать
      // пробеги не от чего. Режем от гарантированного экстремума — макушки.
      rebuildRing(contour, o);
      return;
    }
    if (c0 > 0) contour.nodes = contour.nodes.slice(c0).concat(contour.nodes.slice(0, c0));
  }

  const n = contour.nodes.length;
  const corners = [];
  contour.nodes.forEach((nd, i) => { if (nd.type === 'corner') corners.push(i); });
  if (!closed) {
    if (corners[0] !== 0) corners.unshift(0);
    if (corners[corners.length - 1] !== n - 1) corners.push(n - 1);
  }

  const runs = [];
  for (let k = 0; k < corners.length; k += 1) {
    const from = corners[k];
    const isLast = k + 1 === corners.length;
    if (!closed && isLast) break;
    const to = isLast ? n : corners[k + 1];
    const count = to - from;
    if (count < 1) continue;
    const cubics = rebuildRun(contour.nodes, from, count, o.lineTol);
    if (cubics) runs.push({ from, count, cubics });
  }
  if (!runs.length) return;

  runs.sort((a, b) => b.from - a.from);
  for (const r of runs) {
    const first = contour.nodes[r.from];
    const lastNode = contour.nodes[(r.from + r.count) % contour.nodes.length];
    first.out = { ...r.cubics[0][1] };
    lastNode.in = { ...r.cubics[r.cubics.length - 1][2] };
    const inner = [];
    for (let i = 1; i < r.cubics.length; i += 1) {
      inner.push({
        p: { ...r.cubics[i][0] },
        in: { ...r.cubics[i - 1][2] },
        out: { ...r.cubics[i][1] },
        type: 'smooth',
      });
    }
    contour.nodes.splice(r.from + 1, r.count - 1, ...inner);
  }
}

/**
 * Пересборка гладкого кольца: выборка поворачивается так, чтобы начинаться
 * с глобальной макушки (гарантированный экстремум с горизонтальным ходом),
 * дальше — те же куски по экстремумам. Принимается только неотличимое.
 */
function rebuildRing(contour, o) {
  const n = contour.nodes.length;
  if (n < 3) return;
  const per = 12;
  const raw = sampleRun(contour.nodes, 0, n, per).slice(0, -1);   // кольцо без дубля
  if (raw.length < 12) return;

  let topAt = 0;
  for (let i = 1; i < raw.length; i += 1) if (raw[i].y < raw[topAt].y) topAt = i;
  const pts = raw.slice(topAt).concat(raw.slice(0, topAt));
  pts.push({ ...pts[0] });

  const extrema = findExtrema(pts, Math.max(0.8, o.lineTol));
  const topTan = { x: Math.sign(pts[1].x - pts[0].x) || 1, y: 0 };
  const cuts = [0, ...extrema.map((e) => e.idx), pts.length - 1];
  const tangents = [topTan, ...extrema.map((e) => extremumTangent(pts, e)), topTan];

  const cubics = [];
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const piece = pts.slice(cuts[i], cuts[i + 1] + 1);
    if (piece.length < 2) return;
    const tEnd = { x: -tangents[i + 1].x, y: -tangents[i + 1].y };
    const got = fitCurves(piece, tangents[i], tEnd, o.lineTol);
    if (!got.length) return;
    cubics.push(...got);
  }

  const rebuilt = [];
  for (const bez of cubics) {
    for (let t = 0; t < 10; t += 1) rebuilt.push(evalCubic(bez, t / 10));
  }
  rebuilt.push(cubics[cubics.length - 1][3]);
  if (worstToPolyline(pts, rebuilt) > o.lineTol * 1.1) return;

  const nodes = cubics.map((bez, i) => ({
    p: { ...bez[0] },
    in: { ...cubics[(i - 1 + cubics.length) % cubics.length][2] },
    out: { ...bez[1] },
    type: 'smooth',
  }));
  if (nodes.length >= 3) contour.nodes = nodes;
}

const DEG15 = Math.PI / 12;

/**
 * Рычаги, стоящие в паре градусов от «красивого» угла — кратного пятнадцати:
 * 30°, 45°, 60°, 90°… — доворачиваются точно на него. У гладкого узла оба
 * рычага доворачиваются вместе, иначе гладкость сломается. Каждый доворот
 * проверяется: тронутые сегменты не должны уйти от прежней формы.
 */
export function snapHandleAngles(contour, o) {
  const n = contour.nodes.length;
  const closed = contour.closed !== false;
  const segPts = (i) => {
    const a = contour.nodes[i % n];
    const b = contour.nodes[(i + 1) % n];
    const bez = [a.p, a.out ?? a.p, b.in ?? b.p, b.p];
    const pts = [];
    for (let t = 0; t <= 10; t += 1) pts.push(evalCubic(bez, t / 10));
    return pts;
  };
  const rot = (node, which, angle) => {
    const h = node[which];
    const len = Math.hypot(h.x - node.p.x, h.y - node.p.y);
    node[which] = {
      x: node.p.x + Math.cos(angle) * len,
      y: node.p.y + Math.sin(angle) * len,
    };
  };

  contour.nodes.forEach((nd, i) => {
    for (const which of ['out', 'in']) {
      const h = nd[which];
      if (!h) continue;
      const len = Math.hypot(h.x - nd.p.x, h.y - nd.p.y);
      if (len < 0.3) continue;
      const ang = Math.atan2(h.y - nd.p.y, h.x - nd.p.x);
      const snapped = Math.round(ang / DEG15) * DEG15;
      const delta = snapped - ang;
      if (delta === 0 || Math.abs(delta) > (o.snapDeg ?? 3.5) * (Math.PI / 180)) continue;

      const touched = [];
      if (which === 'out' && (closed || i < n - 1)) touched.push(i);
      if (which === 'in' && (closed || i > 0)) touched.push((i - 1 + n) % n);
      const before = touched.map(segPts);
      const saved = { in: nd.in && { ...nd.in }, out: nd.out && { ...nd.out } };
      rot(nd, which, snapped);
      if (nd.type === 'smooth' && nd[which === 'out' ? 'in' : 'out']) {
        rot(nd, which === 'out' ? 'in' : 'out', snapped + Math.PI);
        if (which === 'out' && (closed || i > 0)) touched.push((i - 1 + n) % n);
        else if (which === 'in' && (closed || i < n - 1)) touched.push(i);
        while (before.length < touched.length) before.push(segPts(touched[before.length]));
      }
      const ok = touched.every((si, t) => worstToPolyline(before[t], segPts(si)) <= o.lineTol * 0.7
        && worstToPolyline(segPts(si), before[t]) <= o.lineTol * 0.7);
      if (!ok) { nd.in = saved.in; nd.out = saved.out; }
    }
  });
}

/**
 * Честность типов: узел, чьи рычаги изломаны сильнее honestDeg, — угловой,
 * что бы ни было записано. Иначе человек тянет рычаг «угловатого» узла,
 * зеркалирование гладкого срабатывает — и узел «сам» меняет поведение.
 */
export function honestTypes(contour, honestDeg = 8) {
  for (const nd of contour.nodes) {
    if (nd.type !== 'smooth' || !nd.in || !nd.out) continue;
    const a = { x: nd.p.x - nd.in.x, y: nd.p.y - nd.in.y };
    const b = { x: nd.out.x - nd.p.x, y: nd.out.y - nd.p.y };
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg > honestDeg) nd.type = 'corner';
  }
  return contour;
}

/**
 * Пробное удаление узлов: убрать узел, перефитить два его сегмента одной
 * кубикой и оставить так, только если новая кривая неотличима от прежних
 * (замысел владельца). Канонические узлы не трогаются: угловые — по типу,
 * экстремумы — по осевым рычагам; жертвы — гладкие узлы, оставшиеся от
 * дробления подгонки.
 */
export function dropRedundantNodes(contour, tol) {
  const closed = contour.closed !== false;
  const axial = (h, p) => h && (Math.abs(h.x - p.x) < 1e-6 || Math.abs(h.y - p.y) < 1e-6);
  for (let guard = 0; guard < contour.nodes.length * 2; guard += 1) {
    const n = contour.nodes.length;
    if (n <= (closed ? 3 : 2)) return;
    let dropped = false;
    for (let i = 0; i < n; i += 1) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const nd = contour.nodes[i];
      if (nd.type !== 'smooth') continue;
      if (axial(nd.in, nd.p) && axial(nd.out, nd.p)) continue;   // экстремум — канон
      const prev = contour.nodes[(i - 1 + n) % n];
      const next = contour.nodes[(i + 1) % n];

      const bez1 = [prev.p, prev.out ?? prev.p, nd.in ?? nd.p, nd.p];
      const bez2 = [nd.p, nd.out ?? nd.p, next.in ?? next.p, next.p];
      const pts = [];
      for (let t = 0; t < 12; t += 1) pts.push(evalCubic(bez1, t / 12));
      for (let t = 0; t <= 12; t += 1) pts.push(evalCubic(bez2, t / 12));

      const tStart = endTangent(pts, 0, 2);
      const back = endTangent(pts, pts.length - 1, -2);
      const got = fitCurves(pts, tStart, back, tol * 0.9);
      if (got.length !== 1) continue;
      const bez = got[0];
      const rebuilt = [];
      for (let t = 0; t <= 20; t += 1) rebuilt.push(evalCubic(bez, t / 20));
      if (worstToPolyline(pts, rebuilt) > tol * 0.9
        || worstToPolyline(rebuilt, pts) > tol * 0.9) continue;

      prev.out = prev.out ? { ...bez[1] } : null;
      next.in = next.in ? { ...bez[2] } : null;
      contour.nodes.splice(i, 1);
      dropped = true;
      break;
    }
    if (!dropped) return;
  }
}

/** Прямой сегмент узнаётся по рычагам, лежащим на хорде. */
function isStraight(a, b, eps) {
  const chord = { x: b.p.x - a.p.x, y: b.p.y - a.p.y };
  const len = Math.hypot(chord.x, chord.y);
  if (len < 1e-9) return true;
  const off = (h, from) => (h
    ? Math.abs(chord.x * (h.y - from.p.y) - chord.y * (h.x - from.p.x)) / len
    : 0);
  return off(a.out, a) <= eps && off(b.in, a) <= eps;
}

/**
 * Узел между двумя прямыми, лежащий на их общей прямой, — лишний.
 * Экспортируется: зеркальная пересборка ставит осевые узлы и на прямые
 * кромки, где после неё им делать нечего.
 */
export function dropCollinear(contour, tol) {
  const closed = contour.closed !== false;
  for (let guard = 0; guard < contour.nodes.length; guard += 1) {
    const n = contour.nodes.length;
    if (n <= (closed ? 3 : 2)) return;
    let dropped = false;
    for (let i = 0; i < n; i += 1) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const prev = contour.nodes[(i - 1 + n) % n];
      const cur2 = contour.nodes[i];
      const next = contour.nodes[(i + 1) % n];
      if (!isStraight(prev, cur2, tol * 0.5) || !isStraight(cur2, next, tol * 0.5)) continue;
      const chord = { x: next.p.x - prev.p.x, y: next.p.y - prev.p.y };
      const len = Math.hypot(chord.x, chord.y);
      if (len < 1e-9) continue;
      const off = Math.abs(chord.x * (cur2.p.y - prev.p.y) - chord.y * (cur2.p.x - prev.p.x)) / len;
      if (off > tol * 0.8) continue;
      contour.nodes.splice(i, 1);
      prev.out = { x: prev.p.x + chord.x / 3, y: prev.p.y + chord.y / 3 };
      next.in = { x: next.p.x - chord.x / 3, y: next.p.y - chord.y / 3 };
      dropped = true;
      break;
    }
    if (!dropped) return;
  }
}

/** Все контуры фигуры; счёт приведённых примитивов — для честной сводки. */
export function regularizeShape(shape, opts = {}) {
  let snapped = 0;
  const contours = shape.contours.map((c) => {
    const r = regularizeContour(c, opts);
    if (r.snapped) snapped += 1;
    return r.contour;
  });
  return { contours, snapped };
}
