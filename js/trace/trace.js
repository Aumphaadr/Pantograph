// trace/trace.js — растр в кривые.
//
// Не «обвести пиксели и сгладить», а взять ИЗОЛИНИЮ непрерывного поля мягкой
// маски с линейной интерполяцией по рёбрам ячеек. Положение края между двумя
// пикселями закодировано в их дробных значениях — маршевые квадраты читают
// его напрямую, а не восстанавливают сглаживанием после квантования.
//
// Дальше: упрощение, поиск углов, подгонка кубических кривых. Углы известны
// точно, поэтому узлы сразу рождаются с верным типом smooth/corner — того,
// что нужно редактору, готовый трассировщик отдать не может.

import { rdp, rdpClosed } from '../core/simplify.js';
import { fitCurves, endTangent, norm, sub, dist } from '../core/bezier.js';
import { orient, transform, node } from '../core/path.js';
import { centerline, DEFAULTS as CDEF } from './centerline.js';
import { pad } from '../prep/mask.js';

// ─── маршевые квадраты ──────────────────────────────────────────────────────

// Сегменты направлены так, что внутренняя область всегда слева.
// T/R/B/L — точки на верхнем, правом, нижнем и левом ребре ячейки.
const CASES = {
  1:  [['B', 'L']],
  2:  [['R', 'B']],
  3:  [['R', 'L']],
  4:  [['T', 'R']],
  6:  [['T', 'B']],
  7:  [['T', 'L']],
  8:  [['L', 'T']],
  9:  [['B', 'T']],
  11: [['R', 'T']],
  12: [['L', 'R']],
  13: [['B', 'R']],
  14: [['L', 'B']],
};

const key = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;

/**
 * Замкнутые изолинии поля на уровне level.
 * Маска предварительно окантовывается нулями — тогда контур, упирающийся
 * в край кропа, всё равно замыкается, а не обрывается.
 */
export function isolines(mask, level) {
  const m = pad(mask, 1, 0);
  const { w, h, data } = m;
  const at = (x, y) => data[y * w + x];
  const cut = (a, b) => (level - a) / (b - a);

  const starts = new Map();   // ключ начала -> список концов
  const push = (a, b) => {
    if (!starts.has(key(a))) starts.set(key(a), []);
    starts.get(key(a)).push({ from: a, to: b });
  };

  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      let c = 0;
      if (tl > level) c |= 8;
      if (tr > level) c |= 4;
      if (br > level) c |= 2;
      if (bl > level) c |= 1;
      if (c === 0 || c === 15) continue;

      const pt = {
        T: { x: x + cut(tl, tr), y },
        R: { x: x + 1, y: y + cut(tr, br) },
        B: { x: x + cut(bl, br), y: y + 1 },
        L: { x, y: y + cut(tl, bl) },
      };

      let pairs;
      if (c === 5 || c === 10) {
        // Седло: как соединять, решает значение в середине ячейки.
        const mid = (tl + tr + br + bl) / 4;
        if (c === 5) pairs = mid > level ? [['T', 'L'], ['B', 'R']] : [['T', 'R'], ['B', 'L']];
        else pairs = mid > level ? [['R', 'T'], ['L', 'B']] : [['L', 'T'], ['R', 'B']];
      } else {
        pairs = CASES[c];
      }
      for (const [a, b] of pairs) push(pt[a], pt[b]);
    }
  }

  // Сшивка сегментов в замкнутые петли. Точки на общем ребре двух ячеек
  // считаются из одних и тех же значений, поэтому совпадают побитово.
  const loops = [];
  const used = new Set();
  for (const [k0, list] of starts) {
    for (const seg of list) {
      if (used.has(seg)) continue;
      const loop = [];
      let cur = seg;
      while (cur && !used.has(cur)) {
        used.add(cur);
        loop.push(cur.from);
        const next = (starts.get(key(cur.to)) ?? []).find((s) => !used.has(s));
        if (!next) break;
        cur = next;
      }
      if (loop.length >= 3) loops.push(loop.map((p) => ({ x: p.x - 1, y: p.y - 1 })));
    }
    void k0;
  }
  return loops;
}

// ─── фаска ──────────────────────────────────────────────────────────────────

