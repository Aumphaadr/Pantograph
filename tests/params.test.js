import {
  CONTROLS, defaults, groups, BASE_SIZE, sizeFactor, scaleControl, scaleControls, suggest,
} from '../js/ui/params.js';

const byKey = (list, key) => list.find((c) => c.key === key);

test('у каждой настройки есть подсказка и ключ', () => {
  for (const c of CONTROLS) {
    eq(typeof c.key === 'string' && c.key.length > 0, true, `${c.label}: ключ`);
    eq(typeof c.hint === 'string' && c.hint.length > 20, true, `${c.label}: подсказка по делу`);
  }
});

test('умолчания покрывают все настройки', () => {
  const d = defaults();
  for (const c of CONTROLS) eq(d[c.key] !== undefined, true, `${c.key} в умолчаниях`);
});

test('группы идут без повторов', () => {
  eq(new Set(groups()).size, groups().length);
});

test('множитель размера равен единице на базовом кропе', () => {
  eq(sizeFactor(BASE_SIZE, BASE_SIZE), 1);
  eq(sizeFactor(BASE_SIZE, 200), 1, 'считается по меньшей стороне');
});

test('множитель зажат с обеих сторон', () => {
  eq(sizeFactor(1, 1), 0.25, 'крошечный кроп не обнуляет допуски');
  eq(sizeFactor(9000, 9000), 40, 'огромный не уводит их в бесконечность');
});

test('на базовом размере настройки не меняются', () => {
  const s = suggest(BASE_SIZE, BASE_SIZE);
  const d = defaults();
  for (const key of ['simplify', 'fitError', 'cornerSpan']) {
    eq(Math.abs(s[key] - d[key]) < 0.06, true, `${key}: ${s[key]} против ${d[key]}`);
  }
});

test('длины растут линейно, площадь — в квадрате', () => {
  const f = 10;
  const one = byKey(scaleControls(f), 'simplify');
  const area = byKey(scaleControls(f), 'minArea');
  const base = defaults();
  eq(Math.abs(one.value - base.simplify * f) < one.step, true, `длина ×${f}: ${one.value}`);
  eq(Math.abs(area.value - base.minArea * f * f) < area.step * 2, true, `площадь ×${f}²: ${area.value}`);
});

test('пределы ползунка растут вместе со значением', () => {
  // Иначе «окно угла» с потолком в четыре пикселя на мастере бесполезно.
  const big = byKey(scaleControls(26), 'cornerSpan');
  eq(big.value <= big.max && big.value >= big.min, true,
    `значение ${big.value} внутри [${big.min}..${big.max}]`);
  eq(big.max > 20, true, `потолок ${big.max} даёт где развернуться`);
});

test('в значениях нет хвостов двоичной дроби', () => {
  for (const f of [0.6, 1, 3.7, 26.125]) {
    for (const c of scaleControls(f)) {
      if (c.type === 'select' || c.type === 'check') continue;
      eq(String(c.value).length <= 8, true, `${c.key} при ×${f}: ${c.value}`);
      eq(String(c.step).length <= 8, true, `шаг ${c.key} при ×${f}: ${c.step}`);
    }
  }
});

test('несоразмерные настройки не трогаются', () => {
  const scaled = scaleControls(26);
  for (const key of ['tolerance', 'upscale', 'level', 'open', 'close', 'cornerAngle']) {
    eq(byKey(scaled, key).value, defaults()[key], `${key} остался прежним`);
  }
});

test('списки не масштабируются', () => {
  eq(scaleControl(byKey(CONTROLS, 'symAxis'), 26).value, 'none');
});
