import { createMask } from '../js/prep/mask.js';
import { labelComponents, segment, lines } from '../js/glyphs/segment.js';
import {
  shouldMerge, autoMerge, mergeGroups, splitGroup, groupBBox, readingOrder,
} from '../js/glyphs/merge.js';

const W = 40;
const H = 30;

/** Полотно, на котором рисуем прямоугольники — заготовки «букв». */
function canvas(rects, soft = null) {
  const bin = createMask(W, H);
  const sof = createMask(W, H);
  for (const [x, y, w, h] of rects) {
    for (let j = y; j < y + h; j += 1) {
      for (let i = x; i < x + w; i += 1) { bin.data[j * W + i] = 1; sof.data[j * W + i] = 1; }
    }
  }
  if (soft) soft(sof);
  return { bin, sof };
}

const comp = (rects, opts) => {
  const { bin, sof } = canvas(rects);
  return segment(sof, bin, opts);
};

// ─── связные компоненты ─────────────────────────────────────────────────────

test('labelComponents считает раздельные пятна', () => {
  const { bin } = canvas([[2, 2, 4, 4], [20, 2, 4, 4], [2, 20, 4, 4]]);
  eq(labelComponents(bin).count, 3);
});

test('восьмисвязность склеивает касание по диагонали', () => {
  const bin = createMask(W, H);
  bin.data[5 * W + 5] = 1;
  bin.data[6 * W + 6] = 1;
  eq(labelComponents(bin).count, 1, 'по диагонали — одна компонента');
});

test('пустое поле даёт ноль компонент', () => {
  eq(labelComponents(createMask(W, H)).count, 0);
});

// ─── компоненты ─────────────────────────────────────────────────────────────

test('segment отдаёт габарит и площадь каждой буквы', () => {
  const cs = comp([[3, 4, 5, 8], [15, 4, 6, 8]]);
  eq(cs.length, 2);
  eq(cs[0].bbox, { x: 3, y: 4, w: 5, h: 8 });
  eq(cs[0].area, 40);
  eq(cs[1].bbox, { x: 15, y: 4, w: 6, h: 8 });
});

test('мелкие пятна отсеиваются по площади', () => {
  eq(comp([[3, 3, 6, 6], [20, 20, 1, 1]], { minArea: 4 }).length, 1);
});

test('в компоненту кладётся мягкая маска, а не биты', () => {
  const { bin, sof } = canvas([[5, 5, 4, 4]]);
  sof.data[5 * W + 5] = 0.42;                    // краевой пиксель внутри буквы
  const c = segment(sof, bin, {})[0];
  const at = (x, y) => c.mask.data[(y - c.bbox.y + c.pad) * c.mask.w + (x - c.bbox.x + c.pad)];
  eq(Math.abs(at(5, 5) - 0.42) < 1e-6, true, `мягкое значение сохранено, получено ${at(5, 5)}`);
});

test('спад яркости на фоне сохраняется — иначе теряется субпиксельный край', () => {
  const { bin, sof } = canvas([[5, 5, 4, 4]]);
  sof.data[4 * W + 5] = 0.3;                     // фон рядом с буквой, ниже порога
  const c = segment(sof, bin, {})[0];
  // фоновый пиксель попал в габарит с запасом и остался живым
  const at = (x, y) => c.mask.data[(y - c.bbox.y + c.pad) * c.mask.w + (x - c.bbox.x + c.pad)];
  eq(Math.abs(at(5, 4) - 0.3) < 1e-6, true, `фоновый спад сохранён, получено ${at(5, 4)}`);
});

test('пиксели соседней буквы гасятся', () => {
  const { bin, sof } = canvas([[5, 5, 4, 4], [10, 5, 4, 4]]);
  const c = segment(sof, bin, {})[0];
  // габарит первой буквы 5..8; десятая колонка в него не входит вовсе
  eq(c.bbox.w, 4, 'габарит не захватил соседа');
  eq([...c.mask.data].every((v) => v <= 1), true);
});

test('вокруг маски компоненты есть поле в два пикселя', () => {
  const c = comp([[5, 5, 4, 4]])[0];
  eq([c.mask.w, c.mask.h], [8, 8]);
  eq(c.pad, 2);
});

test('внешнее кольцо поля пустое — контур замкнётся внутри сетки', () => {
  const { bin, sof } = canvas([[5, 5, 4, 4]]);
  for (let i = 0; i < W * H; i += 1) sof.data[i] = Math.max(sof.data[i], 0.9);   // фон яркий
  const c = segment(sof, bin, {})[0];
  const ring = [];
  for (let x = 0; x < c.mask.w; x += 1) { ring.push(c.mask.data[x]); ring.push(c.mask.data[(c.mask.h - 1) * c.mask.w + x]); }
  for (let y = 0; y < c.mask.h; y += 1) { ring.push(c.mask.data[y * c.mask.w]); ring.push(c.mask.data[y * c.mask.w + c.mask.w - 1]); }
  eq(ring.every((v) => v === 0), true, 'по краю только нули');
});

// ─── строки ─────────────────────────────────────────────────────────────────

