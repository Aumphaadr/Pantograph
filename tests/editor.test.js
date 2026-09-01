import {
  splitCubic, insertNode, removeNodes, moveNodes, moveHandle, setNodeType,
  hitTest, hitCurve, nodesInRect, key,
} from '../js/editor/ops.js';
import { createHistory } from '../js/editor/history.js';
import {
  node, flatten, contourArea, countNodes, nearestOnContour, pointOnSegment, segment,
} from '../js/core/path.js';

const P = (x, y) => ({ x, y });

/** Квадратный контур из четырёх угловых узлов с короткими рычагами. */
const squareShape = () => ({
  contours: [{
    closed: true,
    nodes: [
      node(P(0, 0), P(-2, 0), P(2, 0), 'corner'),
      node(P(10, 0), P(8, 0), P(10, 2), 'corner'),
      node(P(10, 10), P(10, 8), P(8, 10), 'corner'),
      node(P(0, 10), P(2, 10), P(0, 8), 'corner'),
    ],
  }],
});

const smoothShape = () => ({
  contours: [{
    closed: true,
    nodes: [
      node(P(0, 0), P(-3, 0), P(3, 0), 'smooth'),
      node(P(10, 10), P(10, 7), P(10, 13), 'smooth'),
    ],
  }],
});

// ─── де Кастельжо ───────────────────────────────────────────────────────────

test('splitCubic делит кривую, не меняя её', () => {
  const b = [P(0, 0), P(0, 10), P(10, 10), P(10, 0)];
  const [l, r] = splitCubic(b, 0.5);
  eq(l[3], r[0], 'половинки стыкуются');
  const mid = pointOnSegment({ closed: false, nodes: [node(b[0], null, b[1]), node(b[3], b[2], null)] }, 0, 0.5);
  eq(Math.abs(l[3].x - mid.x) < 1e-9 && Math.abs(l[3].y - mid.y) < 1e-9, true, 'точка стыка на кривой');
});

// ─── вставка ────────────────────────────────────────────────────────────────

test('insertNode добавляет узел и не меняет форму', () => {
  const before = squareShape();
  const after = insertNode(before, { ci: 0, si: 0, t: 0.4 });
  eq(countNodes(after), 5);
  eq(Math.abs(contourArea(after.contours[0]) - contourArea(before.contours[0])) < 1e-6, true,
    'площадь та же — форма не поехала');
});

test('insertNode ставит узел ровно на кривую', () => {
  const before = squareShape();
  const want = pointOnSegment(before.contours[0], 1, 0.3);
  const after = insertNode(before, { ci: 0, si: 1, t: 0.3 });
  const got = after.contours[0].nodes[2].p;
  eq(Math.abs(got.x - want.x) < 1e-9 && Math.abs(got.y - want.y) < 1e-9, true,
    `узел в ${got.x},${got.y} против ${want.x},${want.y}`);
});

test('insertNode на концах сегмента ничего не делает', () => {
  const before = squareShape();
  eq(insertNode(before, { ci: 0, si: 0, t: 0 }) === before, true);
  eq(insertNode(before, { ci: 0, si: 0, t: 1 }) === before, true);
});

test('вставка вставляет узел в правильное место цепочки', () => {
  const after = insertNode(squareShape(), { ci: 0, si: 2, t: 0.5 });
  eq(after.contours[0].nodes.map((n) => `${n.p.x},${n.p.y}`).length, 5);
  eq(after.contours[0].nodes[3].p.x > 0 && after.contours[0].nodes[3].p.x < 10, true,
    'новый узел между третьим и четвёртым');
});

// ─── удаление ───────────────────────────────────────────────────────────────

test('removeNodes убирает выбранные', () => {
  const after = removeNodes(squareShape(), [key(0, 1)]);
  eq(countNodes(after), 3);
});

test('контур из одного узла исчезает целиком', () => {
  const after = removeNodes(squareShape(), [key(0, 0), key(0, 1), key(0, 2)]);
  eq(after.contours.length, 0, 'меньше двух узлов — контура нет');
});

test('removeNodes не трогает соседние контуры', () => {
  const two = { contours: [...squareShape().contours, ...smoothShape().contours] };
  const after = removeNodes(two, [key(0, 0)]);
  eq(after.contours.length, 2);
  eq(after.contours[1].nodes.length, 2, 'второй контур цел');
});

// ─── перемещение ────────────────────────────────────────────────────────────

test('moveNodes двигает точку вместе с рычагами', () => {
  const after = moveNodes(squareShape(), [key(0, 0)], 5, 3);
  const nd = after.contours[0].nodes[0];
  eq([nd.p.x, nd.p.y], [5, 3]);
  eq([nd.in.x, nd.in.y], [3, 3], 'входящий рычаг уехал следом');
  eq([nd.out.x, nd.out.y], [7, 3], 'исходящий тоже');
});

test('привязка ловит точку на сетку, а рычаги едут за ней', () => {
  const after = moveNodes(squareShape(), [key(0, 0)], 5.3, 2.8, 0.5);
  const nd = after.contours[0].nodes[0];
  eq([nd.p.x, nd.p.y], [5.5, 3], 'точка на сетке');
  eq([nd.out.x - nd.p.x, nd.out.y - nd.p.y], [2, 0], 'рычаг сохранил вылет');
});

