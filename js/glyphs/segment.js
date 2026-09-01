// glyphs/segment.js — разрезание строки на буквы.
//
// Разветвление происходит ЗДЕСЬ, до трассировки: сегментируем растр, а каждую
// букву потом обводим отдельно. Так каждый глиф получает свой бюджет
// увеличения, перетрассировка одной буквы не трогает остальных, а дырки в «О»
// и «Ф» выходят сами из обводки подкартинки.

import { createMask } from '../prep/mask.js';

const PAD = 2;   // поле вокруг габарита компоненты, пиксели исходника

/** Связные компоненты по восьмисвязности. Обход стеком, без рекурсии. */
export function labelComponents(binary) {
  const { w, h, data } = binary;
  const labels = new Int32Array(w * h).fill(-1);
  const stack = [];
  let count = 0;

  for (let start = 0; start < data.length; start += 1) {
    if (data[start] <= 0 || labels[start] >= 0) continue;
    const id = count;
    count += 1;
    labels[start] = id;
    stack.push(start);

    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (data[q] > 0 && labels[q] < 0) { labels[q] = id; stack.push(q); }
        }
      }
    }
  }
  return { labels, count };
}

/**
 * Компоненты с их кусками МЯГКОЙ маски.
 *
 * Тонкость, которую легко потерять: компоненты ищутся по бинарной маске
 * (связность определена только для битов), а на трассировку уходит мягкая,
 * иначе теряется весь выигрыш от антиалиасинга.
 *
 * Гасим только пиксели ЧУЖИХ компонент. Фон (метки нет) остаётся как есть:
 * именно в нём живёт спад яркости на краю буквы, и без него внутренний контур
 * «О» потерял бы субпиксельную точность.
 */
export function segment(soft, binary, { minArea = 4 } = {}) {
  const { w, h } = binary;
  const { labels, count } = labelComponents(binary);

  const box = Array.from({ length: count }, () => ({
    x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, area: 0,
  }));
  for (let i = 0; i < labels.length; i += 1) {
    const id = labels[i];
    if (id < 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const b = box[id];
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x > b.x1) b.x1 = x;
    if (y > b.y1) b.y1 = y;
    b.area += 1;
  }

  const out = [];
  for (let id = 0; id < count; id += 1) {
    const b = box[id];
    if (b.area < minArea) continue;
    const bbox = { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };

    // Поле в два пикселя, и оно не пустое. Габарит считан по БИНАРНОЙ маске,
    // поэтому спад яркости на внешнем крае буквы лежит за габаритом: обнулить
    // поле значило бы выбросить субпиксельный край, ради которого всё затеяно.
    // Внутреннее кольцо несёт настоящие значения фона, внешнее — нули,
    // чтобы контур гарантированно замкнулся внутри сетки.
    const mask = createMask(bbox.w + PAD * 2, bbox.h + PAD * 2);
    for (let y = 1; y < mask.h - 1; y += 1) {
      for (let x = 1; x < mask.w - 1; x += 1) {
        const sx = bbox.x + x - PAD;
        const sy = bbox.y + y - PAD;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const src = sy * w + sx;
        const lab = labels[src];
        mask.data[y * mask.w + x] = lab === id || lab < 0 ? soft.data[src] : 0;
      }
    }
    out.push({ id: out.length, bbox, area: b.area, mask, pad: PAD });
  }
  return out;
}

/**
 * Разбиение на строки по вертикальному перекрытию.
 * Строки идут сверху вниз, внутри строки — слева направо: порядок чтения.
 */
export function lines(components, { overlap = 0.4 } = {}) {
  const sorted = [...components].sort((a, b) => a.bbox.y - b.bbox.y);
  const rows = [];

  for (const c of sorted) {
    const y0 = c.bbox.y;
    const y1 = c.bbox.y + c.bbox.h;
    let row = null;
    for (const r of rows) {
      const over = Math.min(y1, r.y1) - Math.max(y0, r.y0);
      if (over > overlap * Math.min(c.bbox.h, r.y1 - r.y0)) { row = r; break; }
    }
    if (!row) { row = { y0, y1, items: [] }; rows.push(row); }
    row.items.push(c);
    row.y0 = Math.min(row.y0, y0);
    row.y1 = Math.max(row.y1, y1);
  }

  rows.sort((a, b) => a.y0 - b.y0);
  for (const r of rows) r.items.sort((a, b) => a.bbox.x - b.bbox.x);
  return rows.map((r) => r.items);
}
