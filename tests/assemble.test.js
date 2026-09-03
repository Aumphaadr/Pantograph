import { linePiece, arcPiece, segmentChain, samplePiece, piecesToPathData } from '../js/assemble/pieces.js';
import { assemble, recognizeClosed, stitchThrough, assemblyContours, assemblyToShape, piecesOf } from '../js/assemble/assemble.js';
import { countNodes, flatten } from '../js/core/path.js';
import { createMask } from '../js/prep/mask.js';
import { rasterizeShape, countComponents } from '../js/trace/rasterize.js';
import { toAssemblySvg } from '../js/export/svg.js';

const TAU = Math.PI * 2;
const near = (a, b, eps, what) => eq(Math.abs(a - b) <= eps, true, `${what}: ${a} против ${b}`);

/** Плотные точки: отрезок, четверть окружности, отрезок — буква «D» без спинки. */
function lineArcLine() {
  const pts = [];
  for (let x = 0; x <= 60; x += 1) pts.push({ x, y: 0 });
  for (let k = 1; k <= 30; k += 1) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (k / 30);
    pts.push({ x: 60 + 20 * Math.cos(a), y: 20 + 20 * Math.sin(a) });
  }
  for (let y = 21; y <= 80; y += 1) pts.push({ x: 80, y });
  return pts;
}

test('отрезок и дуга узнаются по плотным точкам', () => {
  const pts = lineArcLine();
  eq(linePiece(pts, 0, 60).err < 1e-9, true, 'прямая без ошибки');
  const arc = arcPiece(pts, 60, 90);
  eq(Boolean(arc), true, 'дуга найдена');
  near(arc.r, 20, 0.05, 'радиус');
  near(Math.abs(arc.sweep), Math.PI / 2, 0.02, 'четверть');
  eq(arcPiece(pts, 0, 60) === null || arcPiece(pts, 0, 60).r > 1e4, true, 'прямая — не дуга');
});

test('разбор цепочки: отрезок, дуга, отрезок', () => {
  const pieces = segmentChain(lineArcLine(), 0.5);
  eq(pieces.map((p) => p.kind).join(','), 'line,arc,line');
  near(pieces[1].r, 20, 0.2, 'радиус дуги');
  eq(pieces[0].b, pieces[1].a, 'куски делят концы');
  near(pieces[1].a.x, 60, 3, 'дуга начинается у конца прямой');
  near(pieces[1].b.y, 20, 3, 'дуга кончается у начала второй прямой');
  const d = piecesToPathData(pieces);
  eq(d.startsWith('M0 0L') && d.includes('A20 20 0 0 1') && d.endsWith('L80 80'), true, d);
});

test('S-образная кривая не проходит за одну дугу', () => {
  const pts = [];
  for (let k = 0; k <= 40; k += 1) pts.push({ x: k, y: 10 * Math.sin((k / 40) * TAU) });
  eq(arcPiece(pts, 0, 40), null, 'знакопеременная кривизна — не дуга');
});

test('выборка куска идёт от начала к концу', () => {
  const arc = arcPiece(lineArcLine(), 60, 90);
  const s = samplePiece(arc, 2);
  eq(s[0], arc.a); eq(s[s.length - 1], arc.b);
});

