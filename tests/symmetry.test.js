import { createMask } from '../js/prep/mask.js';
import {
  mirrorX, mirrorY, combine, mismatch, centroid, findAxisX, findAxisY, symmetrize, MODES,
  scoreX,
} from '../js/prep/symmetry.js';

const W = 40;
const H = 30;

const make = (fill) => {
  const m = createMask(W, H);
  fill((x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) m.data[y * W + x] = v; });
  return m;
};

const box = (x0, y0, w, h, v = 1) => make((set) => {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, v);
});

/** Домик: симметричен относительно вертикальной оси x = cx. */
const house = (cx, lean = 0) => make((set) => {
  for (let y = 6; y < 20; y += 1) {
    const half = 8;
    for (let x = cx - half; x <= cx + half; x += 1) set(x, y, 1);
  }
  for (let k = 0; k <= 8; k += 1) {
    for (let x = cx - k; x <= cx + k + lean; x += 1) set(x, 6 - (8 - k), 1);
  }
});

const lit = (m) => [...m.data].reduce((s, v) => s + v, 0);

// ─── отражение ──────────────────────────────────────────────────────────────

test('mirrorX переставляет столбцы относительно оси', () => {
  const m = box(2, 5, 3, 4);
  const r = mirrorX(m, 10);
  eq(r.data[5 * W + 18], 1, 'столбец 2 ушёл в 18');
  eq(r.data[5 * W + 2], 0, 'а на своём месте пусто');
});

test('двойное отражение возвращает поле на место', () => {
  const m = box(6, 4, 5, 6);
  const back = mirrorX(mirrorX(m, 14), 14);
  let worst = 0;
  for (let i = 0; i < m.data.length; i += 1) worst = Math.max(worst, Math.abs(m.data[i] - back.data[i]));
  eq(worst < 1e-6, true, `худшее расхождение ${worst}`);
});

test('дробная ось отражает с интерполяцией', () => {
  const m = make((set) => set(10, 5, 1));
  const r = mirrorX(m, 12.5);
  // 2·12.5 − 15 = 10, значит зажечься должен столбец 15
  eq(Math.abs(r.data[5 * W + 15] - 1) < 1e-6, true);
});

test('mirrorY работает по другой оси', () => {
  const m = box(5, 2, 4, 3);
  const r = mirrorY(m, 10);
  eq(r.data[18 * W + 5], 1, 'строка 2 ушла в 18');
});

test('отражение за край поля даёт пустоту, а не заворачивается', () => {
  const m = box(1, 1, 3, 3);
  eq(lit(mirrorX(m, 1)) < lit(m), true, 'часть ушла за левый край и пропала');
});

// ─── сложение ───────────────────────────────────────────────────────────────

test('три способа сложения ведут себя как обещано', () => {
  eq(MODES.average(0.2, 0.8), 0.5);
  eq(MODES.union(0.2, 0.8), 0.8);
  eq(MODES.intersection(0.2, 0.8), 0.2);
});

test('combine складывает поля поточечно', () => {
  // Поле хранится во Float32, поэтому сравниваем с допуском, а не точно.
  const a = box(0, 0, 40, 30, 0.2);
  const b = box(0, 0, 40, 30, 0.8);
  const near = (v, want) => Math.abs(v - want) < 1e-6;
  eq(near(combine(a, b, 'average').data[0], 0.5), true);
  eq(near(combine(a, b, 'union').data[0], 0.8), true);
  eq(near(combine(a, b, 'intersection').data[0], 0.2), true);
});

// ─── мера несимметричности ──────────────────────────────────────────────────

test('у симметричной фигуры расхождение нулевое', () => {
  const m = house(20);
  eq(mismatch(m, mirrorX(m, 20)) < 0.02, true,
    `расхождение ${mismatch(m, mirrorX(m, 20)).toFixed(3)}`);
});

test('у кривой фигуры расхождение заметное', () => {
  const m = house(20, 5);
  eq(mismatch(m, mirrorX(m, 20)) > 0.05, true,
    `расхождение ${mismatch(m, mirrorX(m, 20)).toFixed(3)}`);
});

test('пустое поле не делит на ноль', () => {
  const m = createMask(W, H);
  eq(mismatch(m, m), 0);
});

// ─── поиск оси ──────────────────────────────────────────────────────────────

test('центр тяжести находится там, где фигура', () => {
  const c = centroid(box(10, 4, 6, 6));
  eq(Math.abs(c.x - 12.5) < 0.6 && Math.abs(c.y - 6.5) < 0.6, true,
    `центр ${c.x.toFixed(1)}, ${c.y.toFixed(1)}`);
});

