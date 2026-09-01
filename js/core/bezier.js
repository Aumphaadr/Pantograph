// core/bezier.js — кубические кривые и подгонка их под последовательность точек.
//
// Алгоритм подгонки — Шнайдера («An Algorithm for Automatically Fitting
// Digitized Curves», Graphics Gems, 1990): наименьшие квадраты по хордовой
// параметризации, уточнение параметров Ньютоном, рекурсивное деление в точке
// наибольшей ошибки. Кривые кубические, потому что такими их принимает и SVG,
// и таблица CFF: ни одного преобразования на всём пути до шрифта.

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a) {
  const l = Math.hypot(a.x, a.y);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/**
 * Касательная в точке pts[i], направленная внутрь последовательности.
 *
 * Хорда до соседа даёт направление с ошибкой первого порядка — этого мало:
 * перекошенная на пару процентов касательная не даёт подгонке лечь на кривую
 * ни при каком допуске, и та начинает без нужды дробить дугу. Берём производную
 * параболы через три точки, причём с неравномерным шагом: после упрощения
 * интервалы между точками разные.
 */
export function endTangent(pts, i, step) {
  const i1 = i + step;
  const i2 = i + step * 2;
  if (i1 < 0 || i1 >= pts.length) return { x: 0, y: 0 };
  if (i2 < 0 || i2 >= pts.length) return norm(sub(pts[i1], pts[i]));

  const s1 = dist(pts[i1], pts[i]);
  const s2 = s1 + dist(pts[i2], pts[i1]);
  if (s1 === 0 || s2 === 0 || s1 === s2) return norm(sub(pts[i1], pts[i]));

  const a = -(s1 + s2) / (s1 * s2);
  const b = s2 / (s1 * (s2 - s1));
  const c = -s1 / (s2 * (s2 - s1));
  return norm({
    x: pts[i].x * a + pts[i1].x * b + pts[i2].x * c,
    y: pts[i].y * a + pts[i1].y * b + pts[i2].y * c,
  });
}

/** Точка на кубической кривой. */
export function evalCubic(b, t) {
  const u = 1 - t;
  const a0 = u * u * u;
  const a1 = 3 * u * u * t;
  const a2 = 3 * u * t * t;
  const a3 = t * t * t;
  return {
    x: b[0].x * a0 + b[1].x * a1 + b[2].x * a2 + b[3].x * a3,
    y: b[0].y * a0 + b[1].y * a1 + b[2].y * a2 + b[3].y * a3,
  };
}

function evalDeriv1(b, t) {
  const u = 1 - t;
  return {
    x: 3 * u * u * (b[1].x - b[0].x) + 6 * u * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * u * u * (b[1].y - b[0].y) + 6 * u * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
}

function evalDeriv2(b, t) {
  const u = 1 - t;
  return {
    x: 6 * u * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * u * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  };
}

/** Разбить точку кривой на параметр по накопленной длине хорд. */
function chordParams(pts, i0, i1) {
  const u = [0];
  for (let i = i0 + 1; i <= i1; i += 1) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]));
  const total = u[u.length - 1];
  if (total === 0) return u.map((_, i) => i / (u.length - 1 || 1));
  return u.map((v) => v / total);
}