/** Пересечение прямых (a→b) и (c→d). null, если почти параллельны. */
function crossPoint(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s2 = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s2.y - r.y * s2.x;
  const len = Math.hypot(r.x, r.y) * Math.hypot(s2.x, s2.y);
  if (len < 1e-12 || Math.abs(den) < len * 0.08) return null;   // почти параллельны
  const t = ((c.x - a.x) * s2.y - (c.y - a.y) * s2.x) / den;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

/**
 * Срезать фаску маршевых квадратов.
 *
 * Прямой угол сетка режет наискось, и после упрощения он приходит не вершиной,
 * а короткой ступенькой в пару пикселей — тем самым «рубленым» углом, который
 * видно на М, Н, Т, Щ. Склеить два кандидата в один мало: узел встанет на
 * середину среза, а не в вершину. Поэтому ступенька заменяется ТОЧКОЙ
 * ПЕРЕСЕЧЕНИЯ соседних прямых — там, где угол и был до квантования.
 *
 * Два предохранителя, чтобы не съесть настоящую короткую сторону: ступенька
 * должна быть и коротка сама по себе, и заметно короче обоих соседей.
 */
export function dechamfer(poly, maxBevel, share = 0.34, closed = true) {
  const n = poly.length;
  if (n < 5 || maxBevel <= 0) return poly;
  const at = (i) => poly[(i % n + n) % n];
  const len = (i) => Math.hypot(at(i + 1).x - at(i).x, at(i + 1).y - at(i).y);

  const drop = new Uint8Array(n);
  const moved = new Map();
  for (let i = 0; i < n; i += 1) {
    // У разомкнутой цепочки замыкающего ребра нет, и заворачивать индексы
    // через край — значит мерить фаску по несуществующей хорде между концами.
    if (!closed && (i < 1 || i + 2 > n - 1)) continue;
    if (drop[i] || drop[(i + 1) % n]) continue;
    const bevel = len(i);
    if (bevel > maxBevel) continue;
    const before = len(i - 1);
    const after = len(i + 1);
    if (bevel > before * share || bevel > after * share) continue;

    const x = crossPoint(at(i - 1), at(i), at(i + 1), at(i + 2));
    if (!x) continue;
    const mid = { x: (at(i).x + at(i + 1).x) / 2, y: (at(i).y + at(i + 1).y) / 2 };
    if (Math.hypot(x.x - mid.x, x.y - mid.y) > maxBevel * 1.5) continue;

    moved.set(i, x);
    drop[(i + 1) % n] = 1;
  }
  if (!moved.size) return poly;

  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (drop[i]) continue;
    out.push(moved.get(i) ?? poly[i]);
  }
  return out.length >= 3 ? out : poly;
}

/** Прямая по точкам, ортогональной регрессией: направление плюс точка. */
function fitLine(pts) {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(ang), y: Math.sin(ang) } };
}

/**
 * Поставить угол туда, где он был до квантования.
 *
 * Изолиния идёт по лесенке растра, поэтому узел угла садится на ступеньку и
 * угол выходит «рубленым» — со срезом в пиксель. Настоящая вершина находится
 * пересечением прямых, проложенных по РОВНЫМ участкам с обеих сторон, а сами
 * ступеньки возле угла в расчёт не берутся.
 */
