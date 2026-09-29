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
  for (const key of ['simplify', 'fitError']) {
    eq(Math.abs(s[key] - d[key]) < 0.06, true, `${key}: ${s[key]} против ${d[key]}`);
  }
  // Окно угла — исключение: его умолчание задано для больших картинок,
  // а на базовом кропе в 48 px оно вдвое уже, иначе шире самой фигуры.
  eq(s.cornerSpan, d.cornerSpan / 2, `окно угла на базовом кропе: ${s.cornerSpan}`);
});

test('длины растут медленнее размера, мусор — линейно', () => {
  // Степени — по сверке с настоящими иконками (ARCHITECTURE, 4ж): крапина
  // рендера не растёт с картинкой, квадратичный порог съедал точки конфетти.
  const f = 10;
  const one = byKey(scaleControls(f), 'simplify');
  const area = byKey(scaleControls(f), 'minArea');
  const base = defaults();
  eq(Math.abs(one.value - base.simplify * f ** 0.6) < one.step, true, `длина ×${f}^0.6: ${one.value}`);
  eq(one.value < base.simplify * f, true, 'линейный рост был бы щедрее нужного');
  eq(Math.abs(area.value - base.minArea * f) < area.step * 2, true, `мусор ×${f}: ${area.value}`);
});

test('окно угла не растёт с картинкой: оно про антиалиасинг, а не про фигуру', () => {
  const big = byKey(scaleControls(26), 'cornerSpan');
  const mid = byKey(scaleControls(2), 'cornerSpan');
  const tiny = byKey(scaleControls(0.5), 'cornerSpan');
  const d = defaults();
  eq(big.value, d.cornerSpan, `на мастере — умолчание: ${big.value}`);
  eq(mid.value, d.cornerSpan, `со ста пикселей — тоже: ${mid.value}`);
  eq(tiny.value, d.cornerSpan / 2, `на крошечном кропе — вдвое меньше, но не меньше: ${tiny.value}`);
  eq(big.max, tiny.max, 'пределы одни');
});

test('пределы ползунка растут вместе со значением', () => {
  // Иначе «точность» с потолком в шесть пикселей на мастере бесполезна.
  const big = byKey(scaleControls(26), 'fitError');
  eq(big.value <= big.max && big.value >= big.min, true,
    `значение ${big.value} внутри [${big.min}..${big.max}]`);
  eq(big.max > 10, true, `потолок ${big.max} даёт где развернуться`);
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