test('moveNodes не трогает невыделенные', () => {
  const after = moveNodes(squareShape(), [key(0, 0)], 5, 5);
  eq([after.contours[0].nodes[1].p.x, after.contours[0].nodes[1].p.y], [10, 0]);
});

// ─── рычаги ─────────────────────────────────────────────────────────────────

test('у гладкого узла противоположный рычаг разворачивается следом', () => {
  const after = moveHandle(smoothShape(), { ci: 0, ni: 0, which: 'out' }, P(0, 5));
  const nd = after.contours[0].nodes[0];
  eq([nd.out.x, nd.out.y], [0, 5]);
  eq([nd.in.x, Math.round(nd.in.y)], [0, -3], 'входящий встал напротив, сохранив длину 3');
  eq(nd.type, 'smooth');
});

test('Alt разрывает симметрию и делает узел угловым', () => {
  const after = moveHandle(smoothShape(), { ci: 0, ni: 0, which: 'out' }, P(0, 5), { break: true });
  const nd = after.contours[0].nodes[0];
  eq([nd.out.x, nd.out.y], [0, 5]);
  eq([nd.in.x, nd.in.y], [-3, 0], 'входящий остался на месте');
  eq(nd.type, 'corner');
});

test('у углового узла рычаги независимы', () => {
  const after = moveHandle(squareShape(), { ci: 0, ni: 0, which: 'out' }, P(2, 5));
  eq([after.contours[0].nodes[0].in.x, after.contours[0].nodes[0].in.y], [-2, 0]);
});

// ─── тип узла ───────────────────────────────────────────────────────────────

test('превращение в гладкий выпрямляет рычаги по хорде соседей', () => {
  const after = setNodeType(squareShape(), { ci: 0, ni: 1 }, 'smooth');
  const nd = after.contours[0].nodes[1];
  eq(nd.type, 'smooth');
  const a = { x: nd.p.x - nd.in.x, y: nd.p.y - nd.in.y };
  const b = { x: nd.out.x - nd.p.x, y: nd.out.y - nd.p.y };
  const cross = Math.abs(a.x * b.y - a.y * b.x) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
  eq(cross < 1e-9, true, `рычаги на одной прямой, отклонение ${cross}`);
});

test('превращение в угловой только меняет тип', () => {
  const before = smoothShape();
  const after = setNodeType(before, { ci: 0, ni: 0 }, 'corner');
  eq(after.contours[0].nodes[0].type, 'corner');
  eq(after.contours[0].nodes[0].out, before.contours[0].nodes[0].out, 'рычаги не тронуты');
});

// ─── попадание курсором ─────────────────────────────────────────────────────

test('hitTest находит узел', () => {
  eq(hitTest(squareShape(), P(10.3, 0.2), 1), { kind: 'node', ci: 0, ni: 1 });
});

test('рычаги ловятся только у выделенных узлов', () => {
  const sh = smoothShape();
  eq(hitTest(sh, P(3, 0), 0.6), null, 'у невыделенного узла рычаг не мешает');
  const got = hitTest(sh, P(3, 0), 0.6, { selection: new Set([key(0, 0)]) });
  eq(got, { kind: 'handle', ci: 0, ni: 0, which: 'out' });
});

test('hitCurve ловит кривую между узлами', () => {
  const got = hitCurve(squareShape(), P(5, 0), 1, nearestOnContour);
  eq(got.kind, 'curve');
  eq(got.si, 0);
  eq(got.t > 0.2 && got.t < 0.8, true, `параметр ${got.t.toFixed(2)} в середине`);
});

test('hitCurve молчит вдали от контура', () => {
  eq(hitCurve(squareShape(), P(5, 5), 1, nearestOnContour), null);
});

test('nodesInRect берёт узлы внутри рамки', () => {
  eq(nodesInRect(squareShape(), { x: -1, y: -1, w: 12, h: 2 }).sort(), [key(0, 0), key(0, 1)]);
});

// ─── история ────────────────────────────────────────────────────────────────

test('история отменяет и повторяет', () => {
  const h = createHistory();
  h.reset('a'); h.push('b'); h.push('c');
  eq(h.undo(), 'b');
  eq(h.undo(), 'a');
  eq(h.undo(), null, 'дальше начала не уходим');
  eq(h.redo(), 'b');
  eq(h.redo(), 'c');
  eq(h.redo(), null);
});

test('новая правка обрезает ветку повтора', () => {
  const h = createHistory();
  h.reset('a'); h.push('b'); h.undo(); h.push('c');
  eq(h.canRedo, false);
  eq(h.current, 'c');
});

test('транзакция схлопывает перетаскивание в один шаг', () => {
  const h = createHistory();
  h.reset('a');
  h.begin();
  h.push('шаг1'); h.push('шаг2'); h.push('шаг3');
  h.end('шаг3');
  eq(h.depth, 2, 'два состояния: начальное и итог');
  eq(h.undo(), 'a');
});

test('пустая транзакция шага не создаёт', () => {
  const h = createHistory();
  h.reset('a');
  h.begin();
  h.end('a');
  eq(h.depth, 1);
});

test('история не растёт без предела', () => {
  const h = createHistory(5);
  h.reset(0);
  for (let i = 1; i <= 20; i += 1) h.push(i);
  eq(h.depth, 5);
  eq(h.current, 20);
});