export function sharpenCorners(poly, corners, reach, closed = true, skip = reach * 0.35) {
  if (!corners.length || reach <= 0 || skip >= reach) return poly;
  const n = poly.length;
  const at = (i) => poly[(i % n + n) % n];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /**
   * Точки ровного участка: от угла отступаем на skip, набираем до reach.
   * Берутся не вершины многоугольника, а точки ВДОЛЬ его рёбер с шагом:
   * упрощение выкидывает все вершины прямой, и у чистой кромки внутри окна
   * не оказывалось ни одной — плечо не строилось, и угол так и оставался
   * на срезе антиалиасинга.
   */
  const stepLen = Math.max(0.5, reach / 8);
  const run = (c, dir, skip) => {
    const pts = [];
    let acc = 0;
    let nextAt = skip;
    for (let step = 1; step <= n; step += 1) {
      const j = c + dir * step;
      if (!closed && (j < 0 || j > n - 1)) break;
      const from = at(j - dir);
      const to = at(j);
      const seg = dist(to, from);
      while (nextAt <= acc + seg && nextAt <= reach) {
        const t = seg > 0 ? (nextAt - acc) / seg : 0;
        pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
        nextAt += stepLen;
      }
      acc += seg;
      if (acc >= reach) break;
      if (corners.includes(((j % n) + n) % n)) break;   // до соседнего угла
    }
    return pts;
  };

  // Насколько точки легли на подогнанную прямую. Экстраполировать можно
  // только настоящую прямую: хорда дуги, продолженная за дугу, промахивается —
  // у полукольца «й» так вырастал рог за пределами растра.
  const residual = (pts, line) => {
    let worst = 0;
    for (const p of pts) {
      const d = Math.abs(line.d.x * (p.y - line.p.y) - line.d.y * (p.x - line.p.x));
      if (d > worst) worst = d;
    }
    return worst;
  };
  const straightTol = Math.max(0.6, reach * 0.05);

  const out = poly.map((p) => ({ ...p }));
  for (const c of corners) {
    const ptsA = run(c, -1, skip);
    const ptsB = run(c, 1, skip);
    const a = fitLine(ptsA);
    const b = fitLine(ptsB);
    if (!a || !b) continue;
    if (residual(ptsA, a) > straightTol || residual(ptsB, b) > straightTol) continue;
    const den = a.d.x * b.d.y - a.d.y * b.d.x;
    if (Math.abs(den) < 0.15) continue;              // почти сонаправлены
    const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den;
    const x = { x: a.p.x + a.d.x * t, y: a.p.y + a.d.y * t };
    // Двигаем только если вершина рядом: иначе это не угол, а ошибка подгонки.
    if (dist(x, poly[c]) <= reach) out[c] = x;
  }
  return out;
}

// ─── углы ───────────────────────────────────────────────────────────────────

/**
 * Индексы вершин, где поворот круче порога.
 *
 * Поворот меряется не по соседним вершинам, а по ОКНУ длиной span вдоль
 * контура. Так надо: маршевые квадраты срезают прямой угол фаской в полпикселя,
 * и по соседям он выглядит как два поворота по 45°, то есть не угол вовсе.
 * Раньше фаску случайно съедало упрощение — но тогда распознавание углов
 * зависело от настройки упрощения, чего быть не должно.
 *
 * Меряются ПЛЕЧИ, а не хорды от самой вершины: антиалиасинг скругляет угол
 * на полпикселя-пиксель исходника, и хорда, идущая из вершины, ныряет в это
 * скругление — прямой угол буквы в тридцать пикселей ростом мерился в 50°
 * и пропадал. Плечо начинается с отступа skip от вершины и тянется до span:
 * у скруглённого угла обе прямые за скруглением видны как есть, и поворот
 * выходит настоящий; у плавной дуги радиуса R поворот между плечами —
 * около span/R, и порог его не пропускает.
 *
 * Из окна следует и подавление немаксимумов: один геометрический угол даёт
 * несколько кандидатов подряд, и оставить надо самый крутой.
 */
const SKIP_SHARE = 0.4;   // доля окна, отступаемая от вершины до начала плеча
const SHARP_SKIP = 1;     // отступ плеча вершины от неё, пиксели исходника
const SHARP_REACH = 2;    // длина плеча вершины, пиксели исходника

