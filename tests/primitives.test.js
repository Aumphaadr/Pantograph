import {
  KAPPA, fitCircle, distRoundRect, detect, apply, NAMES, nameOf, isRegular,
  circleContour, ellipseContour, rectContour, polygonContour,
} from '../js/core/primitives.js';
import { flatten, contourArea, signedArea } from '../js/core/path.js';
import { createMask } from '../js/prep/mask.js';
import { traceMask } from '../js/trace/trace.js';

const P = (x, y) => ({ x, y });

/** Точки на окружности — заготовка для проверок подгонки. */
const onCircle = (cx, cy, r, n = 40, jitter = 0) =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const rr = r + (jitter ? (i % 3 - 1) * jitter : 0);
    return P(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr);
  });

// ─── подгонка круга ─────────────────────────────────────────────────────────

test('круг находится точно по точкам на нём', () => {
  const f = fitCircle(onCircle(30, 20, 12));
  eq(Math.abs(f.c.x - 30) < 1e-6 && Math.abs(f.c.y - 20) < 1e-6, true,
    `центр ${f.c.x.toFixed(3)}, ${f.c.y.toFixed(3)}`);
  eq(Math.abs(f.r - 12) < 1e-6, true, `радиус ${f.r.toFixed(4)}`);
});

test('лёгкий разброс точек круг не ломает', () => {
  const f = fitCircle(onCircle(0, 0, 20, 60, 0.4));
  eq(Math.abs(f.r - 20) < 0.4, true, `радиус ${f.r.toFixed(2)}`);
});

test('точки на прямой кругом не описываются', () => {
  const line = Array.from({ length: 10 }, (_, i) => P(i, 0));
  const f = fitCircle(line);
  eq(f === null || f.r > 1e6, true, 'вырожденный случай отвергнут или ушёл в бесконечность');
});

// ─── расстояние до прямоугольника ───────────────────────────────────────────

test('расстояние до прямоугольника нулевое на его границе', () => {
  const c = P(0, 0);
  for (const p of [P(10, 0), P(0, 6), P(10, 6), P(-10, -6)]) {
    eq(distRoundRect(p, c, 10, 6, 0) < 1e-9, true, `точка ${p.x},${p.y} на границе`);
  }
});

test('скругление сдвигает границу внутрь угла', () => {
  eq(distRoundRect(P(10, 6), P(0, 0), 10, 6, 3) > 0.8, true, 'угол больше не на границе');
  eq(distRoundRect(P(10, 0), P(0, 0), 10, 6, 3) < 1e-9, true, 'середина стороны — на границе');
});

// ─── построение ─────────────────────────────────────────────────────────────

test('круг строится четырьмя узлами и держит площадь', () => {
  const c = circleContour(P(0, 0), 10);
  eq(c.nodes.length, 4);
  // Считаем по частой выборке: грубое уплощение само по себе занижает площадь
  // (сорокавосьмиугольник вместо круга — это уже минус треть процента).
  const a = Math.abs(signedArea(flatten(c, 96)));
  eq(Math.abs(a - Math.PI * 100) / (Math.PI * 100) < 0.001, true, `площадь ${a.toFixed(2)}`);
});

test('рычаг круга равен каппе от радиуса', () => {
  const c = circleContour(P(0, 0), 10);
  eq(Math.abs(Math.abs(c.nodes[0].out.x) - 10 * KAPPA) < 1e-9, true);
});

test('эллипс строится четырьмя узлами и держит площадь', () => {
  const a = Math.abs(signedArea(flatten(ellipseContour(P(0, 0), 20, 10), 96)));
  eq(Math.abs(a - Math.PI * 200) / (Math.PI * 200) < 0.001, true, `площадь ${a.toFixed(2)}`);
});

test('прямоугольник — четыре угловых узла и прямые стороны', () => {
  const c = rectContour(P(0, 0), 10, 6, 0);
  eq(c.nodes.length, 4);
  eq(c.nodes.every((n) => n.type === 'corner' && n.in === null), true, 'рычагов нет — стороны прямые');
  eq(Math.abs(Math.abs(contourArea(c)) - 240) < 1e-6, true);
});

test('скруглённый прямоугольник — восемь узлов', () => {
  const c = rectContour(P(0, 0), 10, 6, 3);
  eq(c.nodes.length, 8);
  const a = Math.abs(signedArea(flatten(c, 96)));
  // 20×12 минус срезанные углы плюс четверти круга
  const want = 240 - (4 - Math.PI) * 9;
  eq(Math.abs(a - want) / want < 0.002, true, `площадь ${a.toFixed(2)} против ${want.toFixed(2)}`);
});

// ─── узнавание ──────────────────────────────────────────────────────────────

