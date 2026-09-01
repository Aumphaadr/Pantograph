import { createMask } from '../js/prep/mask.js';
import { isolines, detectCorners, traceMask, dechamfer, sharpenCorners, traceStroke } from '../js/trace/trace.js';
import { contourArea, countNodes, flatten, signedArea, reverseContour } from '../js/core/path.js';
import { rdp, rdpClosed } from '../js/core/simplify.js';
import { fitCurves, endTangent, evalCubic, norm, sub, dist } from '../js/core/bezier.js';
import { toPathData } from '../js/export/svg.js';

/** Мягкий диск: значение = покрытие пикселя, ровно как даёт антиалиасинг. */
function disk(size, cx, cy, r, inner = 0) {
  const m = createMask(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let v = Math.max(0, Math.min(1, r - d + 0.5));
      if (inner) v = Math.min(v, Math.max(0, Math.min(1, d - inner + 0.5)));
      m.data[y * size + x] = v;
    }
  }
  return m;
}

function square(size, x0, x1) {
  const m = createMask(size, size);
  for (let y = x0; y < x1; y += 1) for (let x = x0; x < x1; x += 1) m.data[y * size + x] = 1;
  return m;
}

// ─── упрощение ──────────────────────────────────────────────────────────────

test('rdp выбрасывает точки на прямой', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
  eq(rdp(pts, 0.1).length, 2);
});

test('rdp держит излом', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 5 }];
  eq(rdp(pts, 0.1).length, 3);
});

test('rdpClosed не зависит от того, с какой точки начат обход', () => {
  const n = 40;
  const loop = Array.from({ length: n }, (_, i) => ({
    x: Math.cos((i / n) * 2 * Math.PI) * 10, y: Math.sin((i / n) * 2 * Math.PI) * 10,
  }));
  const a = rdpClosed(loop, 0.3).length;
  const b = rdpClosed(loop.slice(7).concat(loop.slice(0, 7)), 0.3).length;
  eq(a, b, `с разных стартов ${a} и ${b}`);
});

// ─── подгонка кривых ────────────────────────────────────────────────────────

test('fitCurves ложится на настоящую кубику почти точно', () => {
  const truth = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 40, y: 30 }, { x: 50, y: 0 }];
  const pts = Array.from({ length: 40 }, (_, i) => evalCubic(truth, i / 39));
  const fitted = fitCurves(pts, endTangent(pts, 0, 1), endTangent(pts, pts.length - 1, -1), 0.05);
  eq(fitted.length, 1, `хватает одной кривой, вышло ${fitted.length}`);
  const worst = Math.max(...pts.map((p, i) => dist(p, evalCubic(fitted[0], i / 39))));
  eq(worst < 0.2, true, `отклонение ${worst.toFixed(3)} мало`);
});

test('fitCurves делит кривую, когда одной мало', () => {
  const pts = Array.from({ length: 60 }, (_, i) => {
    const t = (i / 59) * Math.PI * 1.8;
    return { x: Math.cos(t) * 30, y: Math.sin(t) * 30 };
  });
  const fitted = fitCurves(pts, endTangent(pts, 0, 1), endTangent(pts, pts.length - 1, -1), 0.1);
  eq(fitted.length > 1, true, `делится, вышло ${fitted.length}`);
});

// ─── изолинии ───────────────────────────────────────────────────────────────

test('isolines находит одну петлю у диска', () => {
  eq(isolines(disk(64, 32, 32, 20), 0.5).length, 1);
});

test('изолиния диска попадает в радиус с субпиксельной точностью', () => {
  const loop = isolines(disk(64, 32, 32, 20), 0.5)[0];
  const rs = loop.map((p) => Math.hypot(p.x + 0.5 - 32, p.y + 0.5 - 32));
  const worst = Math.max(...rs.map((r) => Math.abs(r - 20)));
  eq(worst < 0.35, true, `худшее отклонение радиуса ${worst.toFixed(3)} px`);
});

test('isolines находит две петли у кольца', () => {
  eq(isolines(disk(64, 32, 32, 22, 11), 0.5).length, 2);
});

