import { rasterizeShape, countComponents, mismatch, flattenContour } from '../js/trace/rasterize.js';
import { rectContour, circleContour } from '../js/core/primitives.js';
import { createMask } from '../js/prep/mask.js';

const area = (m) => m.reduce((a, v) => a + v, 0);

test('прямоугольник заливается ровно своей площадью', () => {
  const shape = { contours: [rectContour({ x: 10, y: 8 }, 5, 3, 0)] };
  const m = rasterizeShape(shape, 20, 16);
  eq(area(m), 10 * 6, `10×6 = 60, получено ${area(m)}`);
  eq(m[8 * 20 + 10], 1, 'центр внутри');
  eq(m[8 * 20 + 4], 0, 'слева снаружи');
});

test('круг заливается близко к своей площади', () => {
  const shape = { contours: [circleContour({ x: 16, y: 16 }, 10)] };
  const got = area(rasterizeShape(shape, 32, 32));
  const want = Math.PI * 100;
  eq(Math.abs(got - want) / want < 0.03, true, `πr² ≈ ${Math.round(want)}, получено ${got}`);
});

test('дырка ненулевым правилом остаётся дыркой', () => {
  const outer = rectContour({ x: 10, y: 10 }, 8, 8, 0);
  const hole = rectContour({ x: 10, y: 10 }, 4, 4, 0);
  hole.nodes.reverse();
  hole.nodes.forEach((n) => { const t = n.in; n.in = n.out; n.out = t; });
  const m = rasterizeShape({ contours: [outer, hole] }, 20, 20);
  eq(m[10 * 20 + 10], 0, 'внутри дырки пусто');
  eq(m[10 * 20 + 4], 1, 'в кольце залито');
  eq(area(m), 16 * 16 - 8 * 8, `кольцо, получено ${area(m)}`);
});

test('масштаб переводит кроп в увеличенную маску', () => {
  const shape = { contours: [rectContour({ x: 5, y: 5 }, 2, 2, 0)] };
  const m = rasterizeShape(shape, 20, 20, 2);
  eq(area(m), 8 * 8, `4×4 кропа при ×2 — 64, получено ${area(m)}`);
});

test('разомкнутый контур площади не даёт', () => {
  const open = { closed: false, nodes: rectContour({ x: 5, y: 5 }, 3, 3, 0).nodes };
  eq(area(rasterizeShape({ contours: [open] }, 12, 12)), 0);
});

test('flattenContour замкнутого даёт точки без дублей концов', () => {
  const c = rectContour({ x: 4, y: 4 }, 2, 2, 0);
  const pts = flattenContour(c, 4);
  eq(pts.length, 16, 'четыре сегмента по четыре точки');
});

test('countComponents отличает один кусок от трёх', () => {
  const w = 10;
  const one = new Uint8Array(w * 5).fill(0);
  for (let x = 1; x < 9; x += 1) one[2 * w + x] = 1;
  eq(countComponents(one, w, 5), 1);
  const three = new Uint8Array(w * 5).fill(0);
  three[1 * w + 1] = 1; three[1 * w + 5] = 1; three[3 * w + 3] = 1;
  eq(countComponents(three, w, 5), 3);
});

test('mismatch: совпадение даёт ноль, сдвиг — честную долю', () => {
  const bin = createMask(20, 16);
  for (let y = 5; y < 11; y += 1) for (let x = 5; x < 15; x += 1) bin.data[y * 20 + x] = 1;
  const same = { contours: [rectContour({ x: 10, y: 8 }, 5, 3, 0)] };
  const m0 = mismatch(bin, same);
  eq(m0.diff, 0, `идеальный контур расходится на ${m0.diff}`);
  eq(m0.compBin, 1);
  eq(m0.compRen, 1);

  const shifted = { contours: [rectContour({ x: 12, y: 8 }, 5, 3, 0)] };
  const m1 = mismatch(bin, shifted);
  // сдвиг на 2: слева 2×6 потеряно, справа 2×6 лишнего = 24 из 60
  eq(m1.diff, 24, `сдвиг на два пикселя, получено ${m1.diff}`);
  eq(Math.abs(m1.share - 0.4) < 1e-9, true, `доля 40%, получено ${m1.share}`);
  // край прямоугольника 10×6 — 28 пикселей; 24/28 ≈ 0.857 px увода
  eq(Math.abs(m1.drift - 24 / 28) < 1e-9, true, `увод края, получено ${m1.drift}`);
});

test('крапина мельче minComp не считается потерянным куском', () => {
  const bin = createMask(30, 20);
  for (let y = 5; y < 15; y += 1) for (let x = 2; x < 12; x += 1) bin.data[y * 30 + x] = 1;
  bin.data[3 * 30 + 25] = 1;   // одинокая крапина
  const onlyBig = { contours: [rectContour({ x: 7, y: 10 }, 5, 5, 0)] };
  const strict = mismatch(bin, onlyBig, 1, 1);
  eq(strict.compBin - strict.compRen, 1, 'со строгим порогом крапина — потеря');
  const lenient = mismatch(bin, onlyBig, 1, 4);
  eq(lenient.compBin - lenient.compRen, 0, 'с порогом мусора — не потеря');
});

test('mismatch видит потерянную компоненту', () => {
  const bin = createMask(30, 20);
  for (let y = 5; y < 15; y += 1) for (let x = 2; x < 12; x += 1) bin.data[y * 30 + x] = 1;
  for (let y = 8; y < 12; y += 1) for (let x = 20; x < 24; x += 1) bin.data[y * 30 + x] = 1;
  const onlyBig = { contours: [rectContour({ x: 7, y: 10 }, 5, 5, 0)] };
  const m = mismatch(bin, onlyBig);
  eq(m.compBin, 2, 'в растре два куска');
  eq(m.compRen, 1, 'в рендере один — точка потеряна');
});
