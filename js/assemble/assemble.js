// assemble/assemble.js — сборка монолайн-иконки из примитивов.
//
// Третье представление рядом с заливкой и осевой: не узлы с рычагами, а
// список примитивов с параметрами — круг, скруглённый прямоугольник (с
// поворотом), отрезок, ломаная, путь из отрезков и дуг, залитое пятно.
// Из него рождается SVG с настоящими <rect>, <circle>, <line>, а править
// можно параметры, а не узлы.
//
// Путь: бинарная маска → пятна отдельно (залитые кружки), остальное → осевая
// (centerline) → цепочки сшиваются СКВОЗЬ развилки там, где продолжают друг
// друга (стойка «Т» не рвёт перекладину; уши робота не рвут голову) → каждая
// цепочка разбирается на отрезки и дуги → по составу кусков узнаётся
// примитив → всё собранное растрится обратно и сверяется с маской: увод края
// — та же мера, что у обводки. Что не собралось, честно отдаётся кривыми.

import { centerline, distanceTransform } from '../trace/centerline.js';
import { segment as components } from '../glyphs/segment.js';
import { threshold } from '../prep/mask.js';
import { traceMask, traceStroke, detectCorners } from '../trace/trace.js';
import { detect, fitCircle } from '../core/primitives.js';
import { rdp, rdpClosed } from '../core/simplify.js';
import { mismatch } from '../trace/rasterize.js';
import { translateShape, signedArea } from '../core/path.js';
import { dist } from '../core/bezier.js';
import { segmentChain, samplePiece, distToSegment } from './pieces.js';

const TAU = Math.PI * 2;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

export const DEFAULTS = {
  fitError: 0.25,    // допуск куска, пиксели исходника (масштабируется вызывающим)
  cornerAngle: 68,   // круче этого поворот осевой — угол ломаной
  blobShare: 0.7,    // толщина ≥ этой доли габарита компоненты — пятно
  minArea: 4,
};

// ─── сшивка цепочек сквозь развилки ─────────────────────────────────────────

/**
 * Направление цепочки на её конце — по участку В ГЛУБИНЕ, от 2·depth до
 * depth от конца, а не по самому концу: у острия стрелки скелет обеих ножек
 * на полтолщины загибается к биссектрисе, и по концу они выглядели
 * встречными (cos −0.83) — сшивались сквозь острие в одну ломаную.
 */
function endDir(points, atStart, depth) {
  const n = points.length;
  const end = atStart ? points[0] : points[n - 1];
  const at = (d) => {
    let k = atStart ? 1 : n - 2;
    while (k > 0 && k < n - 1 && dist(points[k], end) < d) k += atStart ? 1 : -1;
    return points[Math.max(0, Math.min(n - 1, k))];
  };
  const near = at(depth);
  const far = at(depth * 2);
  const d = dist(far, near) > depth * 0.3
    ? { x: near.x - far.x, y: near.y - far.y }
    : { x: end.x - far.x, y: end.y - far.y };
  const l = Math.hypot(d.x, d.y) || 1;
  return { x: d.x / l, y: d.y / l };
}

/**
 * Развилки: концы цепочек, сошедшиеся в одну точку. Скелет отдаёт цепочки
 * с общим пикселем развилки, так что кластер — по близости в пару пикселей.
 * В каждой развилке пары концов, продолжающих друг друга (встречные
 * направления), сшиваются в сквозную цепочку; остальные — ветви.
 */
export function stitchThrough(lines, { radius = 2, depth = 6, straightDeg = 25 } = {}) {
  let chains = lines.map((l) => ({ points: l.points.slice(), width: l.width, closed: l.closed }));
  const cosLimit = -Math.cos((straightDeg * Math.PI) / 180);
  for (let guard = 0; guard < 64; guard += 1) {
    // Концы открытых цепочек, сгруппированные по месту.
    const ends = [];
    chains.forEach((c, ci) => {
      if (c.closed) return;
      ends.push({ ci, atStart: true, p: c.points[0] });
      ends.push({ ci, atStart: false, p: c.points[c.points.length - 1] });
    });
    const groups = [];
    for (const e of ends) {
      const g = groups.find((gr) => dist(gr.p, e.p) <= radius);
      if (g) g.list.push(e); else groups.push({ p: e.p, list: [e] });
    }
    let sewn = false;
    for (const g of groups) {
      if (g.list.length < 2) continue;
      // Лучшая встречная пара: направления к развилке почти противоположны.
      let best = null;
      for (let i = 0; i < g.list.length; i += 1) {
        for (let j = i + 1; j < g.list.length; j += 1) {
          const A = g.list[i];
          const B = g.list[j];
          const da = endDir(chains[A.ci].points, A.atStart, depth);
          const db = endDir(chains[B.ci].points, B.atStart, depth);
          const cos = da.x * db.x + da.y * db.y;
          if (cos <= cosLimit && (!best || cos < best.cos)) best = { A, B, cos };
        }
      }
      if (!best) continue;
      const { A, B } = best;
      if (A.ci === B.ci) {
        // Оба конца одной цепочки в одной развилке — кольцо.
        const c = chains[A.ci];
        c.closed = true;
        c.points.push({ ...c.points[0] });
      } else {
        const a = chains[A.ci];
        const b = chains[B.ci];
        const head = A.atStart ? a.points.slice().reverse() : a.points.slice();
        const tail = B.atStart ? b.points.slice(1) : b.points.slice(0, -1).reverse();
        const joined = {
          points: head.concat(tail),
          width: (a.width * a.points.length + b.width * b.points.length) / (a.points.length + b.points.length),
          closed: false,
        };
        chains = chains.filter((_, i) => i !== A.ci && i !== B.ci).concat([joined]);
      }
      sewn = true;
      break;
    }
    if (!sewn) break;
  }
  return chains;
}