test('isolines замыкает контур, упирающийся в край кропа', () => {
  const m = createMask(20, 20);
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 10; x += 1) m.data[y * 20 + x] = 1;
  const loops = isolines(m, 0.5);
  eq(loops.length, 1, `одна петля, получено ${loops.length}`);
  eq(loops[0].length > 20, true, 'петля обходит фигуру целиком');
});

// ─── углы ───────────────────────────────────────────────────────────────────

test('detectCorners находит ровно четыре угла у квадрата', () => {
  const poly = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 },
    { x: 20, y: 20 }, { x: 10, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 10 }];
  eq(detectCorners(poly, 68).length, 4);
});

test('detectCorners молчит на окружности', () => {
  const n = 48;
  const poly = Array.from({ length: n }, (_, i) => ({
    x: Math.cos((i / n) * 2 * Math.PI) * 20, y: Math.sin((i / n) * 2 * Math.PI) * 20,
  }));
  eq(detectCorners(poly, 68).length, 0);
});

// ─── трассировка целиком ────────────────────────────────────────────────────

test('диск трассируется в один контур верной площади', () => {
  const shape = traceMask(disk(64, 32, 32, 20), 1);
  eq(shape.contours.length, 1);
  const a = contourArea(shape.contours[0]);
  const want = Math.PI * 400;
  eq(Math.abs(a - want) / want < 0.02, true, `площадь ${a.toFixed(1)} против ${want.toFixed(1)}`);
});

test('внешний контур обходится по часовой (площадь положительна)', () => {
  const shape = traceMask(disk(64, 32, 32, 20), 1);
  eq(contourArea(shape.contours[0]) > 0, true);
});

test('дырка кольца обходится против часовой', () => {
  const shape = traceMask(disk(80, 40, 40, 26, 13), 1);
  eq(shape.contours.length, 2);
  const areas = shape.contours.map(contourArea).sort((a, b) => b - a);
  eq(areas[0] > 0 && areas[1] < 0, true, `площади ${areas.map((v) => v.toFixed(0))}`);
  const total = areas[0] + areas[1];
  const want = Math.PI * (26 * 26 - 13 * 13);
  eq(Math.abs(total - want) / want < 0.03, true, `площадь кольца ${total.toFixed(0)} против ${want.toFixed(0)}`);
});

test('гладкий диск описывается четырьмя узлами по крайним точкам', () => {
  // Допуск задан явно: число узлов — свойство допуска, а не диска.
  const shape = traceMask(disk(64, 32, 32, 20), 1, { simplify: 0.55, fitError: 0.8 });
  const n = countNodes(shape);
  eq(n, 4, `узлов ${n}`);
});

test('узлы диска разложены по кругу, а не сбиты в кучу', () => {
  // Точного попадания в крайнюю точку требовать нельзя: возле экстремума дуга
  // плоская, и упрощение законно выбрасывает саму вершину, отходя по дуге.
  // Утверждается то, что важно на деле — узлы разнесены примерно поровну.
  const c = traceMask(disk(64, 32, 32, 20), 1).contours[0];
  const ang = c.nodes.map((nd) => Math.atan2(nd.p.y - 31.5, nd.p.x - 31.5))
    .sort((a, b) => a - b);
  const gaps = ang.map((a, i) => {
    const d = (ang[(i + 1) % ang.length] - a + 2 * Math.PI) % (2 * Math.PI);
    return (d * 180) / Math.PI;
  });
  eq(Math.min(...gaps) > 55 && Math.max(...gaps) < 125, true,
    `промежутки ${gaps.map((g) => g.toFixed(0)).join(', ')}°`);
});