test('узнавание кольца: круг, прямоугольник, скруглённый, капсула', () => {
  const W = 2;   // толщина штриха: стороны длиннее её
  const circ = (c, r, a0, sweep) => ({ kind: 'arc', c, r, a0, sweep,
    a: { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) },
    b: { x: c.x + r * Math.cos(a0 + sweep), y: c.y + r * Math.sin(a0 + sweep) } });
  const c = { x: 50, y: 50 };
  eq(recognizeClosed([circ(c, 30, 0, Math.PI), circ(c, 30, Math.PI, Math.PI)], 0.5, W).kind, 'circle');
  const L = (a, b) => ({ kind: 'line', a, b });
  const rect = recognizeClosed([L({ x: 0, y: 0 }, { x: 40, y: 0 }), L({ x: 40, y: 0 }, { x: 40, y: 20 }),
    L({ x: 40, y: 20 }, { x: 0, y: 20 }), L({ x: 0, y: 20 }, { x: 0, y: 0 })], 0.5, W);
  eq(rect.kind, 'rect'); near(rect.w, 40, 1e-9, 'ширина'); near(rect.h, 20, 1e-9, 'высота');
  // Скруглённый: отрезки и четверти радиуса 5 по часовой (Y вниз).
  const r = 5;
  const pieces = [
    L({ x: 5, y: 0 }, { x: 35, y: 0 }), circ({ x: 35, y: 5 }, r, -Math.PI / 2, Math.PI / 2),
    L({ x: 40, y: 5 }, { x: 40, y: 15 }), circ({ x: 35, y: 15 }, r, 0, Math.PI / 2),
    L({ x: 35, y: 20 }, { x: 5, y: 20 }), circ({ x: 5, y: 15 }, r, Math.PI / 2, Math.PI / 2),
    L({ x: 0, y: 15 }, { x: 0, y: 5 }), circ({ x: 5, y: 5 }, r, Math.PI, Math.PI / 2),
  ];
  const rr = recognizeClosed(pieces, 0.5, W);
  eq(rr.kind, 'roundRect'); near(rr.r, 5, 1e-9, 'радиус'); near(rr.w, 40, 1e-9, 'ширина'); near(rr.angle, 0, 1e-9, 'угол');
  const cap = recognizeClosed([L({ x: 10, y: 0 }, { x: 40, y: 0 }), circ({ x: 40, y: 10 }, 10, -Math.PI / 2, Math.PI),
    L({ x: 40, y: 20 }, { x: 10, y: 20 }), circ({ x: 10, y: 10 }, 10, Math.PI / 2, Math.PI)], 0.5, W);
  eq(cap.kind, 'roundRect'); near(cap.h, 20, 1e-9, 'капсула: высота — диаметр');
});

test('повёрнутый прямоугольник узнаётся с углом', () => {
  const ang = 0.3;
  const R = (x, y) => ({ x: 50 + x * Math.cos(ang) - y * Math.sin(ang), y: 50 + x * Math.sin(ang) + y * Math.cos(ang) });
  const L = (a, b) => ({ kind: 'line', a, b });
  const pts = [R(-20, -10), R(20, -10), R(20, 10), R(-20, 10)];
  const rect = recognizeClosed([L(pts[0], pts[1]), L(pts[1], pts[2]), L(pts[2], pts[3]), L(pts[3], pts[0])], 0.5, 2);
  eq(rect.kind, 'rect'); near(rect.angle, ang, 1e-6, 'угол'); near(rect.w, 40, 1e-6, 'ширина');
});

test('сшивка сквозь развилку: перекладина «Т» не рвётся, стойка — ветвь', () => {
  const bar1 = { points: [{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 10 }], width: 4, closed: false };
  const bar2 = { points: [{ x: 20, y: 10 }, { x: 30, y: 10 }, { x: 40, y: 10 }], width: 4, closed: false };
  const stem = { points: [{ x: 20, y: 10 }, { x: 20, y: 20 }, { x: 20, y: 30 }], width: 4, closed: false };
  const out = stitchThrough([bar1, stem, bar2], { radius: 1, depth: 5 });
  eq(out.length, 2, 'две цепочки: перекладина и стойка');
  const bar = out.find((c) => c.points.length === 5);
  eq(Boolean(bar), true, 'перекладина сшита из двух');
});

/** Маска: кольцо-штрих скруглённого прямоугольника и залитый кружок. */
function roundRectMask() {
  const w = 160;
  const h = 120;
  const m = createMask(w, h);
  const inside = (x, y, hw, hh, r) => {
    const qx = Math.abs(x - 80) - (hw - r);
    const qy = Math.abs(y - 60) - (hh - r);
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    return outside + Math.min(Math.max(qx, qy), 0) - r <= 0;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ring = inside(px, py, 60, 40, 16) && !inside(px, py, 52, 32, 8);
      const dot = Math.hypot(px - 80, py - 60) <= 9;
      if (ring || dot) m.data[y * w + x] = 1;
    }
  }
  return m;
}

test('сборка: скруглённый прямоугольник штрихом и точка заливкой', () => {
  const m = roundRectMask();
  const asm = assemble(m, 1, { fitError: 1, minArea: 4 });
  const kinds = asm.parts.map((p) => p.kind).sort().join(',');
  eq(kinds, 'blob,roundRect', `примитивы: ${kinds}`);
  const rr = asm.parts.find((p) => p.kind === 'roundRect');
  near(rr.w, 112, 2, 'ширина по оси штриха');
  near(rr.h, 72, 2, 'высота по оси штриха');
  near(rr.r, 12, 2.5, 'радиус скругления по оси');
  near(asm.width, 8, 1.2, 'толщина штриха');
  eq(asm.fit.drift < 1, true, `увод от маски ${asm.fit.drift}`);
  eq(asm.fit.compBin, asm.fit.compRen, 'куски не потеряны');
  const svg = toAssemblySvg(asm, { width: 160, height: 120 });
  eq(svg.includes('<rect ') && svg.includes('rx=') && svg.includes('<circle '), true, svg);
});