/**
 * Точки в радиусе r от развилок выкидываются: там скелет ныряет к ветви.
 * У разомкнутой цепочки конец в развилке тоже выкидывается: ветвь
 * заканчивается там, где её ПРОДОЛЖЕНИЕ встречает соседей (см.
 * extendToJunctions), а не в точке развилки скелета — у стрелки та стоит
 * на полтолщины раньше острия.
 */
function dampJunctions(chain, junctions, r) {
  if (!junctions.length) return chain.points;
  const near = (p) => junctions.some((j) => dist(p, j) < r);
  const pts = chain.points;
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const endpoint = i === 0 || i === pts.length - 1;
    if (chain.closed ? (endpoint || !near(pts[i])) : !near(pts[i])) out.push(pts[i]);
  }
  return out.length >= 2 ? out : pts;
}

/** Концевой кусок ветви, стоящей у развилки, и её «наружная» сторона. */
function endPieceAt(part, atStart) {
  const pieces = part.pieces;
  return atStart ? { piece: pieces[0], key: 'a' } : { piece: pieces[pieces.length - 1], key: 'b' };
}

const pieceLength = (p) => (p.kind === 'line' ? dist(p.a, p.b) : Math.abs(p.sweep) * p.r);

/** Точка на продолжении куска за его конец, на расстоянии d. */
function beyond(piece, key, d) {
  if (piece.kind === 'line') {
    const dir = key === 'b' ? { x: piece.b.x - piece.a.x, y: piece.b.y - piece.a.y } : { x: piece.a.x - piece.b.x, y: piece.a.y - piece.b.y };
    const l = Math.hypot(dir.x, dir.y) || 1;
    const end = piece[key];
    return { x: end.x + (dir.x / l) * d, y: end.y + (dir.y / l) * d };
  }
  // Дуга продолжается касательной: за скруглением идёт прямой стык.
  const ang = key === 'b' ? piece.a0 + piece.sweep : piece.a0;
  const s = key === 'b' ? Math.sign(piece.sweep) : -Math.sign(piece.sweep);
  const t = { x: -Math.sin(ang) * s, y: Math.cos(ang) * s };
  const end = piece[key];
  return { x: end.x + t.x * d, y: end.y + t.y * d };
}

/**
 * Продлить кусок до точки q: отрезок — сдвигом конца; дуга — НЕ разворотом,
 * а отрезком по касательной из её конца: за скруглением угла к развилке
 * идёт прямой стык, и загиб дуги вгонял ухо робота в голову.
 * Возвращает новый кусок, если он появился.
 */
function extendTo(piece, key, q) {
  if (piece.kind === 'line') { piece[key] = { ...q }; return null; }
  const end = piece[key];
  return key === 'b' ? { kind: 'line', a: { ...end }, b: { ...q } } : { kind: 'line', a: { ...q }, b: { ...end } };
}

/**
 * Ветви у развилок продлеваются до встречи друг с другом: две ножки
 * стрелки сходятся в острие, стойка «Т» упирается в перекладину. Место
 * встречи — ближайшее к развилке пересечение продолжений (перебором точек
 * на продолжениях: работает и для дуг); без пересечения — до проекции
 * развилки на продолжение.
 */
function extendToJunctions(parts, junctions, width) {
  const reach = width * 1.4;
  for (const J of junctions) {
    const ends = [];
    for (const part of parts) {
      if (part.kind === 'blob' || part.closed || !part.pieces || !part.pieces.length) continue;
      for (const atStart of [true, false]) {
        const { piece, key } = endPieceAt(part, atStart);
        if (dist(piece[key], J) <= reach) ends.push({ part, piece, key });
      }
    }
    if (!ends.length) continue;
    // Короткий концевой кусок у развилки — остаток нырка скелета к ветви
    // (у острия стрелки он тянется дальше гашения); снимаем, продлевать
    // будем настоящий кусок за ним.
    for (const e of ends) {
      while (e.part.pieces.length > 1 && pieceLength(e.piece) < width * 0.9) {
        if (e.key === 'b') e.part.pieces.pop(); else e.part.pieces.shift();
        const next = endPieceAt(e.part, e.key === 'a');
        e.piece = next.piece;
      }
    }
    // Точки продолжений с мелким шагом — для поиска встреч.
    const step = Math.max(0.5, width / 40);
    const rays = ends.map((e) => {
      const pts = [];
      for (let d = 0; d <= reach; d += step) pts.push(beyond(e.piece, e.key, d));
      return pts;
    });
    ends.forEach((e, i) => {
      let best = null;
      for (let j = 0; j < ends.length; j += 1) {
        if (j === i) continue;
        // Ближайшая к развилке точка луча i, до луча j не дальше шага.
        for (const p of rays[i]) {
          let near = Infinity;
          for (const q of rays[j]) { const d = dist(p, q); if (d < near) near = d; }
          if (near <= step * 1.5) {
            const dj = dist(p, J);
            if (!best || dj < best.dj) best = { p, dj };
            break;
          }
        }
      }
      if (!best) {
        // Без встречи — до проекции развилки на продолжение.
        let proj = rays[i][0];
        let bd = Infinity;
        for (const p of rays[i]) { const d = dist(p, J); if (d < bd) { bd = d; proj = p; } }
        best = { p: proj };
      }
      const added = extendTo(e.piece, e.key, best.p);
      if (added) {
        if (e.key === 'b') e.part.pieces.push(added); else e.part.pieces.unshift(added);
      }
    });
  }
  // Поля частей — по кускам.
  for (const part of parts) {
    if (part.kind === 'line') { part.a = part.pieces[0].a; part.b = part.pieces[0].b; }
    if (part.kind === 'polyline') part.points = [part.pieces[0].a, ...part.pieces.map((p) => p.b)];
  }
}

