// glyphs/merge.js — склейка составных букв.
//
// Ё, Й, i, j, двоеточие, кавычки распадаются на несколько связных компонент.
// Эвристика собирает их обратно; всё, что она не поймала (Ы, например, — две
// части бок о бок), человек соединяет руками. Автоматике тут доверять нельзя.

const bboxOf = (ids, components) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of ids) {
    const b = components[i].bbox;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

export const groupBBox = bboxOf;

/**
 * Пара склеивается, если по горизонтали они перекрываются больше чем на
 * половину узкого, а по вертикали зазор меньше 0.4 высоты высокого.
 * То есть одна часть стоит НАД другой и накрыта ею по ширине — как точки над Ё.
 */
export function shouldMerge(a, b, { xOverlap = 0.5, yGap = 0.4 } = {}) {
  const A = a.bbox;
  const B = b.bbox;
  const over = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
  if (over <= xOverlap * Math.min(A.w, B.w)) return false;
  const gap = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
  return gap < yGap * Math.max(A.h, B.h);
}

const mid = (values) => {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1];
};

/**
 * Вторая склейка: части, разорванные ВНУТРИ буквы.
 *
 * «Ы» — это «Ь» и «І» бок о бок, и по перекрытию их не собрать: они стоят
 * рядом, а не одна над другой. Зато их выдаёт зазор. В строке «ХЦЧШЩЪЫЬЭЮЯ»
 * промежутки между буквами 31–56 пикселей, а внутри «Ы» — семь. Так что
 * мера берётся из самой строки: всё, что заметно теснее её медианы, —
 * это одна буква.
 *
 * Ширина сдерживает: даже при тесной посадке буква не должна выйти вдвое
 * шире соседей, иначе склеятся два настоящих знака.
 */
export function mergeTight(groups, components, opts = {}) {
  const { share = 0.4, widthLimit = 1.9, minGaps = 3 } = opts;
  const rows = readingOrder(groups, components, opts);
  const out = [];

  for (const row of rows) {
    const boxes = row.map((ids) => bboxOf(ids, components));
    const gaps = [];
    for (let i = 1; i < boxes.length; i += 1) {
      gaps.push(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w));
    }
    if (gaps.length < minGaps) { out.push(...row); continue; }

    const medGap = mid(gaps);
    const medWidth = mid(boxes.map((b) => b.w));
    let ids = [...row[0]];
    let left = boxes[0].x;

    for (let i = 1; i < row.length; i += 1) {
      const tight = gaps[i - 1] < medGap * share;
      const wide = boxes[i].x + boxes[i].w - left > medWidth * widthLimit;
      if (tight && !wide) {
        ids = ids.concat(row[i]);
      } else {
        out.push(ids.sort((a, b) => a - b));
        ids = [...row[i]];
        left = boxes[i].x;
      }
    }
    out.push(ids.sort((a, b) => a - b));
  }
  return out;
}

/**
 * Свести строку к нужному числу знаков, склеивая по самым тесным зазорам.
 *
 * У шрифтового листа есть то, чего нет у случайной картинки: человек сказал,
 * что написано, — значит известно, сколько знаков в строке. Тогда гадать
 * незачем. Многоточие из трёх точек, процент из трёх частей, тильда над
 * буквой — всё это сводится само, если известно, что знаков должно быть
 * тринадцать, а групп вышло шестнадцать.
 *
 * Обратное неверно: если групп МЕНЬШЕ, значит два знака слиплись, и разнять
 * их автоматически нельзя — об этом надо сказать человеку.
 */
export function mergeToCount(row, components, target) {
  let groups = row.map((ids) => [...ids]);
  while (groups.length > target && groups.length > 1) {
    const boxes = groups.map((ids) => bboxOf(ids, components));
    let at = 0;
    let best = Infinity;
    for (let i = 1; i < boxes.length; i += 1) {
      const gap = boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w);
      if (gap < best) { best = gap; at = i; }
    }
    groups = groups.slice(0, at - 1)
      .concat([groups[at - 1].concat(groups[at]).sort((a, b) => a - b)])
      .concat(groups.slice(at + 1));
  }
  return groups;
}

/**
 * Подогнать все строки под ожидаемые количества.
 * @param {number[]} counts — сколько знаков в каждой строке текста
 * @returns {{groups:Array, rows:Array, short:number[]}} short — строки, где групп не хватило
 */
export function fitRows(groups, components, counts, opts = {}) {
  const rows = readingOrder(groups, components, opts);
  const out = [];
  const short = [];
  rows.forEach((row, i) => {
    const want = counts[i];
    if (!Number.isFinite(want) || want <= 0) { out.push(...row); return; }
    if (row.length < want) short.push(i);
    out.push(...mergeToCount(row, components, want));
  });
  return { groups: out, rows: rows.length, short };
}

/** Группы компонент. Возвращает массивы индексов в components. */
export function autoMerge(components, opts = {}) {
  const parent = components.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[a] = b; };

  for (let i = 0; i < components.length; i += 1) {
    for (let j = i + 1; j < components.length; j += 1) {
      if (shouldMerge(components[i], components[j], opts)) union(i, j);
    }
  }

  const buckets = new Map();
  components.forEach((_, i) => {
    const r = find(i);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(i);
  });
  return [...buckets.values()].map((ids) => ids.sort((a, b) => a - b));
}

/** Слить группы, содержащие любую из указанных компонент, в одну. */
export function mergeGroups(groups, componentIds) {
  const touch = new Set(componentIds);
  const merged = [];
  const rest = [];
  for (const g of groups) {
    if (g.some((i) => touch.has(i))) merged.push(...g);
    else rest.push(g);
  }
  if (merged.length === 0) return groups;
  return [...rest, merged.sort((a, b) => a - b)];
}

/** Разобрать группу обратно на отдельные компоненты. */
export function splitGroup(groups, componentId) {
  const out = [];
  for (const g of groups) {
    if (g.includes(componentId) && g.length > 1) out.push(...g.map((i) => [i]));
    else out.push(g);
  }
  return out;
}

/**
 * Порядок чтения: строки сверху вниз, внутри строки слева направо.
 * От него зависит вся привязка к символам на следующем этапе.
 */
export function readingOrder(groups, components, { overlap = 0.4 } = {}) {
  const boxed = groups.map((ids) => ({ ids, bbox: bboxOf(ids, components) }));
  const rows = [];

  for (const g of [...boxed].sort((a, b) => a.bbox.y - b.bbox.y)) {
    const y0 = g.bbox.y;
    const y1 = g.bbox.y + g.bbox.h;
    let row = rows.find((r) => {
      const over = Math.min(y1, r.y1) - Math.max(y0, r.y0);
      return over > overlap * Math.min(g.bbox.h, r.y1 - r.y0);
    });
    if (!row) { row = { y0, y1, items: [] }; rows.push(row); }
    row.items.push(g);
    row.y0 = Math.min(row.y0, y0);
    row.y1 = Math.max(row.y1, y1);
  }

  rows.sort((a, b) => a.y0 - b.y0);
  const out = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.bbox.x - b.bbox.x);
    out.push(r.items.map((g) => g.ids));
  }
  return out;
}
