import {
  createMask, colorDistance, sampleColor, guessBackground, guessForeground,
  upscale, threshold, erode, dilate, morph, pad, capScale,
} from '../js/prep/mask.js';

const img = (w, h, px) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const c = px(i % w, Math.floor(i / w));
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

const BG = [15, 16, 18];
const FG = [232, 183, 90];
const mix = (t) => BG.map((v, i) => Math.round(v + (FG[i] - v) * t));

test('colorDistance читает антиалиасинг как покрытие', () => {
  const m = colorDistance(img(3, 1, (x) => [BG, mix(0.5), FG][x]), { fg: FG, bg: BG, tolerance: 60 });
  eq(m.data[0] < 0.02, true, 'фон гасится');
  eq(Math.abs(m.data[1] - 0.5) < 0.02, true, `полутон даёт ~0.5, получено ${m.data[1]}`);
  eq(Math.abs(m.data[2] - 1) < 1e-6, true, 'штрих даёт 1');
});

test('colorDistance гасит чужой цвет, а не только тёмный', () => {
  // Синий той же яркости, что и штрих: по оси проецируется, вбок — далеко.
  const m = colorDistance(img(1, 1, () => [60, 90, 232]), { fg: FG, bg: BG, tolerance: 60 });
  eq(m.data[0] === 0, true, `чужой цвет гасится, получено ${m.data[0]}`);
});

test('colorDistance переживает совпадение фона и штриха', () => {
  const m = colorDistance(img(2, 1, () => FG), { fg: FG, bg: FG, tolerance: 60 });
  eq([...m.data], [0, 0]);
});

test('sampleColor усредняет окрестность', () => {
  const m = sampleColor(img(3, 3, (x, y) => (x === 1 && y === 1 ? [255, 255, 255] : [0, 0, 0])), 1, 1, 1);
  eq(m, [28, 28, 28]);
});

test('guessBackground берёт самый частый цвет', () => {
  const bg = guessBackground(img(4, 4, (x, y) => ((x + y) === 0 ? [250, 250, 250] : [16, 16, 16])));
  eq(bg.map((v) => v >> 4), [1, 1, 1], `тёмный, получено ${bg}`);
});

test('guessForeground берёт самый далёкий от фона', () => {
  const fg = guessForeground(img(3, 1, (x) => [[16, 16, 16], [200, 160, 80], [90, 90, 90]][x]), [16, 16, 16]);
  eq(fg, [200, 160, 80]);
});

test('upscale множит размер и держит значения в 0..1', () => {
  const m = createMask(4, 3);
  m.data.set([0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0]);
  const up = upscale(m, 4);
  eq([up.w, up.h], [16, 12]);
  const bad = [...up.data].filter((v) => v < 0 || v > 1).length;
  eq(bad, 0, 'звон фильтра зажат');
});

test('upscale на однородном поле ничего не выдумывает', () => {
  const m = createMask(5, 5);
  m.data.fill(0.4);
  const up = upscale(m, 3);
  const off = [...up.data].filter((v) => Math.abs(v - 0.4) > 1e-4).length;
  eq(off, 0, 'постоянное поле остаётся постоянным');
});

test('upscale с коэффициентом 1 возвращает ту же маску', () => {
  const m = createMask(2, 2);
  eq(upscale(m, 1) === m, true);
});

test('threshold бинаризует по строгому больше', () => {
  const m = createMask(3, 1);
  m.data.set([0.4, 0.5, 0.6]);
  eq([...threshold(m, 0.5).data], [0, 0, 1]);
});

test('erode и dilate — минимум и максимум в окне', () => {
  const m = createMask(5, 1);
  m.data.set([0, 0, 1, 0, 0]);
  eq([...dilate(m, 1).data], [0, 1, 1, 1, 0]);
  eq([...erode(m, 1).data], [0, 0, 0, 0, 0]);
});

test('размыкание убирает одиночную крапину', () => {
  const m = createMask(5, 5);
  m.data[12] = 1;
  eq([...morph(m, { open: 1 }).data].every((v) => v === 0), true);
});

test('замыкание латает разрыв в штрихе', () => {
  // Оператор двумерный, поэтому и полоса должна быть в три ряда высотой:
  // на маске в один ряд эрозия квадратом 3×3 законно съедает всё.
  const m = createMask(7, 5);
  for (let y = 1; y <= 3; y += 1) {
    for (const x of [1, 2, 4, 5]) m.data[y * 7 + x] = 1;
  }
  const out = morph(m, { close: 1 });
  eq([...out.data.slice(2 * 7, 3 * 7)], [0, 1, 1, 1, 1, 1, 0], 'разрыв в среднем ряду закрыт');
});

test('pad окантовывает нулями и не сдвигает содержимое', () => {
  const m = createMask(2, 2);
  m.data.set([1, 2, 3, 4]);
  const p = pad(m, 1);
  eq([p.w, p.h], [4, 4]);
  eq([...p.data.slice(5, 7)], [1, 2]);
  eq([...p.data.slice(0, 4)], [0, 0, 0, 0]);
});

test('capScale не даёт маске разрастись сверх меры', () => {
  eq(capScale(48, 48, 6), 6, 'мелкому кропу увеличение не режется');
  eq(capScale(1254, 1254, 6), 1, 'картинке 1254² увеличение не нужно и не по карману');
  eq(capScale(1000, 1000, 8, 4e6) * 1000 <= 2000, true, 'маска остаётся в пределах лимита');
  eq(capScale(10, 10, 0), 1, 'ниже единицы не опускаемся');
});

test('цвет штриха берётся срединным, а не самым дальним', () => {
  // Двадцать золотых пикселей и один пересвеченный белый: раньше догадка
  // уезжала в белый, и маска ловила полпроцента картинки.
  const px = (x) => (x === 0 ? [255, 255, 255] : x < 21 ? [230, 181, 74] : [8, 8, 8]);
  const fg = guessForeground(img(40, 1, (x) => px(x)), [8, 8, 8]);
  eq(fg, [230, 181, 74], `получено ${fg}`);
});

test('одноцветная картинка не роняет догадку', () => {
  eq(guessForeground(img(4, 4, () => [8, 8, 8]), [8, 8, 8]), [8, 8, 8]);
});

test('догадка по-прежнему находит штрих там, где он один', () => {
  const fg = guessForeground(img(10, 1, (x) => (x < 3 ? [240, 190, 80] : [10, 10, 10])), [10, 10, 10]);
  eq(fg, [240, 190, 80]);
});