/**
 * Кольцо режется в произвольной точке, и один отрезок (или одна дуга) выходит
 * двумя кусками по обе стороны шва. Сшиваем, если они продолжают друг друга.
 */
function mergeSeam(pieces, tol) {
  if (pieces.length < 2) return pieces;
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first.kind === 'line' && last.kind === 'line') {
    const d = distToSegment(first.b, last.a, first.b);
    const mid = distToSegment(first.a, last.a, first.b);
    if (d <= tol && mid <= tol) {
      const merged = { kind: 'line', a: { ...last.a }, b: { ...first.b }, err: Math.max(first.err, last.err) };
      return [merged, ...pieces.slice(1, -1)];
    }
  }
  if (first.kind === 'arc' && last.kind === 'arc'
    && dist(first.c, last.c) <= tol * 2 && Math.abs(first.r - last.r) <= tol * 2) {
    const merged = { ...last, b: { ...first.b }, sweep: last.sweep + first.sweep, err: Math.max(first.err, last.err) };
    return [merged, ...pieces.slice(1, -1)];
  }
  return pieces;
}

// ─── узнавание примитивов по кускам ─────────────────────────────────────────

const angleOf = (v) => Math.atan2(v.y, v.x);
const unit = (v) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const lineDir = (p) => ({ x: p.b.x - p.a.x, y: p.b.y - p.a.y });

/**
 * Замкнутый набор кусков → круг / прямоугольник / скруглённый / капсула /
 * многоугольник / null.
 *
 * Стороны — ДЛИННЫЕ отрезки (не короче толщины штриха с запасом); всё, что
 * между ними, — соединители углов: дуга или короткий срез. На мелких масках
 * скелет режет скруглённый угол наискось, и дуги там нет — есть срез, по
 * длине которого радиус восстанавливается: хорда четверти — r·√2.
 */
