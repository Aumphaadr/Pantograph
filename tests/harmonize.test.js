import {
  symmetrizeShape, equalizeStems, pairStems, collectEdges, mirrorReconcile,
} from '../js/glyphs/harmonize.js';
import { rectContour } from '../js/core/primitives.js';

const node = (x, y, type = 'corner') => ({ p: { x, y }, in: null, out: null, type });
const poly = (pts) => ({ closed: true, nodes: pts.map(([x, y]) => node(x, y)) });

test('почти-симметричная буква становится точно симметричной', () => {
  // Треугольник-«А» со сбитой на 0.6 px левой ногой.
  const shape = { contours: [poly([[0.6, 20], [10, 0.3], [20, 20]])] };
  const { axes } = symmetrizeShape(shape, { tol: 1.2 });
  eq(axes.includes('x'), true, `вертикальная симметрия найдена: ${axes}`);
  const [a, top, b] = shape.contours[0].nodes;
  eq(a.p.y === b.p.y, true, 'ноги на одной высоте');
  const axis = (a.p.x + b.p.x) / 2;
  eq(Math.abs(top.p.x - axis) < 1e-9, true, 'вершина точно на оси');
});

test('несимметричное не насилуется', () => {
  const shape = { contours: [poly([[0, 20], [4, 0], [20, 20], [14, 26]])] };
  const { axes } = symmetrizeShape(shape, { tol: 1.2 });
  eq(axes.length, 0, `осей не найдено: ${axes}`);
});

test('пара зеркальных чаш согласуется между собой', () => {
  // Две «чаши Ф»: правая — зеркало левой, сбитое на полпикселя.
  const left = poly([[2, 2], [8, 2], [8, 12], [2, 12]]);
  const right = poly([[12.5, 2.4], [18.4, 2], [18.6, 12.3], [12.4, 12]]);
  const shape = { contours: [left, right] };
  const { axes } = symmetrizeShape(shape, { tol: 1.2 });
  eq(axes.includes('x'), true, `чаши спарились: ${axes}`);
  const xs = (c) => c.nodes.map((n) => n.p.x).sort((p, q) => p - q);
  const l = xs(shape.contours[0]);
  const r = xs(shape.contours[1]);
  const axis = (l[0] + r[r.length - 1]) / 2;
  for (let i = 0; i < l.length; i += 1) {
    eq(Math.abs((axis - l[i]) - (r[r.length - 1 - i] - axis)) < 1e-9, true,
      'чаши — точные зеркала');
  }
});

test('обе оси разом: прямоугольник-«О»', () => {
  const c = poly([[0.3, 0], [20, 0.4], [19.7, 30], [0, 29.6]]);
  const { axes } = symmetrizeShape({ contours: [c] }, { tol: 1.2 });
  eq(axes.includes('x') && axes.includes('y'), true, `обе оси: ${axes}`);
});

test('узел на оси встаёт точно на ось, рычаги зеркалятся', () => {
  const c = {
    closed: true,
    nodes: [
      { p: { x: 10.4, y: 0 }, in: { x: 4.3, y: 0.2 }, out: { x: 16.1, y: -0.2 }, type: 'smooth' },
      node(20, 20), node(0.2, 20),
    ],
  };
  symmetrizeShape({ contours: [c] }, { tol: 1.2 });
  const top = c.nodes[0];
  const axis = (c.nodes[1].p.x + c.nodes[2].p.x) / 2;
  eq(Math.abs(top.p.x - axis) < 1e-9, true, 'вершина на оси');
  eq(Math.abs((top.out.x - axis) + (top.in.x - axis)) < 1e-9, true, 'рычаги вершины зеркальны');
});

test('стемы одной группы приводятся к общей толщине', () => {
  // Две «Н»-стойки в одной букве: 9.6 и 10.4 — одна группа.
  const g = {
    shape: {
      contours: [
        rectContour({ x: 5, y: 15 }, 4.8, 15, 0),
        rectContour({ x: 25, y: 15 }, 5.2, 15, 0),
      ],
    },
  };
  const got = equalizeStems([g], { cap: 0.8, spread: 1.6 });
  eq(got >= 2, true, `штрихи найдены: ${got}`);
  const w = (c) => Math.abs(c.nodes[1].p.x - c.nodes[0].p.x);
  const w1 = w(g.shape.contours[0]);
  const w2 = w(g.shape.contours[1]);
  eq(Math.abs(w1 - w2) < 1e-9, true, `толщины сравнялись: ${w1} и ${w2}`);
});

test('слишком разные толщины не сливаются', () => {
  const g = {
    shape: {
      contours: [
        rectContour({ x: 5, y: 15 }, 5, 15, 0),    // 10
        rectContour({ x: 30, y: 15 }, 8, 15, 0),   // 16
      ],
    },
  };
  equalizeStems([g], { cap: 0.8, spread: 1.6 });
  const w = (c) => Math.abs(c.nodes[1].p.x - c.nodes[0].p.x);
  eq(w(g.shape.contours[0]), 10, 'тонкий остался тонким');
  eq(w(g.shape.contours[1]), 16, 'толстый — толстым');
});

