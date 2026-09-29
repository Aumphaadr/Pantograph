// prep/weight.js — единый вес штриха у готового значка: сдвиг края по кускам.
//
// Генератор рисует набор штрихом разной толщины: у одного значка 0.8 единицы
// сетки, у соседа 1.8, и в столбике меню это режет глаз. Перерисовать значок
// по осевой с общей толщиной — значит потерять всё, что не штрих: шишку
// колокольчика, лезвия ножниц, зрачок, острия стрелок. Скелет ломается ровно
// на деталях размером со штрих (проверено на наборе Idyllium, см.
// ARCHITECTURE.md, п. 4и). Поэтому здесь край каждого куска сдвигается на
// постоянную величину (W − w)/2, где w — толщина ЭТОГО куска по его скелету:
// форма остаётся как была, толщина становится общей.
//
// Что не штрих — не трогаем: пятна (точка «i», play, бегунок, зрачок) остаются
// как были. Зазоры держатся: где конец штриха упирается в борт соседа
// (перечёркнутый глаз), уступает конец — он срезается по контуру соседа, как
// вырез; где борт против борта, куски растут врозь поровну. Сердцевина мелких
// дыр не зарастает: кольцо остаётся кольцом.
//
// Всё в пикселях маски; перевод из единиц сетки — дело вызывающего. Пороги —
// в долях заданной толщины: так они одни и те же при любом увеличении маски.

import { distanceTransform, thin, centerline } from '../trace/centerline.js';
import { labelComponents } from '../glyphs/segment.js';

export const DEFAULTS = {
  gap: 0.5,        // зазор, который держится между кусками и в дырах, в толщинах
  maxShift: 0.36,  // сдвиг края не больше этого, в толщинах
  allSolid: 1.86,  // медиана толщины значка больше — он весь из пятен (play, stop)
  solidK: 2.3,     // толще штриха значка во столько раз — пятно
  sliver: 0.18,    // обрезок линии у пятна мельче этого (в квадратах толщины) — к пятну
};

const quantile = (s, p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
const inverse = (u8) => { const o = new Uint8Array(u8.length); for (let i = 0; i < o.length; i += 1) o[i] = u8[i] ? 0 : 1; return o; };
const field = (w, h, u8) => ({ w, h, data: Float32Array.from(u8) });
/** Расстояние от каждого пикселя до ближайшего пикселя множества, px. */
const distTo = (w, h, set) => distanceTransform(field(w, h, inverse(set)));

/**
 * Толщина штриха по скелету: 2·(расстояние до фона) − 1 в каждой точке оси.
 * @returns {{med:number, p10:number, p90:number}} в px; нули, если скелета нет
 */
export function strokeWidth(mask) {
  const bin = field(mask.w, mask.h, mask.data.map((v) => (v > 0.5 ? 1 : 0)));
  const dt = distanceTransform(bin);
  const sk = thin(bin);
  const ws = [];
  for (let i = 0; i < sk.length; i += 1) if (sk[i]) ws.push(2 * dt[i] - 1);
  ws.sort((a, b) => a - b);
  if (!ws.length) return { med: 0, p10: 0, p90: 0 };
  return { med: quantile(ws, 0.5), p10: quantile(ws, 0.1), p90: quantile(ws, 0.9) };
}

/**
 * Пятна: где вписанный круг толще штриха значка в solidK раз (восстановление
 * по оси — объединение вписанных кругов толстых мест), и компактные куски
 * толщиной от полутора штрихов (точка «i», квадратики qr).
 */
function solidsOf(w, h, bin, dt, med, o) {
  const solid = new Uint8Array(w * h);
  const tau = (o.solidK * med) / 2;
  for (let i = 0; i < dt.length; i += 1) {
    if (dt[i] < tau) continue;
    const cx = i % w, cy = (i - cx) / w, r = dt[i] + 0.5, r2 = r * r;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2 && bin[y * w + x]) solid[y * w + x] = 1;
      }
    }
  }
  const { labels, count } = labelComponents(field(w, h, bin));
  const maxD = new Float32Array(count);
  const box = Array.from({ length: count }, () => [w, h, -1, -1]);
  for (let i = 0; i < labels.length; i += 1) {
    const l = labels[i];
    if (l < 0) continue;
    if (dt[i] > maxD[l]) maxD[l] = dt[i];
    const x = i % w, y = (i - x) / w, b = box[l];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  for (let l = 0; l < count; l += 1) {
    const ext = Math.max(box[l][2] - box[l][0] + 1, box[l][3] - box[l][1] + 1);
    const compact = 2 * maxD[l] >= 0.6 * ext;
    if (!compact || 2 * maxD[l] < 1.5 * med) continue;
    for (let i = 0; i < labels.length; i += 1) if (labels[i] === l) solid[i] = 1;
  }
  // Обрезки линий, отрезанные восстановлением у пятна (углы полоски прогресса), — к пятну.
  const rest = new Uint8Array(w * h);
  for (let i = 0; i < rest.length; i += 1) rest[i] = bin[i] && !solid[i] ? 1 : 0;
  const R = labelComponents(field(w, h, rest));
  const area = new Int32Array(R.count);
  const touches = new Uint8Array(R.count);
  for (let i = 0; i < R.labels.length; i += 1) {
    const l = R.labels[i];
    if (l < 0) continue;
    area[l] += 1;
    for (const d of [1, -1, w, -w]) if (solid[i + d]) touches[l] = 1;
  }
  for (let i = 0; i < R.labels.length; i += 1) {
    const l = R.labels[i];
    if (l >= 0 && touches[l] && area[l] < o.sliver) solid[i] = 1;
  }
  return solid;
}