test('гладкий узел действительно гладкий: рычаги на одной прямой', () => {
  const c = traceMask(disk(64, 32, 32, 20), 1).contours[0];
  let worst = 0;
  for (const nd of c.nodes) {
    if (nd.type !== 'smooth' || !nd.in || !nd.out) continue;
    const a = { x: nd.p.x - nd.in.x, y: nd.p.y - nd.in.y };
    const b = { x: nd.out.x - nd.p.x, y: nd.out.y - nd.p.y };
    const cross = Math.abs(a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
    worst = Math.max(worst, cross);
  }
  eq(worst < 0.02, true, `худшее отклонение от прямой ${worst.toFixed(4)}`);
});

test('у диска нет угловых узлов', () => {
  const shape = traceMask(disk(64, 32, 32, 20), 1);
  eq(shape.contours[0].nodes.every((nd) => nd.type === 'smooth'), true);
});

test('у квадрата ровно четыре угловых узла', () => {
  const shape = traceMask(square(60, 15, 45), 1);
  const corners = shape.contours[0].nodes.filter((nd) => nd.type === 'corner').length;
  eq(corners, 4, `угловых узлов ${corners}`);
});

test('увеличение делится обратно и наружу не протекает', () => {
  const k = 4;
  const big = createMask(64 * k, 64 * k);
  const src = disk(64, 32, 32, 20);
  // грубое размножение пикселей — важен только масштаб координат на выходе
  for (let y = 0; y < 64 * k; y += 1) {
    for (let x = 0; x < 64 * k; x += 1) {
      big.data[y * 64 * k + x] = src.data[Math.floor(y / k) * 64 + Math.floor(x / k)];
    }
  }
  const a = contourArea(traceMask(big, k).contours[0]);
  eq(Math.abs(a - Math.PI * 400) / (Math.PI * 400) < 0.03, true,
    `площадь в crop-пространстве ${a.toFixed(1)}`);
});

test('крапина в один пиксель отбрасывается как мусор', () => {
  const m = disk(64, 32, 32, 20);
  m.data[2 * 64 + 2] = 1;
  eq(traceMask(m, 1).contours.length, 1);
});

test('порог мусора считается в пикселях исходника, а не увеличенной маски', () => {
  // Одно и то же пятно при разном увеличении должно решаться одинаково.
  const spot = (size, k) => {
    const m = createMask(size, size);
    for (let y = 10; y < 10 + 3 * k; y += 1) {
      for (let x = 10; x < 10 + 3 * k; x += 1) m.data[y * size + x] = 1;
    }
    return traceMask(m, k, { minArea: 4 }).contours.length;      // пятно 3×3 = 9 px² > 4
  };
  eq(spot(64, 1), 1, 'при увеличении ×1 пятно 3×3 остаётся');
  eq(spot(256, 4), 1, 'при увеличении ×4 оно же остаётся');
  const small = (k) => {
    const size = 64 * k;
    const m = createMask(size, size);
    for (let y = 10; y < 10 + k; y += 1) for (let x = 10; x < 10 + k; x += 1) m.data[y * size + x] = 1;
    return traceMask(m, k, { minArea: 4 }).contours.length;      // пятно 1×1 = 1 px² < 4
  };
  eq(small(1), 0, 'пятно 1×1 выброшено при ×1');
  eq(small(4), 0, 'пятно 1×1 выброшено и при ×4');
});

// ─── обход и вывод ──────────────────────────────────────────────────────────

test('reverseContour меняет знак площади и возвращает на место', () => {
  const c = traceMask(disk(64, 32, 32, 20), 1).contours[0];
  const r = reverseContour(c);
  eq(Math.abs(contourArea(r) + contourArea(c)) < 1e-6, true, 'знак сменился');
  eq(Math.abs(contourArea(reverseContour(r)) - contourArea(c)) < 1e-6, true, 'двойной разворот — тождество');
});

test('signedArea считает квадрат по часовой положительным', () => {
  eq(signedArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 100);
});

test('toPathData даёт замкнутый путь из кубик', () => {
  const d = toPathData(traceMask(disk(64, 32, 32, 20), 1));
  eq(d.startsWith('M'), true);
  eq(d.endsWith('Z'), true);
  eq(/[^MCZ0-9.\-\s]/.test(d), false, 'только M, C, Z и числа');
});

test('flatten обходит замкнутый контур целиком', () => {
  const c = traceMask(disk(64, 32, 32, 20), 1).contours[0];
  eq(flatten(c, 8).length, c.nodes.length * 8);
});

// ─── устойчивость подгонки ──────────────────────────────────────────────────

test('рычаги не улетают, когда касательные почти параллельны', () => {
  // Почти прямой отрезок с еле заметным изгибом: наименьшие квадраты здесь
  // вырождаются, и без ограничения рычаг уходил на сотни пикселей.
  const pts = Array.from({ length: 30 }, (_, i) => ({ x: i, y: Math.sin(i / 29 * Math.PI) * 0.02 }));
  const f = fitCurves(pts, { x: 1, y: 0 }, { x: -1, y: 0 }, 0.001);
  const chord = 29;
  for (const b of f) {
    for (const p of b) {
      eq(Math.abs(p.x) < chord * 4 && Math.abs(p.y) < chord * 4, true,
        `контрольная точка ${p.x.toFixed(1)},${p.y.toFixed(1)} осталась рядом с дугой`);
    }
  }
});

test('контуры настоящей иконки не выходят за пределы кропа', () => {
  // Габарит любого контура обязан помещаться в маску: вылет означает улетевший
  // рычаг, а не найденную фигуру.
  const m = square(60, 15, 45);
  m.data[20 * 60 + 44] = 0;   // выщербина, дающая почти параллельные касательные
  m.data[21 * 60 + 44] = 0;
  const shape = traceMask(m, 1);
  for (const c of shape.contours) {
    for (const p of flatten(c, 8)) {
      eq(p.x >= -2 && p.x <= 62 && p.y >= -2 && p.y <= 62, true,
        `точка ${p.x.toFixed(1)},${p.y.toFixed(1)} внутри маски`);
    }
  }
});

test('углы находятся независимо от настройки упрощения', () => {
  // Маршевые квадраты срезают прямой угол фаской в полпикселя. Раньше её
  // случайно съедало упрощение, и при тонком допуске углы пропадали.
  for (const simplify of [0.1, 0.18, 0.3, 0.55]) {
    const shape = traceMask(square(60, 15, 45), 1, { simplify });
    const corners = shape.contours[0].nodes.filter((nd) => nd.type === 'corner').length;
    eq(corners, 4, `при упрощении ${simplify} углов ${corners}`);
  }
});

test('фаска не даёт двух углов вместо одного', () => {
  const shape = traceMask(square(60, 15, 45), 1, { simplify: 0.1 });
  eq(shape.contours[0].nodes.length <= 8, true,
    `узлов ${shape.contours[0].nodes.length}: один угол — один узел, а не два`);
});

test('на круге ложных углов не появляется', () => {
  const shape = traceMask(disk(80, 40, 40, 30), 1, { simplify: 0.1 });
  const corners = shape.contours[0].nodes.filter((nd) => nd.type === 'corner').length;
  eq(corners, 0, `угловых узлов ${corners}`);
});

test('два близких угла не схлопываются в один', () => {
  // Подавление немаксимумов должно склеивать только фаску маршевых квадратов,
  // а не соседние настоящие углы. На букве «И» с общим радиусом восемь углов
  // схлопывались в шесть, и подгонка перемахивала через пазухи, заливая их.
  const step = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 3 }, { x: 40, y: 3 },
    { x: 40, y: 30 }, { x: 0, y: 30 }];
  // Окно измерения уже самой ступеньки, иначе поворот на ней законно сгладится.
  eq(detectCorners(step, 68, 2, 1.5).length, 6, 'узкая склейка бережёт оба угла ступеньки');
  eq(detectCorners(step, 68, 2, 8).length < 6, true, 'широкая — съедает');
});

