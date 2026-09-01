import { toLayeredSvg } from '../js/export/svg.js';
const layerShape = (x) => ({
  contours: [{
    closed: true,
    nodes: [
      { p: { x, y: 0 }, in: null, out: null, type: 'corner' },
      { p: { x: x + 2, y: 0 }, in: null, out: null, type: 'corner' },
      { p: { x: x + 2, y: 2 }, in: null, out: null, type: 'corner' },
    ],
  }],
});

test('toLayeredSvg даёт группу на слой с меткой Inkscape', () => {
  const out = toLayeredSvg([
    { name: 'Гора', fg: [140, 144, 148], shape: layerShape(0) },
    { name: 'Пар', fg: [232, 183, 90], shape: layerShape(4) },
  ], { width: 10, height: 10 });
  eq((out.match(/<g /g) || []).length, 2, 'по группе на слой');
  eq(out.includes('inkscape:groupmode="layer"'), true, 'группа объявлена слоем');
  eq(out.includes('inkscape:label="Гора"'), true, 'слой назван');
  eq(out.includes('xmlns:inkscape'), true, 'пространство имён объявлено');
});

test('toLayeredSvg по умолчанию красит плоским чёрным', () => {
  const out = toLayeredSvg([{ name: 'A', fg: [200, 100, 50], shape: layerShape(0) }],
    { width: 4, height: 4 });
  eq(out.includes('fill="#000"'), true, 'плоский чёрный');
});

test('toLayeredSvg по просьбе красит цветом с картинки', () => {
  const out = toLayeredSvg([{ name: 'A', fg: [200, 100, 50], shape: layerShape(0) }],
    { width: 4, height: 4, colored: true });
  eq(out.includes('fill="#c86432"'), true, `цвет слоя, получено: ${out}`);
});

test('toLayeredSvg не выгружает погашенные слои', () => {
  const out = toLayeredSvg([
    { name: 'A', fg: [0, 0, 0], shape: layerShape(0) },
    { name: 'B', fg: [0, 0, 0], shape: layerShape(4), visible: false },
  ], { width: 4, height: 4 });
  eq((out.match(/<g /g) || []).length, 1, 'видимый слой один');
});

test('toLayeredSvg экранирует имя слоя', () => {
  const out = toLayeredSvg([{ name: 'Пар & "дым" <1>', fg: [0, 0, 0], shape: layerShape(0) }],
    { width: 4, height: 4 });
  eq(out.includes('&amp;') && out.includes('&quot;') && out.includes('&lt;1&gt;'), true,
    `имя экранировано, получено: ${out}`);
});

test('осевая линия выгружается обводкой, а не заливкой', () => {
  const stroke = { ...layerShape(0), contours: [{ ...layerShape(0).contours[0], width: 2.5 }] };
  const out = toLayeredSvg([{ name: 'Штрих', fg: [0, 0, 0], shape: stroke }],
    { width: 10, height: 10 });
  eq(out.includes('fill="none"'), true, 'без заливки');
  eq(out.includes('stroke-width="2.5"'), true, `толщина в файле, получено: ${out}`);
  eq(out.includes('stroke-linecap="round"'), true, 'концы скруглены');
});

test('у каждого контура осевой своя толщина — свой путь', () => {
  const c = (x, w) => ({ ...layerShape(x).contours[0], width: w });
  const out = toLayeredSvg([{ name: 'A', fg: [0, 0, 0], shape: { contours: [c(0, 2), c(5, 4)] } }],
    { width: 10, height: 10 });
  eq((out.match(/<path /g) || []).length, 2, 'по пути на контур');
  eq(out.includes('stroke-width="2"') && out.includes('stroke-width="4"'), true, 'толщины разные');
});