export function detectCorners(poly, angleDeg, span = 1, cluster = span, closed = true) {
  const n = poly.length;
  if (n < 3) return [];
  const limit = Math.cos((angleDeg * Math.PI) / 180);
  const skip = span * SKIP_SHARE;

  /** Точка на расстоянии d от вершины i вдоль контура в направлении dir. */
  const along = (i, dir, d) => {
    let acc = 0;
    let j = i;
    for (let step = 0; step < n; step += 1) {
      if (!closed && (j + dir < 0 || j + dir > n - 1)) return poly[j];
      const k = (j + dir + n) % n;
      const seg = dist(poly[k], poly[j]);
      if (acc + seg >= d) {
        const t = seg > 0 ? (d - acc) / seg : 0;
        return { x: poly[j].x + (poly[k].x - poly[j].x) * t, y: poly[j].y + (poly[k].y - poly[j].y) * t };
      }
      acc += seg;
      j = k;
    }
    return poly[j];
  };

  const turn = new Float64Array(n).fill(1);
  // У разомкнутой цепочки на концах поворот не определён: там не угол, а обрыв.
  const from = closed ? 0 : 1;
  const upto = closed ? n : n - 1;
  for (let i = from; i < upto; i += 1) {
    const a = norm(sub(along(i, -1, skip), along(i, -1, span)));
    const b = norm(sub(along(i, 1, span), along(i, 1, skip)));
    turn[i] = a.x * b.x + a.y * b.y;   // 1 — идём прямо, 0 — поворот на 90°, −1 — разворот
  }

  const cand = [];
  for (let i = 0; i < n; i += 1) if (turn[i] < limit) cand.push(i);
  if (cand.length === 0) return [];

  // Кандидаты, стоящие ближе cluster друг к другу, — это один и тот же угол.
  // Радиус склейки — НЕ окно измерения: окну надо быть широким, чтобы поворот
  // мерился устойчиво, а склейке узкой, чтобы не съесть соседний настоящий
  // угол. На букве «И» с общим радиусом восемь углов схлопывались в шесть,
  // и подгонка перемахивала через пазухи, заливая их.
  // Сравнивать каждого с каждым соседом нельзя: на квадрате все повороты равны,
  // и при таком сравнении все четверо уступают предшественнику по кругу.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) cum[i + 1] = cum[i] + dist(poly[i], poly[(i + 1) % n]);
  const total = cum[n] || 1;
  const forward = (i, j) => ((cum[j] - cum[i]) % total + total) % total;

  const groups = [[cand[0]]];
  for (let t = 1; t < cand.length; t += 1) {
    if (forward(cand[t - 1], cand[t]) < cluster) groups[groups.length - 1].push(cand[t]);
    else groups.push([cand[t]]);
  }
  if (closed && groups.length > 1 && forward(cand[cand.length - 1], cand[0]) < cluster) {
    groups[0] = groups.pop().concat(groups[0]);
  }

  // Из каждой группы — самый крутой поворот; при равенстве первый.
  let picks = groups
    .map((g) => g.reduce((best, i) => (turn[i] < turn[best] ? i : best), g[0]))
    .sort((a, b) => a - b);

  // Дубли одного физического угла: скруглённое плечо даёт два максимума
  // поворота в паре пикселей друг от друга, и оба переживают склейку по
  // соседству. Два угла ближе ОКНА ИЗМЕРЕНИЯ неразличимы этим окном — это
  // один угол. Но склеивать по одной близости нельзя: у пазухи «И» два
  // настоящих угла стоят через узкую щель. Отличитель — дуга между ними:
  // у плеча она прижата к хорде, у пазухи ныряет вглубь на всю щель.
  const sag = (i, j) => {
    const a = poly[i];
    const b = poly[j];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    let worst = 0;
    for (let t = (i + 1) % n; t !== j; t = (t + 1) % n) {
      const d = Math.abs((b.x - a.x) * (poly[t].y - a.y) - (b.y - a.y) * (poly[t].x - a.x)) / len;
      if (d > worst) worst = d;
    }
    return worst;
  };
  const veryClose = (i, j) => forward(i, j) < span && sag(i, j) < span * 0.35;
  for (let t = 0; t < picks.length && picks.length > 1; ) {
    const i = picks[t];
    const j = picks[(t + 1) % picks.length];
    if (i !== j && (closed || t + 1 < picks.length) && veryClose(i, j)) {
      picks.splice(turn[i] <= turn[j] ? (t + 1) % picks.length : t, 1);
    } else t += 1;
  }
  return picks;
}

// ─── сборка контура ─────────────────────────────────────────────────────────

const arc = (poly, from, to) => {
  const out = [];
  const n = poly.length;
  for (let i = from; ; i = (i + 1) % n) {
    out.push(poly[i]);
    if (i === to) break;
  }
  return out;
};

/**
 * Крайние точки контура — слева, сверху, справа, снизу.
 * По ним режется контур без углов: иначе окружность подгоняется от случайного
 * шва и выходит двумя узлами в произвольных местах вместо четырёх там, где их
 * поставил бы человек.
 */
function extremes(poly) {
  let l = 0, t = 0, r = 0, b = 0;
  for (let i = 1; i < poly.length; i += 1) {
    if (poly[i].x < poly[l].x) l = i;
    if (poly[i].y < poly[t].y) t = i;
    if (poly[i].x > poly[r].x) r = i;
    if (poly[i].y > poly[b].y) b = i;
  }
  return [...new Set([l, t, r, b])].sort((a, c) => a - c);
}