export function recognizeClosed(pieces, tol, width = tol * 4) {
  // Круг: все точки всех кусков ложатся на одну окружность. Не по составу
  // кусков: гашение у развилки оставляет в кольце короткую хорду-отрезок.
  {
    // Сверка усечённая: у развилок скелет ныряет к ветви, и пара процентов
    // точек кольца законно выбивается; примитив всё равно проверит fitsChain.
    const pts = pieces.flatMap((p) => samplePiece(p, Math.max(1, tol)));
    const fit = fitCircle(pts);
    if (fit && fit.r > 0) {
      const errs = pts.map((p) => Math.abs(dist(p, fit.c) - fit.r)).sort((a, b) => a - b);
      const p90 = errs[Math.floor(errs.length * 0.9)];
      if (p90 <= tol * 2 && errs[errs.length - 1] <= Math.max(tol * 4, width * 0.35)) return { kind: 'circle', c: fit.c, r: fit.r };
    }
  }
  // Пологая дуга большого радиуса — не угол, а чуть выгнутая сторона
  // (картинка не идеальна): считается стороной по своей хорде.
  const flat = (p) => p.kind === 'arc' && Math.abs(p.sweep) < 0.4 && p.r > width * 3;
  let norm = pieces.map((p) => (flat(p) ? { kind: 'line', a: p.a, b: p.b, err: p.err } : p));
  // Сторона, разорванная гашением развилки, приходит двумя отрезками в одну
  // прямую — сшиваем, иначе стык читался бы как угол в 180°.
  for (let guard = 0; guard < norm.length; guard += 1) {
    let merged = false;
    for (let i = 0; i < norm.length && norm.length > 2; i += 1) {
      const a = norm[i];
      const b = norm[(i + 1) % norm.length];
      if (a.kind !== 'line' || b.kind !== 'line') continue;
      const da = unit(lineDir(a));
      const db = unit(lineDir(b));
      if (da.x * db.x + da.y * db.y < Math.cos((12 * Math.PI) / 180)) continue;
      // Расстояние до ПРЯМОЙ, не до отрезка: продолжение стороны лежит далеко
      // за концом отрезка, и отрезочная мера отвергала бы любую сшивку.
      // Меряется КОРОТКИЙ отрезок относительно прямой длинного: дальний конец
      // длинной стороны при трёх градусах уходит на десятки пикселей.
      if (Math.min(distToLine(b.b, a.a, a.b), distToLine(a.a, b.a, b.b)) > Math.max(tol * 2, width * 0.35)) continue;
      const joined = { kind: 'line', a: a.a, b: b.b, err: Math.max(a.err ?? 0, b.err ?? 0) };
      if (i + 1 === norm.length) {
        // Шов кольца: последний и первый — один отрезок.
        norm = [joined, ...norm.slice(1, i)];
      } else {
        norm.splice(i, 2, joined);
      }
      merged = true;
      break;
    }
    if (!merged) break;
  }
  const isLong = (p) => p.kind === 'line' && dist(p.a, p.b) >= width * 1.2;
  const first = norm.findIndex(isLong);
  if (first < 0) return null;
  const order = norm.slice(first).concat(norm.slice(0, first));
  const groups = [];
  for (const p of order) {
    if (isLong(p)) groups.push({ line: p, conn: [] });
    else groups[groups.length - 1].conn.push(p);
  }
  const lines = groups.map((g) => g.line);
  const conns = groups.flatMap((g) => g.conn);
  const connRadius = (c) => (c.kind === 'arc' ? c.r : dist(c.a, c.b) / Math.SQRT2);

  // Угол — один или несколько соединителей подряд: скелет режет скругление
  // на две дуги разного радиуса. Радиус угла — среднее радиусов дуг по их
  // развороту; развороты в сумме — четверть.
  const cornerOf = (conn) => {
    const arcs = conn.filter((c) => c.kind === 'arc');
    const sweep = arcs.reduce((a, c) => a + Math.abs(c.sweep), 0);
    if (!arcs.length) return { r: conn.length ? median(conn.map(connRadius)) : 0, sweep: 0 };
    return { r: arcs.reduce((a, c) => a + c.r * Math.abs(c.sweep), 0) / sweep, sweep };
  };
  if (groups.length === 4 && groups.every((g) => g.conn.length <= 3)) {
    // Эвристики нарочно мягкие: догадку всё равно проверит сверка с точками
    // осевой (см. fitsChain), а скелет мелкой маски режет углы неровно.
    const corners = groups.map((g) => cornerOf(g.conn));
    const arcOk = corners.every((c) => c.sweep === 0 || Math.abs(c.sweep - Math.PI / 2) < 0.6);
    const radii = corners.filter((c) => c.r > 0).map((c) => c.r);
    const r = radii.length ? median(radii) : 0;
    const spread = radii.length ? Math.max(...radii.map((v) => Math.abs(v - r))) : 0;
    if (arcOk && spread <= Math.max(tol * 4, r * 0.6)) {
      const rect = rectFromLines(lines, r, tol);
      if (rect) return rect;
    }
  }
  // Капсула: две стороны и две полудуги. Размер — по центрам полудуг, а не
  // по длинам сторон: дуги съедают у сторон разное.
  if (groups.length === 2 && conns.length === 2 && conns.every((c) => c.kind === 'arc' && Math.abs(Math.abs(c.sweep) - Math.PI) < 0.6)) {
    const r = median(conns.map((c) => c.r));
    const c0 = conns[0].c;
    const c1 = conns[1].c;
    const c = { x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 };
    return { kind: 'roundRect', c, w: dist(c0, c1) + 2 * r, h: 2 * r, r, angle: normAngle(angleOf({ x: c1.x - c0.x, y: c1.y - c0.y })) };
  }
  // Многоугольник: одни отрезки (короткие тоже — это стороны).
  if (pieces.every((p) => p.kind === 'line') && pieces.length >= 3) {
    return { kind: 'polygon', corners: pieces.map((l) => ({ ...l.a })) };
  }
  // Скруглённый многоугольник: длинные стороны и скругления одного радиуса
  // между ними — молния, треугольник знака, ромб. Вершины — пересечения
  // опорных прямых соседних сторон.
  // Острые вершины (без соединителя) допускаются — у молнии и короны они
  // соседствуют со скруглёнными; у каждой вершины свой радиус.
  if (groups.length >= 3 && groups.every((g) => g.conn.length <= 3)) {
    const corners = groups.map((g) => (g.conn.length ? cornerOf(g.conn) : { r: 0, sweep: 0 }));
    const radii = corners.map((c) => c.r).filter((r) => r > 0);
    const r = radii.length ? median(radii) : 0;
    const spread = radii.length ? Math.max(...radii.map((v) => Math.abs(v - r))) : 0;
    if (r > 0 && spread <= Math.max(tol * 4, r * 0.6)) {
      const verts = [];
      for (let i = 0; i < lines.length; i += 1) {
        const x = crossLines(lines[i], lines[(i + 1) % lines.length]);
        if (!x) return null;
        verts.push(x);
      }
      // Вершина i — между стороной i и стороной i+1; её радиус — у группы i+1.
      const rs = verts.map((_, i) => (corners[(i + 1) % corners.length].r > 0 ? r : 0));
      return { kind: 'roundPolygon', corners: verts, r, radii: rs };
    }
  }
  return null;
}

/** Расстояние от точки до прямой через a и b. */
function distToLine(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l = Math.hypot(vx, vy) || 1;
  return Math.abs(vx * (p.y - a.y) - vy * (p.x - a.x)) / l;
}

/** Пересечение опорных прямых двух отрезков; null, если почти параллельны. */
function crossLines(l1, l2) {
  const d1 = lineDir(l1);
  const d2 = lineDir(l2);
  const den = d1.x * d2.y - d1.y * d2.x;
  const len = Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y);
  if (len < 1e-12 || Math.abs(den) < len * 0.05) return null;
  const t = ((l2.a.x - l1.a.x) * d2.y - (l2.a.y - l1.a.y) * d2.x) / den;
  return { x: l1.a.x + d1.x * t, y: l1.a.y + d1.y * t };
}

const normAngle = (a) => {
  // Прямоугольник симметричен: угол — в (−45°, 45°].
  let d = a;
  while (d <= -Math.PI / 4) d += Math.PI / 2;
  while (d > Math.PI / 4) d -= Math.PI / 2;
  return d;
};

/**
 * Четыре отрезка → прямоугольник (с поворотом): стороны попарно параллельны
 * и перпендикулярны. Размеры — по ОПОРНЫМ ПРЯМЫМ сторон, а не по длинам
 * отрезков: у скруглённого прямоугольника дуги съедают у сторон разное, и
 * длины противоположных сторон честно не равны.
 */