test('дальше cap грань не двигается', () => {
  const g = {
    shape: {
      contours: [
        rectContour({ x: 5, y: 15 }, 4.4, 15, 0),   // 8.8
        rectContour({ x: 25, y: 15 }, 5.0, 15, 0),  // 10.0 — в spread, но d=0.6 > cap 0.4
      ],
    },
  };
  equalizeStems([g], { cap: 0.4, spread: 1.6 });
  const w = (c) => Math.abs(c.nodes[1].p.x - c.nodes[0].p.x);
  eq(w(g.shape.contours[0]), 8.8, 'узкий не тронут — сдвиг превысил бы cap');
});

test('collectEdges берёт только осевые прямые грани', () => {
  const g = { shape: { contours: [poly([[0, 0], [10, 3], [10, 20], [0, 20]])] } };
  const kinds = collectEdges([g]).map((e) => e.kind).sort();
  eq(kinds.join(','), 'h,v,v', 'наклонная грань не взята, три осевые взяты');
});

test('pairStems спаривает напротив стоящие грани, а не соседние буквы', () => {
  const g1 = { shape: { contours: [rectContour({ x: 5, y: 15 }, 5, 15, 0)] } };
  const g2 = { shape: { contours: [rectContour({ x: 5, y: 15 }, 5, 15, 0)] } };
  const stems = pairStems(collectEdges([g1, g2]), { heightOf: () => 30 });
  // Пара «верх и низ» стойки отстоит на весь рост — это габарит, не штрих.
  eq(stems.length, 2, `по одному настоящему штриху на букву, получено ${stems.length}`);
  eq(stems.every((s) => s.kind === 'v'), true, 'взяты стойки, а не рост');
  eq(stems.every((s) => s.a.gi === s.b.gi), true, 'пары не пересекают буквы');
});

test('зеркальная пересборка: лишний узел стороны исчезает, симметрия точная', () => {
  // Прямоугольник с лишним изломом на правой стороне; ось x=10 известна.
  const c = {
    closed: true,
    nodes: [
      node(2, 0), node(18, 0),
      node(18.4, 9, 'corner'),          // мусорный излом справа
      node(18, 20), node(2, 20),
    ],
  };
  const shape = { contours: [c] };
  const done = mirrorReconcile(shape, ['x'], { x: 10 }, { tol: 1.2 });
  eq(done.includes('x'), true, `ось взята: ${done}`);
  const xs = shape.contours[0].nodes.map((n) => n.p.x);
  for (const x of xs) {
    const mx = 2 * 10 - x;
    eq(xs.some((v) => Math.abs(v - mx) < 1e-9), true, `узел ${x} имеет зеркало`);
  }
  // левая сторона чище (2 узла против 3) — лишний излом должен уйти
  eq(shape.contours[0].nodes.length, 6, `узлов: 2 осевых + 2+2 сторон, получено ${shape.contours[0].nodes.length}`);
});

test('зеркальная пересборка пары контуров: худший заменяется зеркалом лучшего', () => {
  const left = poly([[2, 2], [8, 2], [8, 12], [2, 12]]);
  const right = poly([[12.3, 2], [18, 2.2], [18.2, 7], [18, 12], [12, 11.8]]); // грязная
  const shape = { contours: [left, right] };
  const done = mirrorReconcile(shape, ['x'], { x: 10.1 }, { tol: 1.2 });
  eq(done.includes('x'), true, `пара взята: ${done}`);
  eq(shape.contours[1].nodes.length, 4, 'грязная чаша стала зеркалом чистой');
  const xs = shape.contours[1].nodes.map((n) => +n.p.x.toFixed(4)).sort((a, b) => a - b);
  eq(xs[0], +(2 * 10.1 - 8).toFixed(4), 'координаты — точное зеркало');
});

test('несимметричный контур через ось не насилуется и не остаётся полуправленным', () => {
  // Флаг: левая половина — прямоугольник, правая — скошенная. Ось врёт.
  const flag = poly([[0, 0], [20, 6], [20, 20], [0, 20]]);
  const before = JSON.stringify(flag.nodes.map((n) => n.p));
  const done = mirrorReconcile({ contours: [flag] }, ['x'], { x: 10 }, { tol: 0.8 });
  eq(done.length, 0, 'ось честно не взята');
  eq(JSON.stringify(flag.nodes.map((n) => n.p)), before, 'контур не тронут — откат полный');
});

test('пара непохожих контуров не подменяется зеркалом', () => {
  const left = poly([[2, 2], [8, 2], [8, 12], [2, 12]]);
  const blob = poly([[12, 4], [18, 2], [18, 14], [12, 10]]);   // не зеркало
  const shape = { contours: [left, blob] };
  const before = JSON.stringify(blob.nodes.map((n) => n.p));
  const done = mirrorReconcile(shape, ['x'], { x: 10 }, { tol: 0.8 });
  eq(done.length, 0, 'подмена не случилась');
  eq(JSON.stringify(shape.contours[1].nodes.map((n) => n.p)), before, 'грязный контур не тронут');
});
