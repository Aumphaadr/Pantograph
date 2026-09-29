import { createMask } from '../js/prep/mask.js';
import { outlineArcs } from '../js/assemble/outline.js';
import { segment, segmentCount, signedArea } from '../js/core/path.js';
import { rasterizeShape } from '../js/trace/rasterize.js';

const W = 200;
const H = 160;
const roundRect = (m, x0, y0, w, h, r) => {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const cx = Math.min(Math.max(x + 0.5, x0 + r), x0 + w - r);
      const cy = Math.min(Math.max(y + 0.5, y0 + r), y0 + h - r);
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m.data[y * W + x] = 1;
    }
  }
  return m;
};
const disc = (m, cx, cy, r, v) => {
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m.data[y * W + x] = v;
  return m;
};
/** Куски контура: прямые (рычаги в концах) и кривые. */
const kinds = (c) => {
  const out = [];
  for (let i = 0; i < segmentCount(c); i += 1) {
    const [p0, p1, p2, p3] = segment(c, i);
    const straight = Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-6 && Math.hypot(p2.x - p3.x, p2.y - p3.y) < 1e-6;
    out.push(straight ? { line: true, a: p0, b: p3 } : { line: false });
  }
  return out;
};

test('скруглённый прямоугольник — четыре прямые и четыре дуги, прямые строго по осям', () => {
  const m = roundRect(createMask(W, H), 30, 30, 140, 100, 16);
  const shape = outlineArcs(m);
  eq(shape.contours.length, 1, 'один контур');
  const k = kinds(shape.contours[0]);
  const lines = k.filter((s) => s.line);
  eq(lines.length, 4, `прямых ${lines.length} из ${k.length} кусков`);
  eq(k.length, 8, 'и четыре дуги');
  for (const s of lines) {
    const dx = Math.abs(s.a.x - s.b.x), dy = Math.abs(s.a.y - s.b.y);
    if (Math.min(dx, dy) > 0.6) throw new Error(`прямая наискось: ${JSON.stringify(s)}`);
  }
});

test('кольцо — только дуги, дыра обходится навстречу внешнему контуру', () => {
  const m = disc(createMask(W, H), 100, 80, 50, 1);
  disc(m, 100, 80, 30, 0);
  const shape = outlineArcs(m);
  eq(shape.contours.length, 2, 'два контура');
  for (const c of shape.contours) eq(kinds(c).every((s) => !s.line), true, 'ни одной прямой у круга');
  const [a, b] = shape.contours.map((c) => Math.sign(signedArea(c.nodes.map((n) => n.p))));
  eq(a === -b, true, 'обходы противоположны');
});

test('отсчёт — центр пикселя: кромка полосы на границе пикселей', () => {
  const m = roundRect(createMask(W, H), 40, 40, 120, 60, 0.001);
  const shape = outlineArcs(m);
  const xs = shape.contours[0].nodes.map((n) => n.p.x);
  const near = (v, want) => Math.abs(v - want) <= 0.05;
  eq(near(Math.min(...xs), 40), true, `левая кромка на x = 40, получено ${Math.min(...xs)}`);
  eq(near(Math.max(...xs), 160), true, `правая кромка на x = 160, получено ${Math.max(...xs)}`);
  eq(shape.contours[0].nodes.length, 4, 'острый прямоугольник — четыре угла, без фасок');
});

test('контур не теряет и не добавляет краски: площадь как у маски', () => {
  // Дуга, обошедшая лишний оборот, заливала полкартинки (phrase-library SignoreBot).
  const shapes = [
    (m) => disc(m, 100, 80, 37, 1),
    (m) => { disc(m, 70, 60, 23, 1); disc(m, 140, 100, 31, 1); return m; },
    (m) => { disc(m, 100, 80, 60, 1); disc(m, 112, 74, 21, 0); return m; },
    (m) => roundRect(m, 20, 60, 160, 40, 20),
    (m) => { roundRect(m, 30, 30, 140, 100, 12); roundRect(m, 45, 45, 110, 70, 4); for (let y = 48; y < 112; y += 1) for (let x = 48; x < 152; x += 1) m.data[y * W + x] = 0; return m; },
  ];
  shapes.forEach((make, k) => {
    const m = make(createMask(W, H));
    const got = rasterizeShape(outlineArcs(m), W, H, 1, 16);
    let a = 0, b = 0;
    for (let i = 0; i < m.data.length; i += 1) { a += m.data[i] > 0.5 ? 1 : 0; b += got[i]; }
    if (Math.abs(b - a) / a > 0.015) throw new Error(`фигура ${k}: площадь контура ${b} против ${a} у маски`);
  });
});