test('lines разбирает две строки и сортирует по чтению', () => {
  const cs = comp([[20, 2, 4, 6], [3, 2, 4, 6], [12, 2, 4, 6],
    [10, 18, 4, 6], [2, 18, 4, 6]]);
  const rows = lines(cs);
  eq(rows.length, 2);
  eq(rows[0].map((c) => c.bbox.x), [3, 12, 20], 'первая строка слева направо');
  eq(rows[1].map((c) => c.bbox.x), [2, 10], 'вторая строка ниже');
});

test('буква с выносным элементом остаётся в своей строке', () => {
  // «р» свисает ниже базовой линии, но перекрывается со строкой по вертикали
  const cs = comp([[3, 4, 4, 8], [10, 4, 4, 12]]);
  eq(lines(cs).length, 1);
});

// ─── склейка ────────────────────────────────────────────────────────────────

const box = (x, y, w, h) => ({ bbox: { x, y, w, h } });

test('точки над Ё склеиваются с телом буквы', () => {
  const body = box(10, 10, 8, 12);
  const dotL = box(11, 6, 2, 2);
  const dotR = box(15, 6, 2, 2);
  eq(shouldMerge(body, dotL), true);
  eq(shouldMerge(body, dotR), true);
});

test('соседние буквы не склеиваются', () => {
  eq(shouldMerge(box(10, 10, 8, 12), box(20, 10, 8, 12)), false, 'нет перекрытия по X');
});

test('далёкая по вертикали шапка не склеивается', () => {
  eq(shouldMerge(box(10, 10, 8, 12), box(11, 0, 6, 2)), false, 'зазор больше 0.4 высоты');
});

test('autoMerge собирает Ё в одну группу, соседей оставляет врозь', () => {
  const cs = [box(10, 10, 8, 12), box(11, 6, 2, 2), box(15, 6, 2, 2), box(24, 10, 8, 12)];
  const groups = autoMerge(cs);
  eq(groups.length, 2, `групп ${groups.length}`);
  const big = groups.find((g) => g.length === 3);
  eq(big.sort(), [0, 1, 2]);
});

test('Ы эвристика не склеивает — это работа рук', () => {
  // две части бок о бок, не одна над другой
  const cs = [box(10, 10, 5, 12), box(16, 10, 4, 12)];
  eq(autoMerge(cs).length, 2);
});

test('mergeGroups соединяет вручную', () => {
  const groups = [[0], [1], [2]];
  const after = mergeGroups(groups, [0, 2]);
  eq(after.length, 2);
  eq(after.find((g) => g.length === 2), [0, 2]);
});

test('splitGroup разбирает группу обратно', () => {
  eq(splitGroup([[0, 1, 2], [3]], 1).sort((a, b) => a[0] - b[0]), [[0], [1], [2], [3]]);
});

test('splitGroup не трогает одиночек', () => {
  eq(splitGroup([[0], [1]], 0), [[0], [1]]);
});

test('groupBBox накрывает всю группу', () => {
  const cs = [box(10, 10, 8, 12), box(11, 6, 2, 2)];
  eq(groupBBox([0, 1], cs), { x: 10, y: 6, w: 8, h: 16 });
});

// ─── порядок чтения ─────────────────────────────────────────────────────────

test('readingOrder выстраивает строки и буквы в них', () => {
  const cs = [box(20, 2, 4, 6), box(3, 2, 4, 6), box(10, 18, 4, 6), box(2, 18, 4, 6)];
  const rows = readingOrder([[0], [1], [2], [3]], cs);
  eq(rows.length, 2);
  eq(rows[0], [[1], [0]], 'первая строка: x=3, затем x=20');
  eq(rows[1], [[3], [2]], 'вторая строка: x=2, затем x=10');
});

test('склеенная Ё идёт в порядке как одна буква', () => {
  const cs = [box(10, 10, 8, 12), box(11, 6, 2, 2), box(2, 10, 5, 12)];
  const rows = readingOrder([[0, 1], [2]], cs);
  eq(rows[0].length, 2);
  eq(rows[0][0], [2], 'левая буква первая');
  eq(rows[0][1], [0, 1], 'составная — второй');
});

// ─── сборка глифов ──────────────────────────────────────────────────────────

import { glyphScale, groupMask, traceGroup, buildGlyphs } from '../js/glyphs/build.js';
import { countNodes, bounds } from '../js/core/path.js';

test('glyphScale растит мелкую букву сильнее крупной', () => {
  eq(glyphScale(12) > glyphScale(40), true, `${glyphScale(12)} против ${glyphScale(40)}`);
  eq(glyphScale(200), 2, 'крупной букве хватает минимума');
  eq(glyphScale(1), 12, 'коэффициент не улетает выше потолка');
});

