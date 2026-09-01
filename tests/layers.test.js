import { createMask } from '../js/prep/mask.js';
import {
  resolveDisputes, layerMasks, unionMask, guessInks,
} from '../js/prep/layers.js';

// Float32 не хранит 0.9 точно — сравниваем округлённое.
const vals = (m) => [...m.data].map((v) => Math.round(v * 100) / 100);

const mask = (values) => {
  const m = createMask(values.length, 1);
  m.data.set(values);
  return m;
};

const img = (w, h, px) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const c = px(i % w, Math.floor(i / w));
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

const BG = [15, 16, 18];
const GOLD = [232, 183, 90];
const GREY = [140, 144, 148];

test('спорный пиксель отходит слою с наибольшим значением', () => {
  const a = mask([0.9, 0.2, 0]);
  const b = mask([0.4, 0.7, 0]);
  resolveDisputes([a, b]);
  eq(vals(a), [0.9, 0, 0], 'первый забирает первый пиксель');
  eq(vals(b), [0, 0.7, 0], 'второй забирает второй');
});

test('ничейный пиксель остаётся нулём у всех', () => {
  const a = mask([0, 0.5]);
  const b = mask([0, 0.1]);
  resolveDisputes([a, b]);
  eq(vals(a), [0, 0.5]);
  eq(vals(b), [0, 0]);
});

test('маски после разбора не пересекаются', () => {
  const a = mask([0.9, 0.5, 0.3, 0]);
  const b = mask([0.8, 0.6, 0.3, 0]);
  const c = mask([0.1, 0.9, 0.2, 0]);
  resolveDisputes([a, b, c]);
  for (let i = 0; i < 4; i += 1) {
    const live = [a, b, c].filter((m) => m.data[i] > 0).length;
    eq(live <= 1, true, `пиксель ${i} принадлежит не более чем одному слою`);
  }
});

test('при равенстве побеждает первый — ответ не должен плавать', () => {
  const a = mask([0.5]);
  const b = mask([0.5]);
  resolveDisputes([a, b]);
  eq(vals(a), [0.5]);
  eq(vals(b), [0]);
});

test('один слой не трогается вовсе', () => {
  const a = mask([0.3, 0.7]);
  resolveDisputes([a]);
  eq(vals(a), [0.3, 0.7]);
});

test('маски разного размера — честная ошибка, а не тихий мусор', () => {
  let caught = '';
  try { resolveDisputes([mask([0, 0]), mask([0])]); } catch (err) { caught = err.message; }
  eq(caught.includes('разного размера'), true, `получено: ${caught}`);
});

test('layerMasks разводит два цвета по слоям', () => {
  const im = img(3, 1, (x) => [BG, GOLD, GREY][x]);
  const [gold, grey] = layerMasks(im, BG, [
    { fg: GOLD, tolerance: 60 },
    { fg: GREY, tolerance: 60 },
  ]);
  eq(gold.data[1] > 0.9 && grey.data[1] === 0, true, 'золотой пиксель — золотому слою');
  eq(grey.data[2] > 0.9 && gold.data[2] === 0, true, 'серый пиксель — серому слою');
  eq(gold.data[0] < 0.02 && grey.data[0] < 0.02, true, 'фон ничей');
});

test('без exclusive слои вольны пересекаться', () => {
  const im = img(1, 1, () => GOLD);
  const [a, b] = layerMasks(im, BG, [
    { fg: GOLD, tolerance: 200 },
    { fg: GREY, tolerance: 200 },
  ], { exclusive: false });
  eq(a.data[0] > 0 && b.data[0] > 0, true, 'пиксель достался обоим');
});

test('unionMask берёт поэлементный максимум', () => {
  const u = unionMask([mask([0.2, 0.8]), mask([0.6, 0.1])]);
  eq(vals(u), [0.6, 0.8]);
});

test('guessInks находит два чернила двухцветной картинки', () => {
  // Шахматка из золотого и серого на общем фоне.
  const im = img(12, 12, (x, y) => {
    if (x < 3) return BG;
    return (x + y) % 2 ? GOLD : GREY;
  });
  const inks = guessInks(im, BG, { k: 3 });
  eq(inks.length, 2, `найдено ${inks.length} чернил: ${JSON.stringify(inks)}`);
  const near = (c, want) => Math.abs(c[0] - want[0]) < 12 && Math.abs(c[1] - want[1]) < 12;
  eq(inks.some((c) => near(c, GOLD)), true, `золотое чернило: ${JSON.stringify(inks)}`);
  eq(inks.some((c) => near(c, GREY)), true, `серое чернило: ${JSON.stringify(inks)}`);
});

test('guessInks на одноцветной картинке даёт один слой', () => {
  const im = img(10, 10, (x) => (x < 4 ? BG : GOLD));
  eq(guessInks(im, BG, { k: 3 }).length, 1);
});

test('guessInks молчит, когда кроп пуст', () => {
  eq(guessInks(img(4, 4, () => BG), BG, { k: 3 }), []);
});

test('guessInks повторяем: один ответ на одну картинку', () => {
  const im = img(12, 12, (x, y) => (x < 3 ? BG : ((x + y) % 2 ? GOLD : GREY)));
  eq(guessInks(im, BG, { k: 3 }), guessInks(im, BG, { k: 3 }));
});