/**
 * Скруглить торец у среза: раскрытие (сжатие и рост) диском радиуса r, но
 * только рядом со срезом — в других местах у куска могут быть острые углы
 * по замыслу. Тело штриха толщиной 2r раскрытие не трогает.
 */
function roundCut(part, cut, r) {
  if (!(r > 1)) return;
  const { w, h } = part;
  const N = w * h;
  const near = distTo(w, h, cut);
  const inner = distanceTransform(field(w, h, part.grown));
  const core = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) core[i] = inner[i] > r ? 1 : 0;
  const back = distTo(w, h, core);
  const drop = [];
  let total = 0;
  for (let i = 0; i < N; i += 1) {
    if (!part.grown[i]) continue;
    total += 1;
    if (near[i] <= 2 * r && back[i] > r + 0.5) drop.push(i);
  }
  // Кусок тоньше диска раскрытие съело бы целиком (планка под короной
  // SignoreBot пропала) — там торец остаётся плоским.
  if (drop.length > 0.15 * total) return;
  for (const i of drop) part.grown[i] = 0;
}

/**
 * Довести толщину штриха значка до target.
 *
 * @param {{w,h,data}} mask — бинарная маска значка (крупная: десятки px на штрих)
 * @param {number} target — толщина штриха, px
 * @param {object} [opts] — см. DEFAULTS (доли толщины target)
 * @returns {{out:Uint8Array, med:number, allSolid:boolean, parts:object[], notes:string[]}}
 *   parts — куски v1: толщина w, сдвиг shift (px), solid, yielded
 */