test('groupMask складывает части составной буквы в один габарит', () => {
  const { bin, sof } = canvas([[10, 10, 6, 10], [11, 5, 2, 2]]);
  const cs = segment(sof, bin, { minArea: 1 });
  eq(cs.length, 2);
  const { mask, bbox } = groupMask([0, 1], cs);
  eq(bbox, { x: 10, y: 5, w: 6, h: 15 });
  eq(mask.w >= bbox.w && mask.h >= bbox.h, true);
  const lit = [...mask.data].filter((v) => v > 0.5).length;
  eq(lit, 6 * 10 + 2 * 2, `в общей маске обе части, зажжённых ${lit}`);
});

test('traceGroup возвращает контур в координатах кропа', () => {
  const { bin, sof } = canvas([[10, 8, 8, 10]]);
  const cs = segment(sof, bin, {});
  const { shape, bbox } = traceGroup([0], cs, {});
  const b = bounds(shape);
  eq(Math.abs(b.x - bbox.x) < 2 && Math.abs(b.y - bbox.y) < 2, true,
    `контур стоит на месте буквы: ${b.x.toFixed(1)},${b.y.toFixed(1)} против ${bbox.x},${bbox.y}`);
  eq(Math.abs(b.w - bbox.w) < 2.5 && Math.abs(b.h - bbox.h) < 2.5, true,
    `и того же размера: ${b.w.toFixed(1)}×${b.h.toFixed(1)} против ${bbox.w}×${bbox.h}`);
});

test('buildGlyphs выстраивает буквы в порядке чтения', () => {
  const { bin, sof } = canvas([[24, 4, 5, 8], [4, 4, 5, 8], [14, 4, 5, 8]]);
  const { glyphs, rows } = buildGlyphs(sof, bin, {});
  eq(rows, 1);
  eq(glyphs.map((g) => g.bbox.x), [4, 14, 24]);
  eq(glyphs.every((g) => g.nodes >= 4), true, 'у каждой буквы есть контур');
});

test('buildGlyphs принимает готовые группы вместо автоматических', () => {
  const { bin, sof } = canvas([[4, 4, 5, 8], [14, 4, 5, 8]]);
  const { glyphs } = buildGlyphs(sof, bin, {}, [[0, 1]]);
  eq(glyphs.length, 1, 'две буквы склеены руками в одну');
  eq(glyphs[0].bbox.w, 15, 'габарит накрыл обе');
});

test('каждая буква получает своё увеличение', () => {
  const { bin, sof } = canvas([[4, 4, 4, 6], [14, 2, 6, 20]]);
  const { glyphs } = buildGlyphs(sof, bin, {});
  eq(glyphs[0].scale > glyphs[1].scale, true,
    `мелкой ×${glyphs[0].scale}, крупной ×${glyphs[1].scale}`);
});

// ─── подгонка под известный текст ───────────────────────────────────────────

import { mergeToCount, fitRows } from '../js/glyphs/merge.js';

test('лишние группы склеиваются по самым тесным зазорам', () => {
  // «Ы» разорвана надвое: между её половинами зазор 2, между буквами — 20
  const cs = [box(0, 0, 10, 20), box(30, 0, 6, 20), box(38, 0, 4, 20), box(62, 0, 10, 20)];
  const fitted = mergeToCount([[0], [1], [2], [3]], cs, 3);
  eq(fitted.length, 3);
  eq(fitted[1], [1, 2], 'склеились именно половинки, а не соседние буквы');
});

test('склейка идёт до нужного числа и не дальше', () => {
  const cs = [box(0, 0, 10, 20), box(12, 0, 10, 20), box(24, 0, 10, 20), box(36, 0, 10, 20)];
  eq(mergeToCount([[0], [1], [2], [3]], cs, 2).length, 2);
  eq(mergeToCount([[0], [1], [2], [3]], cs, 9).length, 4, 'больше, чем есть, не наделает');
});

test('многоточие из трёх точек сводится в один знак', () => {
  const cs = [box(0, 10, 12, 12), box(30, 18, 4, 4), box(37, 18, 4, 4), box(44, 18, 4, 4)];
  const fitted = mergeToCount([[0], [1], [2], [3]], cs, 2);
  eq(fitted.length, 2);
  eq(fitted[1], [1, 2, 3], 'все три точки — один знак');
});

test('fitRows подгоняет каждую строку под свою длину', () => {
  const cs = [box(0, 0, 8, 10), box(10, 0, 3, 10), box(20, 0, 8, 10),
    box(0, 30, 8, 10), box(20, 30, 8, 10)];
  const res = fitRows([[0], [1], [2], [3], [4]], cs, [2, 2]);
  eq(res.groups.length, 4, 'в первой строке склеилась пара, во второй всё цело');
  eq(res.short.length, 0);
});

test('нехватка групп не чинится молча, а докладывается', () => {
  const cs = [box(0, 0, 8, 10), box(20, 0, 8, 10)];
  const res = fitRows([[0], [1]], cs, [5]);
  eq(res.short, [0], 'строка 1 помечена как неполная');
  eq(res.groups.length, 2, 'разнимать слипшееся автоматика не берётся');
});

test('строка без ожидаемого числа остаётся как есть', () => {
  const cs = [box(0, 0, 8, 10), box(9, 0, 3, 10)];
  eq(fitRows([[0], [1]], cs, []).groups.length, 2);
});