function rectFromLines(lines, r, tol) {
  const dirs = lines.map((l) => { const d = lineDir(l); const len = Math.hypot(d.x, d.y) || 1; return { x: d.x / len, y: d.y / len }; });
  for (let i = 0; i < 4; i += 1) {
    const a = dirs[i];
    const b = dirs[(i + 1) % 4];
    if (Math.abs(a.x * b.x + a.y * b.y) > 0.12) return null;        // не прямой угол
    const o = dirs[(i + 2) % 4];
    if (Math.abs(a.x * o.x + a.y * o.y) < 0.98) return null;        // не параллельны
  }
  // Угол рамки — усреднённое направление сторон, приведённое к (−45°, 45°].
  let sx = 0;
  let sy = 0;
  for (const d of dirs) { const a4 = angleOf(d) * 4; sx += Math.cos(a4); sy += Math.sin(a4); }
  const angle = normAngle(Math.atan2(sy, sx) / 4);
  const cs = Math.cos(-angle);
  const sn = Math.sin(-angle);
  const toFrame = (p) => ({ x: p.x * cs - p.y * sn, y: p.x * sn + p.y * cs });
  // Стороны вдоль x рамки задают y-опоры, стороны вдоль y — x-опоры.
  const xs = [];
  const ys = [];
  lines.forEach((l, i) => {
    const a = toFrame(l.a);
    const b = toFrame(l.b);
    const d = dirs[i];
    const along = Math.abs(d.x * Math.cos(angle) + d.y * Math.sin(angle)) > 0.7;
    if (along) ys.push((a.y + b.y) / 2); else xs.push((a.x + b.x) / 2);
  });
  if (xs.length !== 2 || ys.length !== 2) return null;
  const w = Math.abs(xs[0] - xs[1]);
  const h = Math.abs(ys[0] - ys[1]);
  if (w < tol || h < tol) return null;
  const cf = { x: (xs[0] + xs[1]) / 2, y: (ys[0] + ys[1]) / 2 };
  const c = { x: cf.x * Math.cos(angle) - cf.y * Math.sin(angle), y: cf.x * Math.sin(angle) + cf.y * Math.cos(angle) };
  return { kind: r > 0 ? 'roundRect' : 'rect', c, w, h, r, angle };
}

// ─── растр для проверки ─────────────────────────────────────────────────────

/** Капсула вокруг куска: полигон с круглыми концами, обход положительный. */
function capsule(piece, halfW, step) {
  const pts = samplePiece(piece, step);
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    const d = { x: p1.x - p0.x, y: p1.y - p0.y };
    const l = Math.hypot(d.x, d.y) || 1;
    const nx = -d.y / l;
    const ny = d.x / l;
    left.push({ x: pts[i].x + nx * halfW, y: pts[i].y + ny * halfW });
    right.push({ x: pts[i].x - nx * halfW, y: pts[i].y - ny * halfW });
  }
  // Полукруг конца: от from к to через точку tip (продолжение оси за конец),
  // иначе дуга ушла бы внутрь полосы и капсула стала бы бантом.
  const cap = (centre, from, to, tip) => {
    const out = [];
    const a0 = Math.atan2(from.y - centre.y, from.x - centre.x);
    const a1 = Math.atan2(to.y - centre.y, to.x - centre.x);
    const am = Math.atan2(tip.y - centre.y, tip.x - centre.x);
    const pos = (a) => ((a - a0) % TAU + TAU) % TAU;
    const sweep = pos(am) < pos(a1) ? pos(a1) : pos(a1) - TAU;
    const n = Math.max(4, Math.ceil((Math.abs(sweep) * halfW) / step));
    for (let k = 1; k < n; k += 1) {
      const ang = a0 + (sweep * k) / n;
      out.push({ x: centre.x + halfW * Math.cos(ang), y: centre.y + halfW * Math.sin(ang) });
    }
    return out;
  };
  const last = pts.length - 1;
  const tipEnd = { x: pts[last].x + (pts[last].x - pts[Math.max(0, last - 1)].x), y: pts[last].y + (pts[last].y - pts[Math.max(0, last - 1)].y) };
  const tipStart = { x: pts[0].x - (pts[Math.min(last, 1)].x - pts[0].x), y: pts[0].y - (pts[Math.min(last, 1)].y - pts[0].y) };
  const endCap = cap(pts[last], left[last], right[last], tipEnd);
  const startCap = cap(pts[0], right[0], left[0], tipStart);
  const poly = [...left, ...endCap, ...right.reverse(), ...startCap];
  const nodes = poly.map((p) => ({ p, in: null, out: null, type: 'corner' }));
  const contour = { closed: true, nodes };
  if (signedArea(poly) < 0) contour.nodes.reverse();
  return contour;
}

/** Растровый образ сборки: контуры полигонов, все с положительным обходом (объединение). */
export function assemblyContours(asm, step = 1) {
  const out = [];
  for (const part of asm.parts) {
    if (part.kind === 'blob') { out.push(...part.shape.contours); continue; }
    for (const piece of part.pieces) out.push(capsule(piece, part.width / 2, step));
  }
  return { contours: out };
}