test('ось симметрии находится сама', () => {
  const found = findAxisX(house(22));
  eq(Math.abs(found.axis - 22) < 0.6, true, `ось ${found.axis.toFixed(2)} вместо 22`);
  eq(found.mismatch < 0.03, true, `расхождение на оси ${found.mismatch.toFixed(3)}`);
});

test('ось ищется и по другой координате', () => {
  const m = box(6, 8, 20, 9);
  eq(Math.abs(findAxisY(m).axis - 12) < 0.6, true);
});

test('на пустом поле поиск не падает', () => {
  eq(Number.isFinite(findAxisX(createMask(W, H)).axis), true);
});

// ─── симметризация целиком ──────────────────────────────────────────────────

test('без оси поле не трогается', () => {
  const m = house(20, 4);
  eq(symmetrize(m, { axis: 'none' }).mask === m, true);
});

test('кривая фигура с фронтоном становится симметричной', () => {
  const m = house(20, 5);
  const before = mismatch(m, mirrorX(m, findAxisX(m).axis));
  const { mask, axisX } = symmetrize(m, { axis: 'x' });
  const after = mismatch(mask, mirrorX(mask, axisX));
  eq(after < before / 4, true, `расхождение ${before.toFixed(3)} → ${after.toFixed(3)}`);
});

test('симметризация докладывает, насколько фигура была кривой', () => {
  const s = symmetrize(house(20, 6), { axis: 'x' });
  eq(s.mismatchX > 0.05, true, `доложено ${s.mismatchX.toFixed(3)}`);
  eq(s.axisX !== null, true, 'и где встала ось');
});

test('сдвиг оси руками смещает её', () => {
  const a = symmetrize(house(20), { axis: 'x' }).axisX;
  const b = symmetrize(house(20), { axis: 'x', shiftX: 3 }).axisX;
  eq(Math.abs((b - a) - 3) < 1e-6, true, `сдвиг ${(b - a).toFixed(2)}`);
});

test('обе оси сразу дают симметрию по обеим', () => {
  const s = symmetrize(box(8, 6, 9, 7), { axis: 'both' });
  eq(s.axisX !== null && s.axisY !== null, true);
});

test('пересечение не толще исходника, объединение не тоньше', () => {
  const m = house(20, 5);
  const thin = symmetrize(m, { axis: 'x', mode: 'intersection' }).mask;
  const fat = symmetrize(m, { axis: 'x', mode: 'union' }).mask;
  eq(lit(thin) <= lit(m) + 1e-6, true, 'пересечение худее');
  eq(lit(fat) >= lit(m) - 1e-6, true, 'объединение полнее');
});

// ─── оценка симметрии ───────────────────────────────────────────────────────

test('у симметричной фигуры оценка высокая, у несимметричной низкая', () => {
  const sym = scoreX(house(20));
  // прямоугольник с язычком слева — оси симметрии нет
  const folder = make((set) => {
    for (let y = 10; y < 22; y += 1) for (let x = 8; x < 30; x += 1) set(x, y, 1);
    for (let y = 6; y < 10; y += 1) for (let x = 8; x < 16; x += 1) set(x, y, 1);
  });
  const asym = scoreX(folder);
  eq(sym.score > 0.6, true, `симметричная: ${(sym.score * 100).toFixed(0)}%`);
  eq(asym.score < sym.score, true,
    `несимметричная ниже: ${(asym.score * 100).toFixed(0)}% против ${(sym.score * 100).toFixed(0)}%`);
});

test('оценка не читается как расхождение: у тонкого штриха оно велико всегда', () => {
  // Тонкий, но идеально симметричный крест: расхождение на оси мало, оценка высока
  const cross = make((set) => {
    for (let y = 4; y < 26; y += 1) set(20, y, 1);
    for (let x = 10; x < 31; x += 1) set(x, 15, 1);
  });
  const s = scoreX(cross);
  eq(s.score > 0.7, true, `оценка ${(s.score * 100).toFixed(0)}%`);
});

test('оценка не выходит за пределы от нуля до единицы', () => {
  for (const m of [house(20), createMask(W, H), box(0, 0, W, H)]) {
    const s = scoreX(m).score;
    eq(s >= 0 && s <= 1, true, `оценка ${s}`);
  }
});

test('симметризация докладывает оценку вместе с осью', () => {
  const s = symmetrize(house(20), { axis: 'x' });
  eq(s.scoreX > 0.6, true, `оценка ${(s.scoreX * 100).toFixed(0)}%`);
  eq(typeof s.axisX, 'number');
});