function fitClosed(poly, corners, tol, seamStep = 1) {
  const n = poly.length;
  const isCorner = new Set(corners);
  const splits = corners.length ? corners.slice() : extremes(poly);
  // На плотных точках сосед стоит в пикселе, и касательная по нему дрожит
  // квантованием на 45°; шаг раздвигает окно до пары пикселей маски.
  const step = (m) => Math.max(1, Math.min(seamStep, Math.floor((m - 1) / 2)));

  if (splits.length < 2) {
    const pts = poly.concat([poly[0]]);
    const t = endTangent(pts, 0, step(pts.length));
    const cubics = fitCurves(pts, t, { x: -t.x, y: -t.y }, tol);
    if (!cubics.length) return null;
    return {
      closed: true,
      nodes: cubics.map((cur, i) => node(cur[0], cubics[(i - 1 + cubics.length) % cubics.length][2],
        cur[1], 'smooth')),
    };
  }

  // Касательная в точке разреза. У гладкого разреза обе стороны берут ОДНУ
  // и ту же прямую с разными знаками — только так узел выходит по-настоящему
  // гладким, а не просто помеченным гладким.
  const seam = splits.map((i) => (isCorner.has(i)
    ? null
    : norm(sub(poly[(i + seamStep) % n], poly[(i - seamStep + n * seamStep) % n]))));

  const cubics = [];
  const cornerAt = new Set();

  for (let k = 0; k < splits.length; k += 1) {
    const from = splits[k];
    const to = splits[(k + 1) % splits.length];
    const pts = arc(poly, from, to);
    if (pts.length < 2) continue;

    const tStart = seam[k] ?? endTangent(pts, 0, step(pts.length));
    const kEnd = (k + 1) % splits.length;
    const tEnd = seam[kEnd]
      ? { x: -seam[kEnd].x, y: -seam[kEnd].y }
      : endTangent(pts, pts.length - 1, -step(pts.length));

    if (isCorner.has(from)) cornerAt.add(cubics.length);
    cubics.push(...fitCurves(pts, tStart, tEnd, tol));
  }
  if (cubics.length === 0) return null;

  const nodes = cubics.map((cur, i) => {
    const prev = cubics[(i - 1 + cubics.length) % cubics.length];
    return node(cur[0], prev[2], cur[1], cornerAt.has(i) ? 'corner' : 'smooth');
  });
  return { closed: true, nodes };
}

/**
 * Ставит найденные вершины углов НА плотную изолинию.
 *
 * Углы ищутся по упрощённому многоугольнику — по плотному их не измерить.
 * А подгонка должна идти по плотному: упрощение выкидывает все точки прямой,
 * и сегмент между двумя её концами остаётся без свидетелей — maxError меряет
 * только внутренние точки, их нет, и кривая с чужими касательными вольна
 * выгибаться куда угодно, «пройдя» проверку с нулевой ошибкой. Ровно так
 * прямые стороны букв и уходили дугами в пустоту.
 *
 * Точки плотной линии в радиусе фаски вокруг вершины гасятся: там лежат
 * пиксели срезанного угла, и они тянули бы кривую прочь от настоящей вершины.
 *
 * @returns {{pts: Pt[], cuts: number[]}} плотное кольцо и индексы углов в нём
 */
function anchorCorners(loop, sharp, corners, radius) {
  if (!corners.length) return { pts: loop, cuts: [] };
  const n = loop.length;
  const r2 = radius * radius;
  const mark = new Int32Array(n).fill(-1);
  const drop = new Uint8Array(n);

  corners.forEach((ci, t) => {
    const q = sharp[ci];
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (mark[i] >= 0) continue;
      const dx = loop[i].x - q.x;
      const dy = loop[i].y - q.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return;
    mark[best] = t;
    for (const dir of [1, -1]) {
      for (let sft = 1; sft < n; sft += 1) {
        const j = (((best + dir * sft) % n) + n) % n;
        if (mark[j] >= 0) break;
        const dx = loop[j].x - q.x;
        const dy = loop[j].y - q.y;
        if (dx * dx + dy * dy > r2) break;
        drop[j] = 1;
      }
    }
  });

  const pts = [];
  const cuts = [];
  for (let i = 0; i < n; i += 1) {
    if (mark[i] >= 0) {
      cuts.push(pts.length);
      pts.push(sharp[corners[mark[i]]]);
    } else if (!drop[i]) {
      pts.push(loop[i]);
    }
  }
  return { pts, cuts };
}

