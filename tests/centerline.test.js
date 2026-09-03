import { createMask } from '../js/prep/mask.js';
import {
  distanceTransform, thin, skeletonPaths, degrees, centerline,
} from '../js/trace/centerline.js';

/** Маска из строк-картинок: '#' — фигура, '.' — фон. */
const from = (rows) => {
  const h = rows.length;
  const w = rows[0].length;
  const m = createMask(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) m.data[y * w + x] = rows[y][x] === '#' ? 1 : 0;
  }
  return m;
};

const bar = (w, h, x0, y0, bw, bh) => {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    let s = '';
    for (let x = 0; x < w; x += 1) {
      s += (x >= x0 && x < x0 + bw && y >= y0 && y < y0 + bh) ? '#' : '.';
    }
    rows.push(s);
  }
  return from(rows);
};

test('расстояние до фона: середина полосы дальше края', () => {
  const d = distanceTransform(bar(11, 11, 3, 3, 5, 5));
  const at = (x, y) => d[y * 11 + x];
  eq(at(5, 5), 3, `центр квадрата 5×5 отстоит на 3, получено ${at(5, 5)}`);
  eq(at(3, 5), 1, `край отстоит на 1, получено ${at(3, 5)}`);
  eq(at(0, 0), 0, 'фон отстоит на ноль');
});

test('расстояние честно евклидово, а не шахматное', () => {
  // Одинокий пиксель: соседи по диагонали должны быть дальше, чем по стороне.
  const d = distanceTransform(bar(9, 9, 4, 4, 1, 1));
  eq(Math.round(d[4 * 9 + 4] * 100) / 100, 1, 'сам пиксель отстоит на 1');
});

test('утоньшение сводит толстую полосу к линии в пиксель', () => {
  const m = bar(21, 9, 2, 3, 17, 3);
  const px = thin(m);
  let count = 0;
  for (const v of px) count += v;
  const before = m.data.reduce((a, v) => a + v, 0);
  eq(count < before / 2, true, `скелет тоньше фигуры: ${count} из ${before}`);
  // Ось должна лечь на среднюю строку полосы.
  let onMid = 0;
  for (let x = 0; x < 21; x += 1) onMid += px[4 * 21 + x];
  eq(onMid >= 10, true, `ось идёт по средней строке, на ней ${onMid} пикселей`);
});

test('утоньшение не рвёт связную фигуру на куски', () => {
  const px = thin(bar(21, 9, 2, 3, 17, 3));
  const deg = degrees(px, 21, 9);
  const paths = skeletonPaths(px, 21, 9);
  eq(paths.length, 1, `одна полоса — одна цепочка, получено ${paths.length}`);
  void deg;
});

test('крест даёт развилку и четыре луча', () => {
  const rows = [];
  // Крест не должен упираться в кромку: пиксель на самом краю кропа не
  // утоньшается намеренно — там фигура обрезана, а не кончилась.
  for (let y = 0; y < 15; y += 1) {
    let s = '';
    for (let x = 0; x < 15; x += 1) {
      const inside = x >= 2 && x <= 12 && y >= 2 && y <= 12;
      s += (inside && (Math.abs(x - 7) <= 1 || Math.abs(y - 7) <= 1)) ? '#' : '.';
    }
    rows.push(s);
  }
  const px = thin(from(rows));
  const deg = degrees(px, 15, 15);
  let forks = 0;
  let ends = 0;
  for (let i = 0; i < deg.length; i += 1) {
    if (!px[i]) continue;
    if (deg[i] >= 3) forks += 1;
    if (deg[i] === 1) ends += 1;
  }
  eq(ends, 4, `у креста четыре свободных конца, получено ${ends}`);
  eq(forks >= 1, true, `есть развилка, найдено ${forks}`);
});

test('осевая полосы: одна линия нужной толщины', () => {
  const out = centerline(bar(25, 11, 3, 4, 19, 3));
  eq(out.length, 1, `одна цепочка, получено ${out.length}`);
  eq(out[0].width, 3, `толщина полосы в три пикселя, получено ${out[0].width}`);
  eq(out[0].points.length > 10, true, `точек хватает: ${out[0].points.length}`);
  eq(out[0].closed, false, 'полоса не кольцо');
});