test('рычаг не длиннее полутора хорд', () => {
  const pts = Array.from({ length: 40 }, (_, i) => ({ x: i, y: i < 20 ? 0 : (i - 20) * 0.05 }));
  for (const b of fitCurves(pts, endTangent(pts, 0, 1), endTangent(pts, pts.length - 1, -1), 0.01)) {
    const chord = dist(b[0], b[3]);
    eq(dist(b[0], b[1]) <= chord * 1.45 && dist(b[3], b[2]) <= chord * 1.45, true,
      `рычаги ${dist(b[0], b[1]).toFixed(1)} и ${dist(b[3], b[2]).toFixed(1)} при хорде ${chord.toFixed(1)}`);
  }
});

test('угол ставится в настоящую вершину, а не на ступеньку растра', () => {
  // Квадрат, повёрнутый так, что сетка режет его углы наискось: без правки
  // узел садился на срез и угол выходил «рубленым» на пиксель.
  const size = 80;
  const m = createMask(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - 40;
      const dy = y + 0.5 - 40;
      const u = (dx + dy) / Math.SQRT2;
      const v = (dx - dy) / Math.SQRT2;
      m.data[y * size + x] = Math.abs(u) < 20 && Math.abs(v) < 20 ? 1 : 0;
    }
  }
  const shape = traceMask(m, 1, { simplify: 0.3, fitError: 0.4 });
  const corners = shape.contours[0].nodes.filter((nd) => nd.type === 'corner');
  eq(corners.length, 4, `углов ${corners.length}`);
  // У повёрнутого на 45° квадрата вершины лежат на осях, в 28.3 от центра.
  const worst = Math.max(...corners.map((nd) => {
    const d = Math.hypot(nd.p.x - 40, nd.p.y - 40);
    return Math.abs(d - 20 * Math.SQRT2);
  }));
  eq(worst < 1.2, true, `вершины на месте, худшее отклонение ${worst.toFixed(2)} px`);
});