// ─── вход ───────────────────────────────────────────────────────────────────

// Все длины — в пикселях ИСХОДНИКА, а не увеличенной маски. Иначе ползунок
// увеличения молча менял бы плотность узлов: при ×6 допуск в 0.55 пикселя маски
// это 0.09 пикселя исходника, вшестеро строже, чем при ×1.
export const DEFAULTS = {
  level: 0.5,        // уровень изолинии
  simplify: 0.18,    // допуск упрощения, пиксели исходника
  cornerAngle: 68,   // круче этого поворот считается углом, градусы
  cornerSpan: 2,     // на какой длине контура мерить поворот, пиксели исходника
  maxBevel: 3,       // фаска не длиннее этого срезается, пиксели МАСКИ
  fitError: 0.25,    // допустимое отклонение кривой от точек, пиксели исходника
  minArea: 4,        // мельче этого — мусор генерации, пиксели исходника
};

/**
 * Маска → Shape. Выход ВСЕГДА в crop-пространстве: увеличение делится обратно
 * здесь и наружу не протекает (инвариант 1).
 *
 * @param {{w,h,data:Float32Array}} mask — увеличенная мягкая маска
 * @param {number} scale — коэффициент увеличения, на который её увеличили
 */
export function traceMask(mask, scale = 1, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const contours = [];

  for (const loop of isolines(mask, o.level)) {
    // Допуски переводим в пиксели маски: наружу параметры выражены в исходнике.
    // Фаска — величина сетки, а не фигуры, поэтому её порог в пикселях маски.
    const poly = dechamfer(rdpClosed(loop, o.simplify * scale), o.maxBevel);
    if (poly.length < 3) continue;

    let area = 0;
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      area += p.x * q.y - q.x * p.y;
    }
    // Порог задан в пикселях исходника, а не увеличенной маски: «выбросить
    // пятна мельче четырёх пикселей» человеку понятно, «мельче ста сорока
    // четырёх» — нет, да ещё и меняется от коэффициента увеличения.
    if (Math.abs(area / 2) / (scale * scale) < o.minArea) continue;

    // Склейка кандидатов — только на длину фаски маршевых квадратов (около
    // пикселя маски), а не на всё окно измерения.
    const corners = detectCorners(poly, o.cornerAngle, o.cornerSpan * scale,
      Math.min(o.cornerSpan * scale, 1.6));
    // Углы ставятся в настоящую вершину, а не на ступеньку растра. Плечо
    // начинается за скруглением антиалиасинга — с пикселя исходника от вершины:
    // точки среза внутри плеча кренили прямую, и вершина промахивалась на
    // 0.2 px, а подгонка ставила на кромке лишний узел.
    // Плечо от пикселя до двух от вершины — в пикселях исходника, не окна:
    // скругление антиалиасинга одно на все размеры, а длинное плечо у
    // засечек упирается в соседний угол и не строится вовсе.
    const sharp = sharpenCorners(poly, corners, SHARP_REACH * scale, true, SHARP_SKIP * scale);
    // Подгонка идёт по ПЛОТНОЙ изолинии с воткнутыми в неё вершинами углов:
    // упрощённый многоугольник — только для поиска углов (см. anchorCorners).
    // Радиус гашения — от окна угла: скруглённое плечо тянется дальше фаски,
    // и его свидетели прогибали прямые кромки внутрь, а у вершин заставляли
    // подгонку дробиться — узлы толпились по два-три на угол.
    // Не меньше пикселя исходника: антиалиасинг скругляет угол именно на
    // столько, и уцелевшие точки скругления втягивали бы в подгонку лишний узел.
    const { pts, cuts } = anchorCorners(loop, sharp, corners, Math.max(2, o.maxBevel, scale));
    const seamStep = Math.max(2, Math.round((o.cornerSpan * scale) / 2));
    const contour = fitClosed(pts, cuts, o.fitError * scale, seamStep);
    if (contour) contours.push(contour);
  }

  // Отсчёт маски — ЦЕНТР пикселя: изолиния считается между отсчётами
  // (x, y), а пиксель x покрывает [x, x+1) — так же его видит и рендер
  // расхождения, и SVG поверх картинки. Без этой половины контур лежал
  // выше-левее истины на 0.5/scale — сверка с настоящими шрифтами показала.
  return orient(transform({ contours }, (p) => ({ x: (p.x + 0.5) / scale, y: (p.y + 0.5) / scale })));
}

