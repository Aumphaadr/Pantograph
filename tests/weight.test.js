import { createMask, gaussian } from '../js/prep/mask.js';
import { evenWeight, strokeWidth } from '../js/prep/weight.js';

const W = 200;
const H = 200;
const blank = () => createMask(W, H);
const rect = (m, x0, y0, bw, bh) => {
  for (let y = y0; y < y0 + bh; y += 1) for (let x = x0; x < x0 + bw; x += 1) m.data[y * W + x] = 1;
  return m;
};
const disc = (m, cx, cy, r, value = 1) => {
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m.data[y * W + x] = value;
  return m;
};
const at = (out, x, y) => out[y * W + x];
/** Толщина по столбцу x: число закрашенных пикселей подряд вокруг y. */
const runAt = (out, x, y) => {
  let a = y; while (a > 0 && out[(a - 1) * W + x]) a -= 1;
  let b = y; while (b < H - 1 && out[(b + 1) * W + x]) b += 1;
  return out[y * W + x] ? b - a + 1 : 0;
};
const asMask = (out) => { const m = blank(); m.data.set(out); return m; };

test('тонкая полоса дорастает до заданной толщины', () => {
  const r = evenWeight(rect(blank(), 40, 95, 120, 9), 15);
  eq(runAt(r.out, 100, 99), 15, 'толщина посередине');
  eq(strokeWidth(asMask(r.out)).med, 15, 'толщина по скелету');
});

test('толстая полоса худеет до заданной толщины', () => {
  const r = evenWeight(rect(blank(), 40, 88, 120, 25), 15);
  eq(runAt(r.out, 100, 100), 15, 'толщина посередине');
});

test('пятно не трогается, штрих рядом дорастает', () => {
  const m = rect(blank(), 20, 96, 160, 9);   // трек
  disc(m, 100, 100, 22);                      // бегунок
  const r = evenWeight(m, 15);
  let before = 0, after = 0;
  for (let y = 70; y <= 130; y += 1) for (let x = 70; x <= 130; x += 1) {
    const inDisc = (x - 100) ** 2 + (y - 100) ** 2 <= 22 * 22;
    if (inDisc) { before += 1; if (r.out[y * W + x]) after += 1; }
  }
  eq(after, before, 'бегунок целиком на месте');
  eq(at(r.out, 100, 100 - 26), 0, 'бегунок не вырос: над ним пусто');
  eq(runAt(r.out, 40, 100), 15, 'трек дорос');
});

test('вырез: конец уступает борту соседа, борт растёт целиком', () => {
  const m = rect(blank(), 20, 120, 160, 9);   // перекладина, борт сверху y = 120
  rect(m, 96, 30, 9, 84);                      // стойка, конец y = 113: зазор 6 px
  const r = evenWeight(m, 15);
  eq(runAt(r.out, 100, 124), 15, 'перекладина под стойкой дорастает на всю толщину');
  let top = 124; while (at(r.out, 100, top - 1)) top -= 1;          // верх перекладины
  let end = top - 1; while (end > 0 && !at(r.out, 100, end)) end -= 1;  // низ стойки
  eq(top - 1 - end, 6, 'зазор выреза как в v1');
  let x0 = 100; while (at(r.out, x0 - 1, 60)) x0 -= 1;
  let x1 = 100; while (at(r.out, x1 + 1, 60)) x1 += 1;
  eq(x1 - x0 + 1, 15, 'стойка вдали дорастает');
  // Торец у выреза скруглён, а не срезан плоско: у самого низа стойка уже, чем в теле.
  let bottomRun = 0; for (let x = x0; x <= x1; x += 1) bottomRun += at(r.out, x, end);
  if (bottomRun >= 15) throw new Error(`торец у выреза плоский: в нижней строке ${bottomRun} px из 15`);
});

test('борт против борта: зазор между параллельными не зарастает', () => {
  const m = rect(blank(), 20, 80, 160, 9);
  rect(m, 20, 97, 160, 9);                     // зазор 8 px: y 89..96
  const r = evenWeight(m, 15);
  let free = 0;
  for (let y = 85; y <= 100; y += 1) if (!at(r.out, 100, y)) free += 1;
  if (free < 7) throw new Error(`просвет ${free} px, ожидалось не меньше 7`);
});

test('мелкая дыра кольца не зарастает', () => {
  const m = disc(blank(), 100, 100, 12);
  disc(m, 100, 100, 3, 0);                     // дыра Ø 7 px при штрихе 9
  rect(m, 112, 97, 70, 7);                     // хвост, чтобы медиана была штрихом
  const r = evenWeight(m, 15);
  eq(at(r.out, 100, 100), 0, 'центр дыры пуст');
});

test('значок из одних пятен оставлен как был', () => {
  const m = rect(blank(), 30, 30, 140, 140);
  const r = evenWeight(m, 15);
  eq(r.allSolid, true, 'весь значок — пятно');
  let same = true;
  for (let i = 0; i < m.data.length; i += 1) if ((m.data[i] > 0.5 ? 1 : 0) !== r.out[i]) { same = false; break; }
  eq(same, true, 'пиксели те же');
});

test('толщина пустой маски — нули, а не NaN', () => {
  eq(strokeWidth(blank()), { med: 0, p10: 0, p90: 0 });
});

test('гауссово размытие сохраняет массу и уровень 0.5 на кромке', () => {
  const m = rect(blank(), 50, 50, 100, 100);
  const g = gaussian(m, 1.5);
  let a = 0, b = 0;
  for (let i = 0; i < m.data.length; i += 1) { a += m.data[i]; b += g.data[i]; }
  eq(Math.round(b), Math.round(a), 'масса');
  // Кромка между пикселями 49 и 50: там значения по разные стороны от 0.5.
  eq(g.data[100 * W + 49] < 0.5 && g.data[100 * W + 50] > 0.5, true, 'кромка на месте');
});

test('короткая планка под широким бортом не пропадает: касание вдоль — растут врозь', () => {
  // Планка под короной SignoreBot: концы у неё тоже рядом с соседом, но касается
  // она вдоль — раньше её срезало вдоль, а скругление доедало остаток.
  const m = rect(blank(), 20, 60, 160, 9);   // борт
  rect(m, 60, 76, 80, 9);                     // планка, зазор 7 px
  const r = evenWeight(m, 15);
  let pieces = 0;
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < r.out.length; i += 1) {
    if (!r.out[i] || seen[i]) continue;
    pieces += 1;
    const st = [i]; seen[i] = 1;
    while (st.length) { const j = st.pop(); const x = j % W; for (const k of [j - 1, j + 1, j - W, j + W]) { if (k < 0 || k >= W * H || seen[k] || !r.out[k] || (Math.abs((k % W) - x) > 1)) continue; seen[k] = 1; st.push(k); } }
  }
  eq(pieces, 2, 'оба куска на месте');
  let free = 0;
  for (let y = 66; y < 80; y += 1) if (!at(r.out, 100, y)) free += 1;
  if (free < 6) throw new Error(`просвет между бортом и планкой ${free} px`);
  if (runAt(r.out, 100, 82) < 11) throw new Error(`планка похудела: ${runAt(r.out, 100, 82)} px`);
});