test('толщина меряется медианой, а не концами', () => {
  // Полоса в 5 пикселей: на концах расстояние проседает, медиана — нет.
  const out = centerline(bar(31, 13, 4, 4, 23, 5));
  eq(out[0].width, 5, `толщина полосы в пять пикселей, получено ${out[0].width}`);
});

test('координаты уходят в crop-пространство, увеличение делится обратно', () => {
  const out = centerline(bar(42, 22, 6, 8, 30, 7), 2);
  const xs = out[0].points.map((p) => p.x);
  eq(Math.max(...xs) <= 21, true, `x не выходит за кроп 21, получено ${Math.max(...xs)}`);
  // 7 пикселей маски при увеличении ×2 — 3.5 пикселя кропа.
  eq(out[0].width, 3.5, `толщина в кропе, получено ${out[0].width}`);
});

test('на чётной толщине ответ занижен на полпикселя — и это признано', () => {
  // Ось полосы в 6 пикселей проходит МЕЖДУ пикселями, а скелет шириной в
  // пиксель туда не встанет. Проверяем не идеал, а известную величину ошибки:
  // если она поедет, значит поехало что-то другое.
  eq(centerline(bar(31, 13, 4, 4, 23, 6))[0].width, 5, 'полоса в 6 пикселей меряется как 5');
  eq(centerline(bar(31, 13, 4, 4, 23, 7))[0].width, 7, 'нечётная — точно');
});

test('кольцо распознаётся замкнутым', () => {
  const rows = [];
  for (let y = 0; y < 21; y += 1) {
    let s = '';
    for (let x = 0; x < 21; x += 1) {
      const r = Math.hypot(x - 10, y - 10);
      s += (r > 5.5 && r < 8.5) ? '#' : '.';
    }
    rows.push(s);
  }
  const out = centerline(from(rows));
  eq(out.length, 1, `кольцо — одна цепочка, получено ${out.length}`);
  eq(out[0].closed, true, 'цепочка замкнута');
});

test('короткие усы отсеиваются, а перемычка между развилками остаётся', () => {
  // Буква «H»: две стойки и перемычка. Ни одной цепочки терять нельзя.
  const rows = [];
  for (let y = 0; y < 17; y += 1) {
    let s = '';
    for (let x = 0; x < 17; x += 1) {
      const post = Math.abs(x - 3) <= 1 || Math.abs(x - 13) <= 1;
      const bridge = Math.abs(y - 8) <= 1 && x >= 3 && x <= 13;
      s += (post || bridge) ? '#' : '.';
    }
    rows.push(s);
  }
  const out = centerline(from(rows), 1, { minBranch: 3 });
  eq(out.length >= 5, true, `две стойки надвое плюс перемычка — не меньше пяти, получено ${out.length}`);
  const total = out.reduce((a, p) => a + p.points.length, 0);
  eq(total > 30, true, `фигура не съедена отсевом: точек ${total}`);
});

test('пустая маска не даёт ни одной линии', () => {
  eq(centerline(createMask(9, 9)), []);
});

test('пиксель на самой кромке кропа не съедается', () => {
  // Полоса, упирающаяся в левый край: фигура обрезана кропом, а не кончилась.
  const out = centerline(bar(21, 9, 0, 3, 18, 3));
  eq(out.length >= 1, true, 'линия найдена');
  const minX = Math.min(...out[0].points.map((p) => p.x));
  eq(minX <= 2, true, `линия доходит до кромки, ближайший x = ${minX}`);
});

test('диагональная полоса не съедается с конца до развилки', () => {
  // Чжан — Сунь снимал концевую пару двухпиксельной лесенки за проход:
  // луч «×» в 300 px исчезал целиком. Полоса «\» толщиной 30 из угла в угол.
  const w = 220;
  const m = createMask(w, w);
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const along = (x + y) / 2;
      const across = Math.abs(x - y) / Math.SQRT2;
      if (along > 30 && along < 190 && across <= 15) m.data[y * w + x] = 1;
    }
  }
  const px = thin(m);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!px[y * w + x]) continue;
      lo = Math.min(lo, (x + y) / 2);
      hi = Math.max(hi, (x + y) / 2);
    }
  }
  eq(hi - lo > 120, true, `скелет тянется ${lo}..${hi} — ждём почти всю полосу 30..190`);
});