/** Разомкнутая цепочка → контур. Отличий от замкнутой два: концы никуда не
 *  заворачиваются, и первый узел не имеет входящего рычага, последний —
 *  исходящего. */
function fitOpen(poly, corners, tol, seamStep = 1) {
  if (poly.length < 2) return null;
  const isCorner = new Set(corners);
  const splits = [0, ...corners.filter((i) => i > 0 && i < poly.length - 1), poly.length - 1];

  const cubics = [];
  const cornerAt = new Set();
  for (let k = 0; k < splits.length - 1; k += 1) {
    const from = splits[k];
    const to = splits[k + 1];
    const pts = poly.slice(from, to + 1);
    if (pts.length < 2) continue;
    const st = Math.max(1, Math.min(seamStep, Math.floor((pts.length - 1) / 2)));
    const tStart = endTangent(pts, 0, st);
    const tEnd = endTangent(pts, pts.length - 1, -st);
    if (isCorner.has(from)) cornerAt.add(cubics.length);
    cubics.push(...fitCurves(pts, tStart, tEnd, tol));
  }
  if (!cubics.length) return null;

  const nodes = cubics.map((cur, i) => node(
    cur[0],
    i === 0 ? null : cubics[i - 1][2],
    cur[1],
    cornerAt.has(i) || i === 0 ? 'corner' : 'smooth',
  ));
  const last = cubics[cubics.length - 1];
  nodes.push(node(last[3], last[2], null, 'corner'));
  return { closed: false, nodes };
}

export const STROKE_DEFAULTS = { ...CDEF };

/**
 * Маска → осевые линии как контуры со своей толщиной.
 *
 * Выход — те же Shape и crop-пространство, что у traceMask (инвариант 1), но
 * контуры РАЗОМКНУТЫ и у каждого есть `width`: без толщины осевая линия —
 * не фигура, а просто кривая.
 */
export function traceStroke(mask, scale = 1, opts = {}) {
  const o = { ...DEFAULTS, ...STROKE_DEFAULTS, ...opts };
  const contours = [];

  // Осевая линия идёт по пиксельной сетке маски и ступенчата сама по себе:
  // её собственный шум — около полупикселя. Допуск мельче этого не уточняет
  // фигуру, а протоколирует ступеньки: у кольца в 1254 px выходило 1134 узла
  // вместо десятка. Поэтому у допусков есть пол, зависящий от увеличения.
  const grid = 0.7 / scale;
  const simp = Math.max(o.simplify, grid);
  const tol = Math.max(o.fitError, grid);
  const span = Math.max(o.cornerSpan, grid * 2);

  for (const line of centerline(mask, scale, o)) {
    // Точки осевой уже поделены на увеличение, поэтому на scale умножать
    // не надо: и они, и допуски — в пикселях исходника.
    const dense = line.closed ? line.points.slice(0, -1) : line.points;
    let poly = line.closed ? rdpClosed(dense, simp) : rdp(dense, simp);
    if (poly.length < 2) continue;

    // Срединная ось прямого угла — фаска в сорок пять градусов длиной с толщину
    // штриха: скелету в вершину не попасть, он идёт по биссектрисе. Поэтому
    // фаска срезается с порогом от ТОЛЩИНЫ, и окно поиска углов — тоже от неё.
    const bevel = Math.max(simp * 2, line.width * 0.85);
    poly = dechamfer(poly, bevel, 0.5, line.closed);
    const span2 = Math.max(span, line.width * 0.7);
    const corners = detectCorners(poly, o.cornerAngle, span2, Math.min(span2, 1.6), line.closed);
    const sharp = sharpenCorners(poly, corners, Math.max(span2 * 2.5, line.width * 1.6), line.closed);
    // Подгонка — по плотной цепочке, углы к ней приколоты (см. anchorCorners):
    // упрощение оставляет прямую без свидетелей, и кривая на ней гуляла.
    const { pts, cuts } = anchorCorners(dense, sharp, corners, line.width * 0.9);
    const seamStep = Math.max(2, Math.round(span * scale) || 2);
    const contour = line.closed
      ? fitClosed(pts, cuts, tol, seamStep)
      : fitOpen(pts, cuts, tol, seamStep);
    if (!contour) continue;
    contour.width = line.width;
    contours.push(contour);
  }

  return { contours };
}