/** Наибольшее расстояние от точек цепочки до ломаной примитива. */
function chainError(part, pts, step = 1) {
  const poly = piecesOf(part).flatMap((p) => samplePiece(p, step));
  let worst = 0;
  for (let k = 0; k < pts.length; k += step) {
    const p = pts[k];
    let best = Infinity;
    for (let i = 1; i < poly.length; i += 1) {
      const d = distToSegment(p, poly[i - 1], poly[i]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

/**
 * Габарит прямоугольника — по КРАЙНИМ точкам осевой в его системе координат:
 * у скруглённого прямоугольника стороны и есть крайние, углы лежат внутри.
 * Опорные прямые по кускам врали: сторона, разбитая на отрезок и пологую
 * дугу, давала опору по хорде — «стоп» выходил на 9 px ниже ростом.
 * Угол в три четверти градуса от осей — шум скелета, не замысел: снимаем.
 */
function refineRect(part, pts) {
  if (part.kind !== 'rect' && part.kind !== 'roundRect') return;
  if (Math.abs(part.angle) < (0.75 * Math.PI) / 180) part.angle = 0;
  const cs = Math.cos(-part.angle);
  const sn = Math.sin(-part.angle);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    const x = p.x * cs - p.y * sn;
    const y = p.x * sn + p.y * cs;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cf = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  part.w = x1 - x0;
  part.h = y1 - y0;
  part.c = { x: cf.x * Math.cos(part.angle) - cf.y * Math.sin(part.angle), y: cf.x * Math.sin(part.angle) + cf.y * Math.cos(part.angle) };
  part.r = Math.min(part.r, Math.min(part.w, part.h) / 2);
}

/**
 * Радиус скругления — подгонкой по точкам цепочки, а не по дугам кусков:
 * скелет режет угол на хорду и дугу не того радиуса, и «стоп» выходил
 * с углами острее, чем нарисован. Габарит по опорным прямым надёжен,
 * радиус — нет; перебор с сужением по наибольшему отклонению.
 */
function refineRadius(part, pts) {
  if (part.kind !== 'roundRect' && part.kind !== 'roundPolygon') return;
  const max = part.kind === 'roundRect' ? Math.min(part.w, part.h) / 2 : part.r * 3;
  // Прореженная сверка: на кольце в 2500 точек полный перебор шёл секунды.
  const thin = Math.max(1, Math.round(pts.length / 400));
  const tryR = (r) => {
    const cand = { ...part, r };
    if (part.radii) cand.radii = part.radii.map((v) => (v > 0 ? r : 0));
    return chainError(cand, pts, thin);
  };
  let best = { r: part.r, err: tryR(part.r) };
  let step = max / 8;
  let centre = part.r;
  for (let pass = 0; pass < 4; pass += 1) {
    for (let k = -4; k <= 4; k += 1) {
      const r = Math.max(0, Math.min(max, centre + k * step));
      const err = tryR(r);
      if (err < best.err) best = { r, err };
    }
    centre = best.r;
    step /= 3;
  }
  part.r = best.r;
  if (part.radii) part.radii = part.radii.map((v) => (v > 0 ? best.r : 0));
}

/** Ложится ли примитив на точки цепочки: наибольшее расстояние точка → ломаная примитива. */
function fitsChain(part, pts, tol) {
  const poly = piecesOf(part).flatMap((p) => samplePiece(p, Math.max(0.5, tol / 2)));
  if (poly.length < 2) return false;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 1; i < poly.length; i += 1) {
      const d = distToSegment(p, poly[i - 1], poly[i]);
      if (d < best) { best = d; if (best <= tol * 0.3) break; }
    }
    if (best > tol) return false;
  }
  return true;
}

// ─── сборка ─────────────────────────────────────────────────────────────────

/** Куски примитива — для растра и для пути SVG. */
function piecesOf(part) {
  if (part.kind === 'circle') {
    const a = { x: part.c.x + part.r, y: part.c.y };
    return [{ kind: 'arc', c: part.c, r: part.r, a, b: { x: part.c.x + part.r * Math.cos(Math.PI), y: part.c.y + part.r * Math.sin(Math.PI) }, a0: 0, sweep: Math.PI },
      { kind: 'arc', c: part.c, r: part.r, a: { x: part.c.x - part.r, y: part.c.y }, b: a, a0: Math.PI, sweep: Math.PI }];
  }
  if (part.kind === 'rect' || part.kind === 'roundRect') {
    const { c, w, h, r = 0, angle = 0 } = part;
    const cs = Math.cos(angle);
    const sn = Math.sin(angle);
    const P = (x, y) => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs });
    const hw = w / 2;
    const hh = h / 2;
    const pieces = [];
    const corners = [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
    const dirs = [[0, 1], [-1, 0], [0, -1], [1, 0]];   // обход по часовой в экранных осях
    for (let i = 0; i < 4; i += 1) {
      const [cx, cy] = corners[i];
      const [nx, ny] = corners[(i + 1) % 4];
      const [dx, dy] = dirs[i];
      const a = P(cx + dx * r, cy + dy * r);
      const b = P(nx - dx * r, ny - dy * r);
      pieces.push({ kind: 'line', a, b });
      if (r > 0) {
        const [ex, ey] = dirs[(i + 1) % 4];
        const centre = P(nx - dx * r + ex * r, ny - dy * r + ey * r);
        const from = b;
        const to = P(nx + ex * r, ny + ey * r);
        pieces.push({ kind: 'arc', c: centre, r, a: from, b: to,
          a0: Math.atan2(from.y - centre.y, from.x - centre.x), sweep: Math.PI / 2 });
      }
    }
    return pieces;
  }
  if (part.kind === 'roundPolygon') {
    // В каждой вершине — дуга радиуса r, касающаяся обеих сторон.
    const n = part.corners.length;
    const pieces = [];
    const tangentPts = part.corners.map((v, i) => {
      const r = part.radii ? part.radii[i] : part.r;
      const prev = part.corners[(i - 1 + n) % n];
      const next = part.corners[(i + 1) % n];
      if (!(r > 0)) return { from: v, to: v, centre: v, r: 0 };
      const u = unit({ x: prev.x - v.x, y: prev.y - v.y });
      const w = unit({ x: next.x - v.x, y: next.y - v.y });
      const cosA = Math.max(-0.999, Math.min(0.999, u.x * w.x + u.y * w.y));
      const half = Math.acos(cosA) / 2;
      const d = Math.min(r / Math.tan(half), dist(v, prev) / 2, dist(v, next) / 2);   // от вершины до точки касания
      const rr = d * Math.tan(half);
      const bis = unit({ x: u.x + w.x, y: u.y + w.y });
      const centre = { x: v.x + bis.x * (rr / Math.sin(half)), y: v.y + bis.y * (rr / Math.sin(half)) };
      return { from: { x: v.x + u.x * d, y: v.y + u.y * d }, to: { x: v.x + w.x * d, y: v.y + w.y * d }, centre, r: rr };
    });
    for (let i = 0; i < n; i += 1) {
      const t = tangentPts[i];
      const nxt = tangentPts[(i + 1) % n];
      const a0 = Math.atan2(t.from.y - t.centre.y, t.from.x - t.centre.x);
      const a1 = Math.atan2(t.to.y - t.centre.y, t.to.x - t.centre.x);
      let sweep = a1 - a0;
      while (sweep <= -Math.PI) sweep += TAU;
      while (sweep > Math.PI) sweep -= TAU;
      if (t.r > 0) pieces.push({ kind: 'arc', c: t.centre, r: t.r, a: t.from, b: t.to, a0, sweep });
      pieces.push({ kind: 'line', a: t.to, b: nxt.from });
    }
    return pieces;
  }
  if (part.kind === 'line') return [{ kind: 'line', a: part.a, b: part.b }];
  if (part.kind === 'polygon' || part.kind === 'polyline') {
    const pts = part.corners ?? part.points;
    const pieces = [];
    for (let i = 0; i + 1 < pts.length; i += 1) pieces.push({ kind: 'line', a: pts[i], b: pts[i + 1] });
    if (part.kind === 'polygon') pieces.push({ kind: 'line', a: pts[pts.length - 1], b: pts[0] });
    return pieces;
  }
  return part.pieces;
}

/**
 * Собрать иконку из примитивов.
 *
 * @param {{w,h,data}} bin — бинарная маска (увеличенная)
 * @param {number} scale — во сколько раз маска крупнее кропа
 * @param {object} opts — fitError, cornerAngle, blobShare, minArea — в пикселях кропа
 * @returns {{parts, width, fit, fallback}} parts — примитивы в пикселях кропа
 */
export function assemble(bin, scale = 1, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tol = o.fitError;
  const parts = [];

  // 1. Пятна — отдельно и заливкой; линии — остаток.
  const lineMask = { w: bin.w, h: bin.h, data: Float32Array.from(bin.data) };
  for (const comp of components(bin, bin, { minArea: Math.max(1, o.minArea * scale * scale) })) {
    const cbin = threshold(comp.mask, 0.5);
    const d = distanceTransform(cbin);
    let maxD = 0;
    for (let i = 0; i < d.length; i += 1) if (d[i] > maxD) maxD = d[i];
    if (2 * maxD < o.blobShare * Math.max(comp.bbox.w, comp.bbox.h)) continue;
    const local = traceMask(comp.mask, scale, { level: 0.5, fitError: tol, minArea: o.minArea });
    const shape = translateShape(local, (comp.bbox.x - comp.pad) / scale, (comp.bbox.y - comp.pad) / scale);
    // Пятно — круг, если ложится; иначе как есть.
    const m = shape.contours.length === 1 ? detect(shape.contours[0], 0.03, { absolute: tol }) : null;
    if (m && m.fits && m.kind === 'circle') parts.push({ kind: 'blob', shape, circle: m.params, area: comp.area });
    else parts.push({ kind: 'blob', shape, area: comp.area });
    // стираем пятно из маски линий
    for (let y = 0; y < comp.bbox.h; y += 1) {
      for (let x = 0; x < comp.bbox.w; x += 1) {
        const v = comp.mask.data[(y + comp.pad) * comp.mask.w + x + comp.pad];
        if (v > 0) lineMask.data[(comp.bbox.y + y) * bin.w + comp.bbox.x + x] = 0;
      }
    }
  }

  // 2. Осевая → сквозные цепочки.
  const lines = centerline(lineMask, scale, o);
  const width = median(lines.map((l) => l.width)) || 1;
  // Радиус развилки — от толщины: у перекрестья «X» скелет даёт не точку,
  // а ромбик, и концы четырёх лучей расходятся на долю толщины.
  const chains = stitchThrough(lines, { radius: Math.max(2 / scale + 0.01, width * 0.45), depth: width * 1.0 });
  // Развилки — места, где сходятся концы (после сшивки — ветви и сквозные).
  const junctions = [];
  for (const c of chains) {
    if (c.closed) continue;
    for (const p of [c.points[0], c.points[c.points.length - 1]]) {
      if (chains.some((d) => d !== c && d.points.some((q) => dist(q, p) < Math.max(2 / scale + 0.01, width * 0.45)))) junctions.push(p);
    }
  }

  // 3. Куски и примитивы.
  let fallback = 0;
  for (const chain of chains) {
    const raw = dampJunctions(chain, junctions, width * 0.8);
    const dense = chain.closed ? raw.slice(0, -1) : raw;
    if (dense.length < 2) continue;
    // Углы ломаной — по упрощённой цепочке, плечами; окно — от толщины.
    const simp = chain.closed ? rdpClosed(dense, tol * 0.5) : rdp(dense, tol * 0.5);
    const span = Math.max(tol * 4, width * 0.7);
    const cornerIdx = detectCorners(simp, o.cornerAngle, span, Math.min(span, 1.6), chain.closed);
    const cornerPts = cornerIdx.map((i) => simp[i]);
    const corners = cornerPts.map((cp) => {
      let best = 0;
      let bd = Infinity;
      dense.forEach((p, i) => { const d = dist(p, cp); if (d < bd) { bd = d; best = i; } });
      return best;
    }).sort((a, b) => a - b);

    let pts = dense;
    let cornerSet = corners;
    if (chain.closed) {
      // Кольцо режем в первом углу, а без углов — в произвольной точке.
      const start = corners.length ? corners[0] : 0;
      pts = dense.slice(start).concat(dense.slice(0, start + 1));
      cornerSet = corners.map((i) => (i - start + dense.length) % dense.length);
    }
    let pieces = segmentChain(pts, tol, { corners: cornerSet, maxRadius: Math.max(bin.w, bin.h) * 2 / scale });
    if (chain.closed) pieces = mergeSeam(pieces, tol);
    const part = { kind: 'path', pieces, width: chain.width, closed: chain.closed };
    if (chain.closed) {
      // Догадка узнавания принимается, только если примитив ложится на
      // точки осевой: примитив навязывает симметрию, и допуск ему вдвое.
      const rec = recognizeClosed(pieces, tol, chain.width);
      if (rec) refineRect(rec, dense);
      if (rec) refineRadius(rec, dense);
      if (rec && fitsChain(rec, dense, Math.max(tol * 2, chain.width * 0.35))) Object.assign(part, rec, { pieces: null });
    } else if (pieces.every((p) => p.kind === 'line')) {
      Object.assign(part, pieces.length === 1
        ? { kind: 'line', a: pieces[0].a, b: pieces[0].b }
        : { kind: 'polyline', points: [pieces[0].a, ...pieces.map((p) => p.b)] });
    }
    if (!part.pieces) part.pieces = piecesOf(part);
    parts.push(part);
  }

  // 4. Ветви — до встречи в развилках.
  extendToJunctions(parts, junctions, width);

  // 5. Проверка: растр сборки против маски.
  const asm = { parts, width };
  const fit = mismatch(bin, assemblyContours(asm, Math.max(0.5, tol)), scale, Math.max(1, o.minArea * scale * scale));
  asm.fit = fit;
  asm.fallback = fallback;
  return asm;
}

/** Дуга ≤ 90° → одна кубика (рычаги по касательным), длиннее — делится. */
function arcCubics(piece) {
  const n = Math.max(1, Math.ceil(Math.abs(piece.sweep) / (Math.PI / 2) - 1e-9));
  const step = piece.sweep / n;
  const k = (4 / 3) * Math.tan(Math.abs(step) / 4) * piece.r;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = piece.a0 + step * i;
    const t1 = t0 + step;
    const p0 = i === 0 ? piece.a : { x: piece.c.x + piece.r * Math.cos(t0), y: piece.c.y + piece.r * Math.sin(t0) };
    const p3 = i === n - 1 ? piece.b : { x: piece.c.x + piece.r * Math.cos(t1), y: piece.c.y + piece.r * Math.sin(t1) };
    const s = Math.sign(step);
    out.push([p0,
      { x: p0.x - s * k * Math.sin(t0), y: p0.y + s * k * Math.cos(t0) },
      { x: p3.x + s * k * Math.sin(t1), y: p3.y - s * k * Math.cos(t1) },
      p3]);
  }
  return out;
}