test('растр капсулы — одна связная полоса с круглыми концами', () => {
  const asm = { parts: [{ kind: 'line', width: 8, pieces: [{ kind: 'line', a: { x: 6, y: 10 }, b: { x: 40, y: 10 } }] }] };
  const r = rasterizeShape(assemblyContours(asm, 1), 50, 20, 1);
  eq(countComponents(r, 50, 20), 1);
  let area = 0;
  for (const v of r) area += v;
  near(area, 34 * 8 + Math.PI * 16, 12, 'площадь капсулы');
});

test('срезанные углы мелкой маски читаются как скругление', () => {
  const L = (a, b) => ({ kind: 'line', a, b });
  const pieces = [
    L({ x: 5, y: 0 }, { x: 35, y: 0 }), L({ x: 35, y: 0 }, { x: 40, y: 5 }),
    L({ x: 40, y: 5 }, { x: 40, y: 15 }), L({ x: 40, y: 15 }, { x: 35, y: 20 }),
    L({ x: 35, y: 20 }, { x: 5, y: 20 }), L({ x: 5, y: 20 }, { x: 0, y: 15 }),
    L({ x: 0, y: 15 }, { x: 0, y: 5 }), L({ x: 0, y: 5 }, { x: 5, y: 0 }),
  ];
  const rr = recognizeClosed(pieces, 0.5, 8);
  eq(rr.kind, 'roundRect', `узнано: ${rr && rr.kind}`);
  near(rr.r, 5, 0.01, 'радиус из длины среза');
  near(rr.w, 40, 1e-9, 'ширина по опорным прямым');
});

test('скруглённый треугольник — многоугольник с радиусом, вершины по опорным прямым', () => {
  const L = (a, b) => ({ kind: 'line', a, b });
  const arc = (c, r, a0, sweep) => ({ kind: 'arc', c, r, a0, sweep,
    a: { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) },
    b: { x: c.x + r * Math.cos(a0 + sweep), y: c.y + r * Math.sin(a0 + sweep) } });
  // Треугольник (0,0)-(60,0)-(30,50) со скруглением ~6 у каждой вершины: стороны — укороченные.
  const pieces = [
    L({ x: 8, y: 0 }, { x: 52, y: 0 }), arc({ x: 52, y: 6 }, 6, -Math.PI / 2, 1.9),
    L({ x: 55, y: 8 }, { x: 34, y: 43 }), arc({ x: 30, y: 41 }, 6, 0.5, 2.1),
    L({ x: 26, y: 43 }, { x: 5, y: 8 }), arc({ x: 8, y: 6 }, 6, 2.6, 1.9),
  ];
  const rp = recognizeClosed(pieces, 0.5, 2);
  eq(rp.kind, 'roundPolygon', `узнано: ${rp && rp.kind}`);
  eq(rp.corners.length, 3);
  near(rp.corners[0].x, 60, 1.5, 'вершина — пересечение сторон');
  near(rp.r, 6, 0.5, 'радиус');
  const ps = piecesOf(rp);
  eq(ps.length, 6, 'три дуги и три отрезка');
});

test('сборка становится обычной фигурой: дуги — кубиками, осевые — с толщиной', () => {
  const asm = { width: 4, parts: [
    { kind: 'circle', c: { x: 50, y: 50 }, r: 20 },
    { kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
  ] };
  const shape = assemblyToShape(asm);
  eq(shape.contours.length, 2);
  eq(shape.contours[0].closed, true); eq(shape.contours[0].nodes.length, 4, 'круг — четыре узла');
  const pts = flatten(shape.contours[0], 8);
  for (const p of pts) near(Math.hypot(p.x - 50, p.y - 50), 20, 0.05, 'кубики лежат на окружности');
  eq(shape.contours[1].closed, false); eq(shape.contours[1].width, 4);
  eq(countNodes(shape), 6);
});
