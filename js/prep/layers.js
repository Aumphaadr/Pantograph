// prep/layers.js — несколько чернил на одном кропе.
//
// Фон у кропа один, разные только чернила: у слоя своё лишь два — цвет штриха
// и допуск. Параметры маски и кривых общие, они про растр, а не про цвет
// (см. BACKLOG.md, п. 1).

import { colorDistance } from './mask.js';

/**
 * Спорные пиксели: спад яркости между двумя цветами принадлежит обоим сразу.
 * «Победитель забирает всё» — пиксель отходит слою с наибольшим мягким
 * значением, маски получаются непересекающимися. Фон в состязании не
 * участвует: у далёких от всех цветов пикселей значение и так ноль.
 *
 * Считается по месту: мягкие маски уже посчитаны, остаётся по каждому пикселю
 * обнулить всё, кроме максимума.
 *
 * @param {{w:number,h:number,data:Float32Array}[]} masks
 * @returns {{w:number,h:number,data:Float32Array}[]} те же объекты, изменённые
 */
export function resolveDisputes(masks) {
  if (masks.length < 2) return masks;
  const n = masks[0].data.length;
  for (const m of masks) {
    if (m.data.length !== n) throw new Error('resolveDisputes: маски разного размера');
  }
  for (let i = 0; i < n; i += 1) {
    let best = 0;
    let bestAt = -1;
    for (let k = 0; k < masks.length; k += 1) {
      const v = masks[k].data[i];
      if (v > best) { best = v; bestAt = k; }
    }
    if (bestAt < 0) continue;              // пиксель ничей — он фоновый
    for (let k = 0; k < masks.length; k += 1) {
      if (k !== bestAt) masks[k].data[i] = 0;
    }
  }
  return masks;
}

/** Мягкие маски всех слоёв разом; при exclusive спор решается сразу. */
export function layerMasks(img, bg, layers, { exclusive = true } = {}) {
  const masks = layers.map((L) => colorDistance(img, {
    fg: L.fg, bg, tolerance: L.tolerance,
  }));
  return exclusive ? resolveDisputes(masks) : masks;
}

/** Поэлементный максимум — то, что показывается на столе как общая маска. */
export function unionMask(masks) {
  if (!masks.length) return null;
  const out = { w: masks[0].w, h: masks[0].h, data: new Float32Array(masks[0].data.length) };
  for (const m of masks) {
    for (let i = 0; i < out.data.length; i += 1) {
      if (m.data[i] > out.data[i]) out.data[i] = m.data[i];
    }
  }
  return out;
}

const dist2 = (a, b) => {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
};

/**
 * Догадка о слоях: k-средних по пикселям, далёким от фона.
 *
 * Начальные центры берутся жадно — самый далёкий от фона, затем самый далёкий
 * от уже взятых. Случайного старта нет намеренно: одна и та же картинка должна
 * давать один и тот же ответ, иначе ползунок не подкрутить.
 *
 * @returns {number[][]} центры кластеров, от самого крупного к мелкому
 */
export function guessInks(img, bg, { k = 3, minShare = 0.02, steps = 12 } = {}) {
  const d = img.data;
  const far = [];
  // Порог «далеко от фона» тот же, что у пипетки на глаз: заметное отличие.
  const NEAR = 48 * 48;
  for (let i = 0; i < d.length; i += 4) {
    const c = [d[i], d[i + 1], d[i + 2]];
    if (dist2(c, bg) > NEAR) far.push(c);
  }
  if (far.length < 16) return [];

  const want = Math.max(1, Math.min(k, 4));
  const centres = [];
  let seed = far[0];
  let seedD = dist2(seed, bg);
  for (const c of far) {
    const v = dist2(c, bg);
    if (v > seedD) { seed = c; seedD = v; }
  }
  centres.push(seed);
  while (centres.length < want) {
    let pick = null;
    let pickD = -1;
    for (const c of far) {
      let near = Infinity;
      for (const q of centres) near = Math.min(near, dist2(c, q));
      if (near > pickD) { pickD = near; pick = c; }
    }
    if (!pick || pickD < NEAR) break;
    centres.push(pick);
  }

  const owner = new Int32Array(far.length);
  for (let s = 0; s < steps; s += 1) {
    let moved = false;
    for (let i = 0; i < far.length; i += 1) {
      let best = 0;
      let bestD = dist2(far[i], centres[0]);
      for (let q = 1; q < centres.length; q += 1) {
        const v = dist2(far[i], centres[q]);
        if (v < bestD) { bestD = v; best = q; }
      }
      if (owner[i] !== best) { owner[i] = best; moved = true; }
    }
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < far.length; i += 1) {
      const s2 = sum[owner[i]];
      s2[0] += far[i][0]; s2[1] += far[i][1]; s2[2] += far[i][2]; s2[3] += 1;
    }
    for (let q = 0; q < centres.length; q += 1) {
      if (sum[q][3]) {
        centres[q] = [
          Math.round(sum[q][0] / sum[q][3]),
          Math.round(sum[q][1] / sum[q][3]),
          Math.round(sum[q][2] / sum[q][3]),
        ];
      }
    }
    if (!moved) break;
  }

  const count = centres.map(() => 0);
  for (let i = 0; i < far.length; i += 1) count[owner[i]] += 1;
  return centres
    .map((c, i) => ({ c, share: count[i] / far.length }))
    .filter((x) => x.share >= minShare)
    .sort((a, b) => b.share - a.share)
    .map((x) => x.c);
}