export function evenWeight(mask, target, opts = {}) {
  const f = { ...DEFAULTS, ...opts };
  const o = {
    gap: f.gap * target, maxShift: f.maxShift * target, allSolid: f.allSolid * target,
    solidK: f.solidK, sliver: f.sliver * target * target,
  };
  const { w, h } = mask;
  const N = w * h;
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) bin[i] = mask.data[i] > 0.5 ? 1 : 0;
  const notes = [];
  const med = strokeWidth(mask).med;
  if (med >= o.allSolid) return { out: bin, med, allSolid: true, parts: [], notes: ['весь значок — пятна, оставлен как был'] };

  const dtIn = distanceTransform(field(w, h, bin));
  const sk = thin(field(w, h, bin));
  const dtOut = distTo(w, h, bin);
  const solid = solidsOf(w, h, bin, dtIn, med, o);
  const { labels, count } = labelComponents(field(w, h, bin));

  // Куски: своя толщина по скелету без пятен, свой сдвиг, концы осевой.
  // Растёт и худеет только линейная часть куска: бегунок на треке остаётся
  // как был, а трек дорастает до общей толщины.
  const parts = [];
  for (let l = 0; l < count; l += 1) {
    const set = new Uint8Array(N);
    const line = new Uint8Array(N);
    let all = 0, linePx = 0, maxD = 0;
    const ws = [];
    for (let i = 0; i < N; i += 1) {
      if (labels[i] !== l) continue;
      set[i] = 1; all += 1;
      if (solid[i]) continue;
      line[i] = 1; linePx += 1;
      if (dtIn[i] > maxD) maxD = dtIn[i];
      if (sk[i]) ws.push(2 * dtIn[i] - 1);
    }
    ws.sort((a, b) => a - b);
    // Кусок без скелета (точка) меряется вписанным кругом.
    const width = ws.length >= 8 ? quantile(ws, 0.5) : 2 * maxD - 1;
    const shift = linePx ? Math.max(-o.maxShift, Math.min(o.maxShift, (target - width) / 2)) : 0;
    const ends = [];
    if (linePx) {
      for (const ch of centerline(field(w, h, line), 1, {})) {
        if (!ch.closed) ends.push(ch.points[0], ch.points[ch.points.length - 1]);
      }
    }
    parts.push({ w, h, set, line, width, shift, solid: !linePx, ends, area: all, yielded: false });
  }

  // Сердцевина дыр: просвет не уже min(2·m, gap), где m — вписанный радиус дыры.
  const core = new Uint8Array(N);
  {
    const bg = inverse(bin);
    const seen = new Uint8Array(N);
    const stack = [];
    const maxShift = Math.max(0, ...parts.map((p) => p.shift));
    for (let start = 0; start < N; start += 1) {
      if (!bg[start] || seen[start]) continue;
      const pixels = [];
      let edge = false, m = 0;
      seen[start] = 1; stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        pixels.push(i);
        const x = i % w, y = (i - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        if (dtOut[i] > m) m = dtOut[i];
        if (x > 0 && bg[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < w - 1 && bg[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && bg[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
        if (y < h - 1 && bg[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
      }
      if (edge) continue;
      const keep = Math.min(o.gap, 2 * m);
      const grow = Math.max(0, m - keep / 2);
      for (const i of pixels) if (dtOut[i] > grow) core[i] = 1;
      if (grow < maxShift) notes.push(`дыра ${pixels.length} px² держит просвет ${keep.toFixed(0)} px`);
    }
  }

  // Свободный рост (или утоньшение) линейной части каждого куска.
  for (const p of parts) {
    const g = new Uint8Array(N);
    if (p.shift > 0) {
      const d = distTo(w, h, p.line);
      for (let i = 0; i < N; i += 1) g[i] = p.set[i] || (d[i] <= p.shift && !core[i] && !bin[i]) ? 1 : 0;
    } else {
      // Утоньшение: уходят пиксели линии ближе |сдвига| к фону (центр пикселя — на полпикселя внутри).
      for (let i = 0; i < N; i += 1) g[i] = p.set[i] && (!p.line[i] || dtIn[i] - 0.5 >= -p.shift) ? 1 : 0;
    }
    p.grown = g;
    p.dist = distTo(w, h, p.set);
  }

  // Столкновения: кто уступает.
  const endNear = (ends, dist, r) => ends.some((pt) => dist[Math.floor(pt.y) * w + Math.floor(pt.x)] <= r);
  // Длина касания: сколько пикселей края куска стоит почти так же близко к
  // соседу, как ближайшая точка. Торец у борта касается коротко (порядка
  // толщины), борт у борта — на всю длину: короткая планка под короной
  // касается вдоль, хотя концы у неё тоже рядом, и уступать ей нечем.
  const contact = (P, dist, g) => {
    let n = 0;
    for (let i = 0; i < N; i += 1) {
      if (!P.set[i] || dist[i] > g + 1 + 0.25 * target) continue;
      const x = i % w;
      if (x === 0 || x === w - 1 || !P.set[i - 1] || !P.set[i + 1] || !P.set[i - w] || !P.set[i + w]) n += 1;
    }
    return n;
  };
  for (let a = 0; a < parts.length; a += 1) {
    for (let b = a + 1; b < parts.length; b += 1) {
      const A = parts[a], B = parts[b];
      let g1 = Infinity;
      for (let i = 0; i < N; i += 1) if (A.set[i] && B.dist[i] < g1) g1 = B.dist[i];
      g1 = Math.max(0, g1 - 1);            // расстояние центров − 1 = пустых пикселей
      if (g1 > 2 * o.gap) continue;
      const dB = distTo(w, h, B.grown);
      let g2 = Infinity;
      for (let i = 0; i < N; i += 1) if (A.grown[i] && dB[i] < g2) g2 = dB[i];
      g2 = Math.max(0, g2 - 1);
      const keep = Math.min(o.gap, g1);
      if (g2 >= keep - 0.5) continue;
      // Порог — четыре толщины: срезанный вдоль черты торец половинки зрачка
      // (eye-off SignoreBot) касается на две-три, планка под короной — на десять.
      const side = Math.min(contact(A, B.dist, g1), contact(B, A.dist, g1)) > 4 * target;
      const aEnd = !side && endNear(A.ends, B.dist, g1 + A.width + 0.15 * target);
      const bEnd = !side && endNear(B.ends, A.dist, g1 + B.width + 0.15 * target);
      if (aEnd !== bEnd) {
        // Конец против борта: конец срезается по контуру соседа — вырез — и
        // скругляется заново: срез по контуру давал плоский торец, и пилюля
        // у стенки становилась бочонком (полоски корешков, лучи солнца).
        const [Y, X] = aEnd ? [A, B] : [B, A];
        const dX = aEnd ? dB : distTo(w, h, X.grown);
        const cut = new Uint8Array(N);
        for (let i = 0; i < N; i += 1) if (Y.grown[i] && dX[i] < keep + 1) { Y.grown[i] = 0; cut[i] = 1; }
        roundCut(Y, cut, Math.min(target, Y.width + 2 * Y.shift) / 2 - 1);
        Y.yielded = true;
        notes.push(`вырез: кусок ${aEnd ? a : b} срезан у ${aEnd ? b : a} (зазор v1 ${g1.toFixed(0)} px)`);
      } else {
        // Борт против борта (или конец против конца): растут врозь поровну.
        for (let i = 0; i < N; i += 1) {
          if (A.grown[i] && !A.set[i] && B.dist[i] - A.dist[i] < keep + 1) A.grown[i] = 0;
          if (B.grown[i] && !B.set[i] && A.dist[i] - B.dist[i] < keep + 1) B.grown[i] = 0;
        }
        notes.push(`теснота: куски ${a} и ${b} растут врозь (зазор v1 ${g1.toFixed(0)} px)`);
      }
    }
  }

  const out = new Uint8Array(N);
  for (const p of parts) for (let i = 0; i < N; i += 1) if (p.grown[i]) out[i] = 1;
  return {
    out, med, allSolid: false, notes,
    parts: parts.map((p) => ({ width: p.width, shift: p.shift, solid: p.solid, area: p.area, yielded: p.yielded })),
  };
}