/** Наименьшие квадраты: длины рычагов при заданных концах и касательных. */
function generateBezier(pts, i0, i1, u, t1, t2) {
  const p0 = pts[i0];
  const p3 = pts[i1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 0; i < u.length; i += 1) {
    const t = u[i];
    const b0 = (1 - t) ** 3;
    const b1 = 3 * (1 - t) ** 2 * t;
    const b2 = 3 * (1 - t) * t * t;
    const b3 = t ** 3;
    const a1 = mul(t1, b1);
    const a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(pts[i0 + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }

  const det = c00 * c11 - c01 * c01;
  let alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;

  // Система вырождается, когда касательные почти параллельны, а это на штрихе
  // толщиной в пиксель случается постоянно. Решение тогда уходит в бесконечность:
  // сами узлы остаются на месте, а рычаги улетают за пределы кропа, и кривая
  // делает петлю через полкартинки. Держим длину рычага в разумных рамках.
  // У честной дуги рычаг короче хорды: у четверти окружности их отношение
  // около 0.39, у половины — 0.67. Всё, что длиннее самой хорды, — признак
  // вырожденной системы, а не формы. Раньше запас был двойной, и на почти
  // прямом участке рычаг в 80 при хорде 49 уводил кривую в сторону, заливая
  // пазуху буквы «И».
  //
  // Длину зажимаем поодиночке: направление задано касательной и верно,
  // подгонка решает только «насколько далеко», и портится обычно одна сторона.
  const segLen = dist(p0, p3);
  const low = 1e-6 * segLen;
  // 1.4 подобрано по замеру: до этого значения буква «И» держится, при 1.6
  // ломается снова, а экономия узлов между ними — единицы процентов.
  const MAX_SHARE = 1.4;
  const fix = (a) => {
    if (!Number.isFinite(a) || a < low) return segLen / 3;
    return Math.min(a, segLen * MAX_SHARE);
  };
  alpha1 = fix(alpha1);
  alpha2 = fix(alpha2);
  return [p0, add(p0, mul(t1, alpha1)), add(p3, mul(t2, alpha2)), p3];
}

/** Уточнение параметров одним шагом Ньютона — Рафсона. */
function reparameterize(pts, i0, i1, u, bez) {
  return u.map((t, i) => {
    const p = pts[i0 + i];
    const d = sub(evalCubic(bez, t), p);
    const d1 = evalDeriv1(bez, t);
    const d2 = evalDeriv2(bez, t);
    const den = dot(d1, d1) + dot(d, d2);
    return den === 0 ? t : t - dot(d, d1) / den;
  });
}

function maxError(pts, i0, i1, bez, u) {
  let worst = 0;
  let at = Math.floor((i1 - i0 + 1) / 2);
  for (let i = 1; i < u.length - 1; i += 1) {
    const d = dist(evalCubic(bez, u[i]), pts[i0 + i]);
    if (d * d > worst) { worst = d * d; at = i; }
  }
  return { err: Math.sqrt(worst), at: i0 + at };
}

function fitRun(pts, i0, i1, t1, t2, tol, out, depth) {
  if (i1 - i0 === 1) {
    const d = dist(pts[i0], pts[i1]) / 3;
    out.push([pts[i0], add(pts[i0], mul(t1, d)), add(pts[i1], mul(t2, d)), pts[i1]]);
    return;
  }

  let u = chordParams(pts, i0, i1);
  let bez = generateBezier(pts, i0, i1, u, t1, t2);
  let { err, at } = maxError(pts, i0, i1, bez, u);

  // Хордовая параметризация — лишь первое приближение; настоящие параметры
  // уточняются Ньютоном. Делить кривую можно только после этого, иначе одна
  // честная кубика дробится на десяток.
  for (let k = 0; k < 12 && err >= tol; k += 1) {
    const u2 = reparameterize(pts, i0, i1, u, bez);
    const bez2 = generateBezier(pts, i0, i1, u2, t1, t2);
    const m2 = maxError(pts, i0, i1, bez2, u2);
    if (m2.err >= err) break;            // перестало улучшаться
    u = u2; bez = bez2; err = m2.err; at = m2.at;
  }

  if (err < tol) { out.push(bez); return; }

  if (depth <= 24) {
    // Если точка наибольшей ошибки пришлась на край, делим пополам: лишь бы
    // продвинуться. Отдавать негодную кривую только потому, что не нашлось
    // места разреза, нельзя — на острой пазухе она перемахивает через вырез
    // и заливает его.
    let at2 = at;
    if (at2 <= i0 || at2 >= i1) at2 = Math.floor((i0 + i1) / 2);
    if (at2 > i0 && at2 < i1) {
      // На плотных точках соседи стоят в пикселе друг от друга, и касательная
      // по ним дрожит квантованием на 45°; окно чуть шире успокаивает её.
      const s = Math.min(2, at2 - i0, i1 - at2);
      const center = norm(sub(pts[at2 - s], pts[at2 + s]));
      fitRun(pts, i0, at2, t1, center, tol, out, depth + 1);
      fitRun(pts, at2, i1, { x: -center.x, y: -center.y }, t2, tol, out, depth + 1);
      return;
    }
  }

  // Делить больше некуда. Кладём заведомо неразмашистую кривую по трети хорды,
  // а не ту, что вышла у наименьших квадратов: она может уйти куда угодно.
  const d = dist(pts[i0], pts[i1]) / 3;
  out.push([pts[i0], add(pts[i0], mul(t1, d)), add(pts[i1], mul(t2, d)), pts[i1]]);
}

/**
 * Подогнать цепочку кубических кривых под точки [i0..i1].
 * @returns {Array<[Pt,Pt,Pt,Pt]>}
 */
export function fitCurves(pts, tStart, tEnd, tol) {
  if (pts.length < 2) return [];
  const out = [];
  fitRun(pts, 0, pts.length - 1, tStart, tEnd, tol, out, 0);
  return out;
}
