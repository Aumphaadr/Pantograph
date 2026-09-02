import { descend, axesFor, objective } from '../js/tune/tune.js';

const BASE = {
  level: 0.5, tolerance: 70, simplify: 0.18, fitError: 0.25,
  cornerAngle: 68, cornerSpan: 1.2, open: 0, close: 0,
};

// Подделка мира: узлов тем меньше, чем больше fitError, но при fitError
// выше порога контур перестаёт сходиться с растром.
const world = (p) => ({
  nodes: Math.round(60 / p.fitError),
  drift: p.fitError > 1 ? 1.4 : 0.2,
  compBin: 2,
  compRen: p.close > 0 ? 1 : 2,   // замыкание склеивает куски — компонента теряется
});

test('спуск уменьшает узлы, не пробивая потолок расхождения', async () => {
  const r = await descend({ evaluate: async (p) => world(p), base: BASE });
  eq(r.aborted, false);
  eq(r.result.nodes < r.baseline.nodes, true,
    `узлов меньше: было ${r.baseline.nodes}, стало ${r.result.nodes}`);
  eq(r.params.fitError <= 1, true, `fitError не пробил потолок: ${r.params.fitError}`);
  eq(r.result.drift <= 0.5, true, `увод края в допуске: ${r.result.drift}`);
});

test('кандидат, теряющий компоненту, отвергается', async () => {
  const r = await descend({ evaluate: async (p) => world(p), base: BASE });
  eq(r.params.close, 0, 'замыкание, склеившее куски, не принято');
});

test('обрыв возвращает лучшее из найденного и признаётся', async () => {
  let calls = 0;
  const r = await descend({
    evaluate: async (p) => { calls += 1; return world(p); },
    base: BASE,
    aborted: () => calls >= 5,
  });
  eq(r.aborted, true, 'обрыв признан');
  eq(Boolean(r.params), true, 'лучшие параметры отданы');
});

test('прогресс идёт по порядку и знает свой потолок', async () => {
  const seen = [];
  await descend({
    evaluate: async (p) => world(p),
    base: BASE,
    onStep: (s, t) => seen.push([s, t]),
  });
  eq(seen.length > 10, true, `шагов набралось: ${seen.length}`);
  eq(seen.every(([s, t]) => s <= t), true, 'счёт не выходит за потолок');
  eq(seen[seen.length - 1][0] <= seen[0][1], true, 'потолок один на весь спуск');
});

test('когда исходное состояние хуже потолка, требуем не хуже исходного', async () => {
  // Всё расходится на 3% что ни делай; узлы зависят от simplify.
  const r = await descend({
    evaluate: async (p) => ({
      nodes: Math.round(30 / p.simplify), drift: 1.1, compBin: 1, compRen: 1,
    }),
    base: BASE,
  });
  eq(r.result.nodes < r.baseline.nodes, true, 'узлы всё равно ужаты');
});

test('оси не предлагают текущее значение и уважают границы', () => {
  for (const ax of axesFor(BASE)) {
    for (const fine of [false, true]) {
      const vals = ax.values(BASE[ax.key], fine);
      eq(vals.includes(BASE[ax.key]), false, `${ax.key}: текущее не предлагается`);
      eq(vals.length > 0, true, `${ax.key}: есть что пробовать`);
    }
  }
  eq(axesFor(BASE).find((a) => a.key === 'level').values(0.75, false).every((v) => v <= 0.8), true,
    'уровень не выходит за 0.8');
});

test('баланс: узел стоит долю увода, а не всё', async () => {
  // Правило владельца: 7 узлов при сходстве 96 % хуже 8 узлов при 99 %.
  // Мир: fitError ≥ 0.5 сбрасывает узел, но увод растёт на 0.2 px — дороже узла.
  const r = await descend({
    evaluate: async (p) => (p.fitError >= 0.5
      ? { nodes: 7, drift: 0.25, compBin: 1, compRen: 1, units: 1 }
      : { nodes: 8, drift: 0.05, compBin: 1, compRen: 1, units: 1 }),
    base: BASE,
  });
  eq(r.result.nodes, 8, `взят точный контур: узлов ${r.result.nodes}, увод ${r.result.drift}`);
  eq(objective({ nodes: 8, drift: 0.05, units: 1 }) < objective({ nodes: 7, drift: 0.25, units: 1 }), true,
    'целевая функция считает точность дороже узла');
  // Но узел, купленный за сотую пикселя, — лишний.
  eq(objective({ nodes: 7, drift: 0.06, units: 1 }) < objective({ nodes: 8, drift: 0.05, units: 1 }), true,
    'узел за сотую пикселя не берётся');
});