test('круг узнаётся кругом, а не эллипсом', () => {
  const m = detect(circleContour(P(0, 0), 15));
  eq(m.kind, 'circle', `узнано как ${m.name}`);
  eq(m.fits, true);
  eq(m.error < 0.01, true, `отклонение ${m.error.toFixed(4)}`);
});

test('вытянутый эллипс кругом не признаётся', () => {
  const m = detect(ellipseContour(P(0, 0), 30, 10));
  eq(m.kind, 'ellipse', `узнано как ${m.name}`);
});

test('прямоугольник узнаётся прямоугольником', () => {
  const m = detect(rectContour(P(0, 0), 20, 12, 0));
  eq(m.kind, 'rect');
  eq(m.error < 0.01, true, `отклонение ${m.error.toFixed(4)}`);
});

test('скруглённый прямоугольник отличается от обычного', () => {
  const m = detect(rectContour(P(0, 0), 20, 12, 5));
  eq(m.kind, 'roundRect', `узнано как ${m.name}`);
  eq(Math.abs(m.params.r - 5) < 0.5, true, `радиус ${m.params.r.toFixed(2)}`);
});

test('картошка ни на что не похожа и это видно', () => {
  const blob = { closed: true, nodes: onCircle(0, 0, 20, 9, 4)
    .map((p) => ({ p, in: null, out: null, type: 'smooth' })) };
  const m = detect(blob, 0.01);
  eq(m.fits, false, `лучшее совпадение ${m.name}, отклонение ${m.error.toFixed(2)}`);
});

test('допуск решает, считать ли похожим', () => {
  const wobbly = { closed: true, nodes: onCircle(0, 0, 20, 24, 0.6)
    .map((p) => ({ p, in: null, out: null, type: 'smooth' })) };
  eq(detect(wobbly, 0.002).fits, false, 'при строгом допуске — нет');
  eq(detect(wobbly, 0.2).fits, true, 'при вольном — да');
});

// ─── замена ─────────────────────────────────────────────────────────────────

test('замена сохраняет направление обхода', () => {
  const src = circleContour(P(0, 0), 12);
  const before = signedArea(flatten(src, 8));
  const next = apply(src, detect(src));
  eq(Math.sign(signedArea(flatten(next, 8))), Math.sign(before), 'знак площади тот же');
});

test('после замены узлов становится меньше, а форма остаётся', () => {
  // Круг, обведённый из растра: узлов много, форма приблизительна
  const size = 120;
  const m = createMask(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - 60, y + 0.5 - 60);
      m.data[y * size + x] = Math.max(0, Math.min(1, 40 - d + 0.5));
    }
  }
  const traced = traceMask(m, 1, { simplify: 0.05, fitError: 0.08 }).contours[0];
  const match = detect(traced, 0.03);
  eq(match.kind, 'circle', `узнано как ${match.name}, отклонение ${match.error.toFixed(2)}`);
  const next = apply(traced, match);
  eq(next.nodes.length, 4, `узлов было ${traced.nodes.length}, стало ${next.nodes.length}`);
  const da = Math.abs(Math.abs(contourArea(next)) - Math.abs(contourArea(traced)));
  eq(da / Math.abs(contourArea(traced)) < 0.02, true, `площадь изменилась на ${(da / Math.abs(contourArea(traced)) * 100).toFixed(1)}%`);
});

test('у каждого вида есть человеческое имя', () => {
  for (const k of Object.keys(NAMES)) eq(NAMES[k].length > 3, true, k);
});

test('правильность многоугольника проверяется, а не подразумевается', () => {
  const eq3 = [P(0, -10), P(8.66, 5), P(-8.66, 5)];
  const skew = [P(0, -10), P(20, 5), P(-3, 5)];
  eq(isRegular(eq3), true, 'равносторонний треугольник');
  eq(isRegular(skew), false, 'кособокий — нет');
});

test('имя многоугольника говорит и о числе сторон, и о правильности', () => {
  eq(nameOf({ kind: 'polygon', sides: 3, regular: true }), 'правильный треугольник');
  eq(nameOf({ kind: 'polygon', sides: 6, regular: false }), 'шестиугольник');
  eq(nameOf({ kind: 'circle' }), 'круг');
});

test('допуск соразмерен контуру, а не задан в пикселях', () => {
  // Один и тот же круг, увеличенный вдесятеро, узнаётся одинаково.
  const small = detect(circleContour(P(0, 0), 5));
  const big = detect(circleContour(P(0, 0), 50));
  eq(small.kind, 'circle');
  eq(big.kind, 'circle');
  eq(Math.abs(big.tol / small.tol - 10) < 0.1, true,
    `допуск вырос вдесятеро: ${small.tol.toFixed(2)} → ${big.tol.toFixed(2)}`);
});