/**
 * Сборка → обычная фигура из узлов с рычагами: чтобы её показывал тот же
 * холст и правил тот же редактор. Осевые — разомкнутые контуры с толщиной
 * (как у traceStroke), пятна — замкнутые заливкой.
 */
export function assemblyToShape(asm) {
  const contours = [];
  for (const part of asm.parts) {
    if (part.kind === 'blob') { contours.push(...part.shape.contours); continue; }
    const cubics = piecesOf(part).flatMap((p) => (p.kind === 'line' ? [[p.a, null, null, p.b]] : arcCubics(p)));
    if (!cubics.length) continue;
    const closed = part.closed || ['circle', 'rect', 'roundRect', 'polygon', 'roundPolygon'].includes(part.kind);
    const nodes = cubics.map((cur, i) => {
      const prev = i === 0 ? (closed ? cubics[cubics.length - 1] : null) : cubics[i - 1];
      return { p: { ...cur[0] }, in: prev && prev[2] ? { ...prev[2] } : null, out: cur[1] ? { ...cur[1] } : null, type: 'smooth' };
    });
    if (!closed) {
      const last = cubics[cubics.length - 1];
      nodes.push({ p: { ...last[3] }, in: last[2] ? { ...last[2] } : null, out: null, type: 'corner' });
    }
    for (const nd of nodes) honestType(nd);
    contours.push({ closed, nodes, width: asm.width });
  }
  return { contours };
}

/** Тип узла — по излому касательных, как везде: нет рычагов или излом > 8° — угловой. */
function honestType(nd) {
  if (!nd.in || !nd.out) { nd.type = 'corner'; return; }
  const a = { x: nd.p.x - nd.in.x, y: nd.p.y - nd.in.y };
  const b = { x: nd.out.x - nd.p.x, y: nd.out.y - nd.p.y };
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < 1e-9 || lb < 1e-9) { nd.type = 'corner'; return; }
  const cos = (a.x * b.x + a.y * b.y) / (la * lb);
  nd.type = Math.acos(Math.max(-1, Math.min(1, cos))) > (8 * Math.PI) / 180 ? 'corner' : 'smooth';
}

export { piecesOf };
