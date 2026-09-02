// tune/tune.js — авто-подбор параметров по метрике расхождения.
//
// Замысел владельца: словить нужный контур за минимальное число узлов,
// регулярно сверяя растровый кроп с рендером контура — сверка и подсказывает,
// куда двигать параметры. Здесь только логика поиска, без воркера и DOM:
// evaluate приходит снаружи, поэтому спуск тестируется на подделке.
//
// Целевая функция — баланс, а не «минимум узлов под потолком». Правило
// владельца: если семь узлов дают сходство 96 %, а восемь — 99 %, брать
// восемь. Поэтому узел стоит фиксированную долю увода края (NODE_COST,
// пикселей на узел на одну букву), и минимизируется сумма
//   увод + NODE_COST · узлов / букв.
// Прежний лексикографический минимум узлов под потолком в полпикселя на
// настоящем шрифте (Lato) сбрасывал четверть узлов, утраивая увод от
// истинных контуров: 0.16 → 0.54 px. Потолок остаётся предохранителем от
// патологий, но привязан к исходному состоянию, а не к полупикселю.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Цена узла в пикселях увода края — на одну букву (у иконки букв одна). */
export const NODE_COST = 0.02;

/** Что минимизируется: увод плюс плата за узлы. units — сколько букв. */
export const objective = (r) => r.drift + (NODE_COST * r.nodes) / Math.max(1, r.units ?? 1);

/**
 * Оси поиска. У каждой — кандидаты вокруг текущего значения: на грубом
 * проходе шире, на тонком ближе. Значения в тех же единицах, что и params.
 */
export function axesFor(base) {
  const rel = (mults, lo, hi) => (v, fine) => {
    const ms = fine ? mults.map((m) => 1 + (m - 1) / 2) : mults;
    return [...new Set(ms.map((m) => clamp(+(v * m).toFixed(3), lo, hi)))].filter((x) => x !== v);
  };
  const abs = (steps, lo, hi) => (v, fine) => {
    const ss = fine ? steps.map((s) => s / 2) : steps;
    return [...new Set(ss.map((s) => clamp(+(v + s).toFixed(3), lo, hi)))].filter((x) => x !== v);
  };
  return [
    { key: 'level', values: abs([-0.15, -0.05, 0.05, 0.15], 0.2, 0.8) },
    { key: 'tolerance', values: abs([-40, -15, 15, 40], 10, 220) },
    { key: 'simplify', values: rel([0.5, 0.75, 1.5, 2.5], 0.02, base.simplify * 6 + 1) },
    { key: 'fitError', values: rel([0.5, 0.75, 1.5, 2.5], 0.05, base.fitError * 6 + 1) },
    { key: 'cornerAngle', values: abs([-16, -8, 8, 16], 40, 110) },
    { key: 'cornerSpan', values: rel([0.6, 1.5], 0.2, base.cornerSpan * 4 + 1) },
    { key: 'open', values: (v) => [0, 1].filter((x) => x !== v) },
    { key: 'close', values: (v) => [0, 1].filter((x) => x !== v) },
  ];
}

/** Кандидат годен, когда контур сходится с растром и не теряет куски. */
const valid = (r, cap, comps) => r && Number.isFinite(r.nodes)
  && r.drift <= cap && Math.abs(r.compRen - r.compBin) <= comps;

const better = (a, b, cap, comps) => {
  const va = valid(a, cap, comps);
  const vb = valid(b, cap, comps);
  if (va !== vb) return va;
  if (!va) return a.drift + Math.abs(a.compRen - a.compBin) < b.drift + Math.abs(b.compRen - b.compBin);
  const ja = objective(a);
  const jb = objective(b);
  if (Math.abs(ja - jb) > 1e-9) return ja < jb;
  return a.nodes < b.nodes;
};

/**
 * Покоординатный спуск: два прохода, грубый и тонкий.
 *
 * @param {object} o
 * @param {(params:object)=>Promise<{nodes,drift,compBin,compRen,units}>} o.evaluate
 * @param {object} o.base — исходные параметры (не меняются)
 * @param {()=>boolean} o.aborted — проверяется перед каждым прогоном
 * @param {(step:number,total:number,best:object)=>void} [o.onStep]
 * @returns {{params, result, baseline, steps, aborted}}
 */
export async function descend({ evaluate, base, aborted = () => false, onStep }) {
  const axes = axesFor(base);
  const total = 1 + axes.reduce((a, ax) => a + ax.values(base[ax.key] ?? 0, false).length, 0)
    + axes.reduce((a, ax) => a + ax.values(base[ax.key] ?? 0, true).length, 0);

  let step = 0;
  const baseline = await evaluate(base);
  step += 1;
  // Потолок — предохранитель: увод не хуже полуторного исходного (и хотя бы
  // на десятую пикселя свободы). Компонент терять нельзя больше, чем
  // теряется сейчас.
  const cap = Math.max(baseline.drift * 1.5, baseline.drift + 0.1);
  const comps = Math.abs(baseline.compRen - baseline.compBin);

  let bestParams = { ...base };
  let best = baseline;
  if (onStep) onStep(step, total, { ...best, params: bestParams });

  for (const fine of [false, true]) {
    for (const axis of axes) {
      const current = bestParams[axis.key];
      if (current === undefined) continue;
      for (const value of axis.values(current, fine)) {
        if (aborted()) {
          return { params: bestParams, result: best, baseline, steps: step, aborted: true };
        }
        const cand = { ...bestParams, [axis.key]: value };
        const r = await evaluate(cand);   // eslint-disable-line no-await-in-loop
        step += 1;
        if (better(r, best, cap, comps)) {
          best = r;
          bestParams = cand;
        }
        if (onStep) onStep(step, total, { ...best, params: bestParams });
      }
    }
  }
  return { params: bestParams, result: best, baseline, steps: step, aborted: false };
}