test('sharpenCorners не двигает узлы там, где угла нет', () => {
  const circle = Array.from({ length: 40 }, (_, i) => ({
    x: Math.cos((i / 40) * 2 * Math.PI) * 20,
    y: Math.sin((i / 40) * 2 * Math.PI) * 20,
  }));
  const out = sharpenCorners(circle, [], 5);
  eq(out === circle, true, 'без углов возвращается тот же массив');
});

test('dechamfer не съедает настоящую короткую сторону', () => {
  // Ступенька в 6 единиц между рёбрами по 10 — это форма, а не фаска сетки.
  const poly = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 20, y: 6 },
    { x: 20, y: 30 }, { x: 0, y: 30 }];
  eq(dechamfer(poly, 3).length, 6, 'фаска короче трёх — эта сторона длиннее');
});

test('traceStroke сводит «трубу» к одной осевой линии', () => {
  const W = 64;
  const m = createMask(W, W);
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const outer = x >= 10 && x <= 50 && y >= 20 && y <= 50;
      const inner = x >= 13 && x <= 47 && y >= 23 && y <= 47;
      m.data[y * W + x] = outer && !inner ? 1 : 0;
    }
  }
  const filled = traceMask(m, 1);
  const stroke = traceStroke(m, 1);
  eq(filled.contours.length, 2, 'заливкой рамка даёт две границы — «трубу»');
  eq(stroke.contours.length, 1, `штрихом — одну линию, получено ${stroke.contours.length}`);
  eq(stroke.contours[0].closed, true, 'рамка замкнута');
  eq(stroke.contours[0].width, 3, `толщина стенки, получено ${stroke.contours[0].width}`);
  const nodes = stroke.contours[0].nodes.length;
  eq(nodes < filled.contours.reduce((a, c) => a + c.nodes.length, 0), true,
    `узлов меньше, чем у двух границ: ${nodes}`);
});

test('traceStroke даёт разомкнутый контур с концами без рычагов', () => {
  const m = createMask(40, 16);
  for (let y = 6; y < 9; y += 1) for (let x = 4; x < 36; x += 1) m.data[y * 40 + x] = 1;
  const sh = traceStroke(m, 1);
  eq(sh.contours.length, 1, `одна линия, получено ${sh.contours.length}`);
  const c = sh.contours[0];
  eq(c.closed, false, 'полоса не замкнута');
  eq(c.nodes[0].in, null, 'у первого узла нет входящего рычага');
  eq(c.nodes[c.nodes.length - 1].out, null, 'у последнего нет исходящего');
});

test('у traceStroke выход в crop-пространстве, как и у traceMask', () => {
  const m = createMask(48, 24);
  for (let y = 9; y < 15; y += 1) for (let x = 6; x < 42; x += 1) m.data[y * 48 + x] = 1;
  const sh = traceStroke(m, 2);
  const xs = sh.contours[0].nodes.map((n) => n.p.x);
  eq(Math.max(...xs) <= 24, true, `x не выходит за кроп 24, получено ${Math.max(...xs)}`);
});
