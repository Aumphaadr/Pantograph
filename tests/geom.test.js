import {
  normRect, roundRect, clipRect, clampRectInside, moveRect,
  resizeRect, handlePoints, hitHandle, pointInRect, fitScale,
} from '../js/core/geom.js';

const B = { w: 100, h: 80 };

test('normRect выпрямляет углы в любом порядке', () => {
  const want = { x: 10, y: 20, w: 30, h: 5 };
  eq(normRect({ x: 10, y: 20 }, { x: 40, y: 25 }), want);
  eq(normRect({ x: 40, y: 25 }, { x: 10, y: 20 }), want, 'обратный порядок');
});

test('roundRect округляет границы, а не размер', () => {
  // Наивное округление размера дало бы w=3 и кроп бы «плыл» при перетаскивании.
  eq(roundRect({ x: 10.6, y: 0, w: 2.6, h: 1 }), { x: 11, y: 0, w: 2, h: 1 });
  eq(roundRect({ x: 10.4, y: 0, w: 2.6, h: 1 }), { x: 10, y: 0, w: 3, h: 1 });
});

test('clipRect режет края по границам', () => {
  eq(clipRect({ x: -10, y: -5, w: 30, h: 20 }, B), { x: 0, y: 0, w: 20, h: 15 });
  eq(clipRect({ x: 90, y: 70, w: 30, h: 30 }, B), { x: 90, y: 70, w: 10, h: 10 });
});

test('clampRectInside двигает прямоугольник целиком', () => {
  eq(clampRectInside({ x: -10, y: -5, w: 30, h: 20 }, B), { x: 0, y: 0, w: 30, h: 20 });
  eq(clampRectInside({ x: 95, y: 75, w: 30, h: 20 }, B), { x: 70, y: 60, w: 30, h: 20 });
});

test('clampRectInside ужимает то, что больше картинки', () => {
  eq(clampRectInside({ x: -5, y: -5, w: 200, h: 200 }, B), { x: 0, y: 0, w: 100, h: 80 });
});

test('moveRect не выпускает кроп за край', () => {
  eq(moveRect({ x: 80, y: 60, w: 20, h: 20 }, 50, 50, B), { x: 80, y: 60, w: 20, h: 20 });
  eq(moveRect({ x: 10, y: 10, w: 20, h: 20 }, -50, 0, B), { x: 0, y: 10, w: 20, h: 20 });
});

test('resizeRect тянет нужный угол', () => {
  const r = { x: 20, y: 20, w: 40, h: 40 };
  eq(resizeRect(r, 'nw', { x: 10, y: 15 }, B), { x: 10, y: 15, w: 50, h: 45 });
  eq(resizeRect(r, 'se', { x: 70, y: 70 }, B), { x: 20, y: 20, w: 50, h: 50 });
});

test('resizeRect двигает только свою ось у боковых ручек', () => {
  const r = { x: 20, y: 20, w: 40, h: 40 };
  eq(resizeRect(r, 'e', { x: 90, y: 5 }, B), { x: 20, y: 20, w: 70, h: 40 });
  eq(resizeRect(r, 'n', { x: 0, y: 10 }, B), { x: 20, y: 10, w: 40, h: 50 });
});

test('resizeRect переживает выворот через противоположный край', () => {
  const r = { x: 20, y: 20, w: 40, h: 40 };
  eq(resizeRect(r, 'w', { x: 75, y: 0 }, B), { x: 60, y: 20, w: 15, h: 40 });
});

test('resizeRect не вылезает за картинку', () => {
  const r = { x: 20, y: 20, w: 40, h: 40 };
  eq(resizeRect(r, 'se', { x: 500, y: 500 }, B), { x: 20, y: 20, w: 80, h: 60 });
});

test('handlePoints ставит восемь точек по краям', () => {
  const p = handlePoints({ x: 0, y: 0, w: 10, h: 20 });
  eq(p.nw, { x: 0, y: 0 });
  eq(p.se, { x: 10, y: 20 });
  eq(p.n, { x: 5, y: 0 });
  eq(p.w, { x: 0, y: 10 });
});

test('hitHandle берёт ближайшую и молчит за допуском', () => {
  const r = { x: 0, y: 0, w: 40, h: 40 };
  eq(hitHandle(r, { x: 1, y: 1 }, 3), 'nw');
  eq(hitHandle(r, { x: 39, y: 39 }, 3), 'se');
  eq(hitHandle(r, { x: 20, y: 20 }, 3), null, 'центр — не ручка');
});

test('pointInRect считает границу своей', () => {
  const r = { x: 10, y: 10, w: 10, h: 10 };
  eq(pointInRect(r, { x: 10, y: 10 }), true);
  eq(pointInRect(r, { x: 20, y: 20 }), true);
  eq(pointInRect(r, { x: 21, y: 15 }), false);
});

test('fitScale вписывает по узкой стороне', () => {
  eq(fitScale({ w: 200, h: 100 }, { w: 264, h: 300 }, 32), 1);
  eq(fitScale({ w: 400, h: 100 }, { w: 264, h: 300 }, 32), 0.5);
});

test('fitScale не делится на ноль на пустой картинке', () => {
  eq(fitScale({ w: 0, h: 0 }, { w: 100, h: 100 }, 8), 1);
});
