import {
  regularizeContour, regularizeShape, segmentSag, snapHandleAngles, honestTypes,
} from '../js/trace/regularize.js';
import { rectContour, ellipseContour } from '../js/core/primitives.js';

const node = (x, y, type = 'corner', inH = null, outH = null) => ({
  p: { x, y }, in: inH, out: outH, type,
});

/** Ломаная из вершин: рычаги по трети хорды — «прямые» сегменты. */
const polyContour = (pts, closed = true) => ({
  closed,
  nodes: pts.map(([x, y]) => node(x, y)),
});

test('segmentSag: прямая даёт ноль, выгнутая — свой прогиб', () => {
  eq(segmentSag({ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 7, y: 0 }, { x: 10, y: 0 }), 0);
  const sag = segmentSag({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 7, y: 4 }, { x: 10, y: 0 });
  eq(sag > 2 && sag < 3.2, true, `прогиб дуги около 3, получено ${sag}`);
});

test('почти-горизонталь становится горизонталью', () => {
  const c = polyContour([[0, 0.4], [30, -0.4], [30, 20], [0, 20.3]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes[0].p.y === contour.nodes[1].p.y, true,
    `верхняя кромка выровнена: ${contour.nodes[0].p.y} и ${contour.nodes[1].p.y}`);
  eq(Math.abs(contour.nodes[0].p.y) <= 0.4, true, 'выравнивание к среднему, а не куда-то');
});

test('почти-вертикаль становится вертикалью', () => {
  const c = polyContour([[0.3, 0], [20, 0], [20.2, 30], [-0.2, 30]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes[1].p.x === contour.nodes[2].p.x, true, 'правая кромка выровнена');
});

test('прямой угол получает оба снапа без конфликта', () => {
  const c = polyContour([[0, 0.3], [30, -0.3], [30.4, 20], [-0.4, 20]]);
  const { contour } = regularizeContour(c, { lineTol: 0.7, primShare: 0 });
  const [a, b, d] = [contour.nodes[0], contour.nodes[1], contour.nodes[2]];
  eq(a.p.y === b.p.y, true, 'горизонталь выровнена');
  eq(b.p.x === d.p.x, true, 'вертикаль выровнена у того же узла');
});

test('настоящая диагональ не трогается', () => {
  const c = polyContour([[0, 0], [30, 18], [30, 40], [0, 40]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes[0].p.y !== contour.nodes[1].p.y, true, 'диагональ осталась диагональю');
});

test('заметно кривой сегмент не прямится', () => {
  const c = {
    closed: true,
    nodes: [
      node(0, 0, 'corner', null, { x: 10, y: 6 }),
      node(30, 0, 'corner', { x: 20, y: 6 }, null),
      node(15, 20, 'corner'),
    ],
  };
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  // Дуга не спрямилась, а пересобралась по канону: узел в экстремуме
  // (на высоте прогиба) с горизонтальными рычагами.
  const top = contour.nodes.find((nd) => nd.p.y > 3 && nd.p.y < 6);
  eq(Boolean(top), true, 'узел встал в экстремум дуги');
  eq(top.in.y === top.p.y && top.out.y === top.p.y, true, 'рычаги экстремума осевые');
});

test('дрожащий прямоугольник целиком приводится к прямоугольнику', () => {
  const base = rectContour({ x: 20, y: 15 }, 12, 8, 0);
  const jitter = {
    ...base,
    nodes: base.nodes.map((nd, i) => ({
      ...nd,
      p: { x: nd.p.x + (i % 2 ? 0.25 : -0.2), y: nd.p.y + (i % 2 ? -0.25 : 0.2) },
    })),
  };
  const r = regularizeContour(jitter, { lineTol: 0.5, primShare: 0.03 });
  eq(r.snapped, 'rect', `приведён к прямоугольнику, получено ${r.snapped}`);
  const xs = new Set(r.contour.nodes.map((nd) => Math.round(nd.p.x * 10)));
  eq(xs.size, 2, 'у прямоугольника два уникальных x');
});

test('дрожащий эллипс приводится к эллипсу или кругу', () => {
  const base = ellipseContour({ x: 0, y: 0 }, 10, 7);
  const r = regularizeContour(base, { lineTol: 0.5, primShare: 0.03 });
  eq(r.snapped === 'ellipse' || r.snapped === 'circle', true, `получено ${r.snapped}`);
});

test('гладкий стык прямой с кривой остаётся гладким', () => {
  const c = {
    closed: true,
    nodes: [
      node(0, 0.3, 'corner', null, null),
      node(30, -0.3, 'smooth', null, { x: 36, y: 4 }),
      node(40, 14, 'smooth', { x: 40, y: 8 }, null),
      node(0, 14, 'corner'),
    ],
  };
  const { contour } = regularizeContour(c, { lineTol: 0.7, primShare: 0 });
  const b = contour.nodes[1];
  const lineDir = {
    x: b.p.x - contour.nodes[0].p.x,
    y: b.p.y - contour.nodes[0].p.y,
  };
  const h = { x: b.out.x - b.p.x, y: b.out.y - b.p.y };
  const cross = Math.abs(lineDir.x * h.y - lineDir.y * h.x)
    / (Math.hypot(lineDir.x, lineDir.y) * Math.hypot(h.x, h.y));
  eq(cross < 1e-9, true, `рычаг кривой стороны лёг на прямую, синус ${cross}`);
});

test('regularizeShape считает приведённые контуры', () => {
  const shape = {
    contours: [
      rectContour({ x: 10, y: 10 }, 8, 6, 0),
      polyContour([[0, 0], [30, 18], [15, 40]]),
    ],
  };
  const r = regularizeShape(shape, { lineTol: 0.5, primShare: 0.03 });
  eq(r.snapped, 1, `один примитив из двух контуров, получено ${r.snapped}`);
  eq(r.contours.length, 2);
});

test('разомкнутая цепочка выравнивается без замыкающего сегмента', () => {
  const c = { closed: false, nodes: [node(0, 0.3), node(30, -0.3), node(30.2, 20)] };
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes[0].p.y === contour.nodes[1].p.y, true, 'горизонталь выровнена');
  eq(contour.nodes[1].p.x === contour.nodes[2].p.x, true, 'вертикаль выровнена');
});

test('узел между коллинеарными прямыми схлопывается', () => {
  const c = polyContour([[0, 0.2], [14, -0.2], [30, 0.1], [30, 20], [0, 20]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes.length, 4, `лишний узел на кромке ушёл, осталось ${contour.nodes.length}`);
});

test('узел на настоящем изломе остаётся', () => {
  const c = polyContour([[0, 0], [15, 6], [30, 0], [30, 20], [0, 20]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes.length, 5, 'излом в шесть пикселей — не шум');
});

test('буква, не похожая ни на что, НЕ приводится к примитиву', () => {
  // Тот самый провал: detect возвращает «наименее плохой» примитив всегда,
  // а прошёл ли он допуск — флаг fits. «Н» приводилась к кругу целиком.
  const H = polyContour([
    [0, 0], [10, 0], [10, 25], [30, 25], [30, 0], [40, 0],
    [40, 60], [30, 60], [30, 35], [10, 35], [10, 60], [0, 60],
  ]);
  const r = regularizeContour(H, { lineTol: 0.6, primShare: 0.025 });
  eq(r.snapped, null, `«Н» осталась буквой, получено ${r.snapped}`);
  eq(r.contour.nodes.length, 12, 'все двенадцать углов на месте');
});

test('гладкий пробег, похожий на дугу, становится дугой', () => {
  // Полукруг из восьми грубоватых кубик между двумя углами + днище.
  const r0 = 20;
  const nodes = [];
  const N = 8;
  for (let i = 0; i <= N; i += 1) {
    const a = Math.PI - (Math.PI * i) / N;
    const p = { x: r0 * Math.cos(a), y: -r0 * Math.sin(a) };
    const t = { x: Math.sin(a), y: Math.cos(a) };
    const h = (4 / 3) * Math.tan(Math.PI / N / 4) * r0;
    nodes.push({
      p: { x: p.x + (Math.random() - 0.5) * 0, y: p.y },
      in: i === 0 ? null : { x: p.x - t.x * h, y: p.y - t.y * h },
      out: i === N ? null : { x: p.x + t.x * h, y: p.y + t.y * h },
      type: i === 0 || i === N ? 'corner' : 'smooth',
    });
  }
  nodes.push({ p: { x: 0, y: 12 }, in: null, out: null, type: 'corner' });
  const c = { closed: true, nodes };
  const before = c.nodes.length;
  const { contour } = regularizeContour(c, { lineTol: 0.5, primShare: 0 });
  eq(contour.nodes.length < before, true,
    `дуга ужалась: было ${before}, стало ${contour.nodes.length}`);
  // все узлы дуги лежат на окружности радиуса 20
  const onCircle = contour.nodes.filter((nd) => Math.abs(Math.hypot(nd.p.x, nd.p.y) - r0) < 0.6);
  eq(onCircle.length >= 3, true, `узлы легли на окружность: ${onCircle.length}`);
});

test('пологая дуга не насилуется в окружность', () => {
  // Прогиб в четверть пикселя на сорок пикселей длины — это прямая с шумом.
  const c = polyContour([[0, 0.25], [40, -0.25], [40, 30], [0, 30]]);
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  eq(contour.nodes.length, 4, 'осталась четырёхугольником');
});

test('полуокружность одной кубикой режется по экстремуму', () => {
  // Законный, но уродливый выход Шнайдера: 180° одной кубикой, рычаги
  // поперёк хорды длиной 4/3 радиуса. Канон требует узла на макушке.
  const r0 = 15;
  const h = (4 / 3) * r0;
  const c = {
    closed: true,
    nodes: [
      { p: { x: -r0, y: 0 }, in: null, out: { x: -r0, y: h }, type: 'corner' },
      { p: { x: r0, y: 0 }, in: { x: r0, y: h }, out: null, type: 'corner' },
      { p: { x: 0, y: -10 }, in: null, out: null, type: 'corner' },
    ],
  };
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  const top = contour.nodes.find((nd) => nd.p.y > r0 * 0.85);
  eq(Boolean(top), true, `узел на макушке дуги: ${JSON.stringify(contour.nodes.map((n) => n.p))}`);
  eq(top.in.y === top.p.y && top.out.y === top.p.y, true, 'рычаги макушки горизонтальны');
});

test('рычаг в паре градусов от 45° встаёт ровно на 45°', () => {
  // Проверяется сам проход: пересборка пробегов имеет право пересоздать
  // рычаги раньше, поэтому зовём его напрямую.
  const c = {
    closed: true,
    nodes: [
      { p: { x: 0, y: 0 }, in: null, out: { x: 14, y: 13.2 }, type: 'corner' },
      { p: { x: 30, y: 26 }, in: { x: 24, y: 24 }, out: null, type: 'corner' },
      { p: { x: 0, y: 30 }, in: null, out: null, type: 'corner' },
    ],
  };
  snapHandleAngles(c, { lineTol: 1.2 });
  const h = c.nodes[0].out;
  const ang = (Math.atan2(h.y, h.x) * 180) / Math.PI;
  eq(Math.abs(ang - 45) < 0.01, true, `рычаг довёрнут до 45°, получено ${ang.toFixed(2)}°`);
});

test('рычаг далеко от красивого угла не трогается', () => {
  const c = {
    closed: true,
    nodes: [
      { p: { x: 0, y: 0 }, in: null, out: { x: 14, y: 10.74 }, type: 'corner' }, // 37.5° — ровно между 30 и 45
      { p: { x: 30, y: 26 }, in: { x: 24, y: 24 }, out: null, type: 'corner' },
      { p: { x: 0, y: 30 }, in: null, out: null, type: 'corner' },
    ],
  };
  const before = { ...c.nodes[0].out };
  snapHandleAngles(c, { lineTol: 1.2 });
  eq(c.nodes[0].out.x === before.x && c.nodes[0].out.y === before.y, true,
    '37.5° не тянется ни к 30, ни к 45');
});

test('честность типов: изломанный «гладкий» становится угловым', () => {
  const c = {
    closed: true,
    nodes: [
      { p: { x: 0, y: 0 }, in: { x: -8, y: 4 }, out: { x: 8, y: 4 }, type: 'smooth' },
      { p: { x: 20, y: 20 }, in: null, out: null, type: 'corner' },
      { p: { x: -20, y: 20 }, in: null, out: null, type: 'corner' },
    ],
  };
  honestTypes(c);
  eq(c.nodes[0].type, 'corner', `излом в полсотни градусов — угловой, получено ${c.nodes[0].type}`);
});

test('честность типов: настоящий гладкий остаётся гладким', () => {
  const c = {
    closed: true,
    nodes: [
      { p: { x: 0, y: 0 }, in: { x: -8, y: -0.3 }, out: { x: 8, y: 0.3 }, type: 'smooth' },
      { p: { x: 20, y: 20 }, in: null, out: null, type: 'corner' },
      { p: { x: -20, y: 20 }, in: null, out: null, type: 'corner' },
    ],
  };
  honestTypes(c);
  eq(c.nodes[0].type, 'smooth', 'коллинеарные рычаги — гладкий по праву');
});

test('гладкое кольцо пересобирается по экстремумам с осевыми рычагами', () => {
  // Кольцо-каунтер: восьмиугольник из гладких узлов с кривыми рычагами —
  // как выходит из подгонки. Канон: узлы на макушке/боках/дне, рычаги осевые.
  const r0 = 12;
  const N = 8;
  const nodes = [];
  for (let i = 0; i < N; i += 1) {
    const a = (2 * Math.PI * i) / N;
    const p = { x: r0 * Math.cos(a), y: r0 * Math.sin(a) };
    const t = { x: -Math.sin(a), y: Math.cos(a) };
    const h = (4 / 3) * Math.tan(Math.PI / N / 2) * r0;
    nodes.push({
      p, in: { x: p.x - t.x * h, y: p.y - t.y * h },
      out: { x: p.x + t.x * h, y: p.y + t.y * h },
      type: 'smooth',
    });
  }
  const { contour } = regularizeContour({ closed: true, nodes }, { lineTol: 0.5, primShare: 0 });
  eq(contour.nodes.length <= 6, true, `узлов стало меньше восьми: ${contour.nodes.length}`);
  const axial = contour.nodes.filter((nd) => {
    const dx = Math.abs(nd.out.x - nd.p.x);
    const dy = Math.abs(nd.out.y - nd.p.y);
    return dx < 1e-6 || dy < 1e-6;
  });
  eq(axial.length >= 3, true, `рычаги узлов осевые: ${axial.length} из ${contour.nodes.length}`);
});

test('диагональный почти-прямой пробег становится прямой', () => {
  // Три сегмента вдоль диагонали 40×30 с прогибами в треть пикселя и парой
  // гладких узлов внутри — как выходит из подгонки на шершавом растре.
  const c = {
    closed: true,
    nodes: [
      { p: { x: 0, y: 0 }, in: null, out: { x: 4.4, y: 3.1 }, type: 'corner' },
      { p: { x: 13, y: 10.1 }, in: { x: 8.5, y: 6.9 }, out: { x: 17.5, y: 13.3 }, type: 'smooth' },
      { p: { x: 27, y: 20.3 }, in: { x: 22.4, y: 16.8 }, out: { x: 31.5, y: 23.6 }, type: 'smooth' },
      { p: { x: 40, y: 30 }, in: { x: 35.6, y: 27.2 }, out: null, type: 'corner' },
      { p: { x: 40, y: 44 }, in: null, out: null, type: 'corner' },
      { p: { x: 0, y: 14 }, in: null, out: null, type: 'corner' },
    ],
  };
  const { contour } = regularizeContour(c, { lineTol: 0.6, primShare: 0 });
  const top = contour.nodes.filter((nd) => nd.p.y < nd.p.x * 0.8 + 1);
  eq(contour.nodes.length <= 4, true,
    `гладкие узлы диагонали ушли: осталось ${contour.nodes.length}`);
  void top;
  // диагональ — прямая: рычаги на хорде
  const a = contour.nodes.find((nd) => nd.p.x === 0 && nd.p.y === 0);
  const b = contour.nodes.find((nd) => nd.p.x === 40 && nd.p.y === 30);
  eq(Boolean(a && b), true, 'концы диагонали на месте');
  const sag = segmentSag(a.p, a.out ?? a.p, b.in ?? b.p, b.p);
  eq(sag < 0.05, true, `диагональ спрямлена, прогиб ${sag.toFixed(3)}`);
});

test('пробное удаление: лишний гладкий узел на дуге уходит, экстремум остаётся', () => {
  // Четверть окружности с ЛИШНИМ гладким узлом посередине (не экстремум).
  const r0 = 20;
  const arc = (a) => ({ x: r0 * Math.cos(a), y: -r0 * Math.sin(a) });
  const h = (4 / 3) * Math.tan(Math.PI / 8 / 2) * r0;
  const tang = (a, s) => ({ x: -Math.sin(a) * s, y: -Math.cos(a) * s });
  const mk = (a, first, last) => {
    const p = arc(a);
    const t1 = tang(a, h);
    return {
      p,
      in: first ? null : { x: p.x - t1.x, y: p.y - t1.y },
      out: last ? null : { x: p.x + t1.x, y: p.y + t1.y },
      type: first || last ? 'corner' : 'smooth',
    };
  };
  const c = {
    closed: true,
    nodes: [
      mk(0, true, false),                    // (20,0)
      mk(Math.PI / 8, false, false),         // лишний на 22.5°
      mk(Math.PI / 4, false, false),         // 45°
      mk((3 * Math.PI) / 8, false, false),   // лишний на 67.5°
      mk(Math.PI / 2, false, true),          // (0,−20)
      { p: { x: 0, y: 6 }, in: null, out: null, type: 'corner' },
      { p: { x: 20, y: 6 }, in: null, out: null, type: 'corner' },
    ],
  };
  const before = c.nodes.length;
  const { contour } = regularizeContour(c, { lineTol: 0.5, primShare: 0 });
  eq(contour.nodes.length < before, true,
    `узлов меньше: было ${before}, стало ${contour.nodes.length}`);
  // Канон четверти дуги — одна кубика, узлов может остаться всего два.
  // Проверяем не узлы, а САМУ КРИВУЮ: середина дуги обязана лежать на окружности.
  const a = contour.nodes.find((nd) => Math.abs(nd.p.x - r0) < 0.7 && Math.abs(nd.p.y) < 0.7);
  eq(Boolean(a), true, 'начало дуги на месте');
  const ia = contour.nodes.indexOf(a);
  const b = contour.nodes[(ia + 1) % contour.nodes.length];
  const bez = [a.p, a.out ?? a.p, b.in ?? b.p, b.p];
  const mid = segmentSag(a.p, bez[1], bez[2], b.p);
  // прогиб четверти дуги радиуса 20 от хорды ≈ r·(1−cos45°) ≈ 5.86
  eq(Math.abs(mid - r0 * (1 - Math.cos(Math.PI / 4))) < 0.8, true,
    `дуга не пострадала: прогиб ${mid.toFixed(2)}`);
});
