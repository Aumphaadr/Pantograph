// prep/mask.js — мягкая маска и всё, что с ней делается до трассировки.
//
// Единственный растровый тип проекта. Значения 0..1, а не биты: 81% пикселей
// иконки живут в антиалиасинге, и субпиксельное положение края закодировано
// именно в этих дробных значениях (см. ARCHITECTURE.md, п. 0).
//
// Порог стоит предпоследним шагом, а не первым. Все шаги — Mask → Mask,
// поэтому свободно переставляются и тестируются поодиночке.

export function createMask(w, h) {
  return { w, h, data: new Float32Array(w * h) };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Мягкая маска по расстоянию до цвета штриха.
 *
 * Пиксель раскладывается на две части: положение вдоль отрезка «фон → штрих»
 * (это и есть покрытие, оно же альфа антиалиасинга) и отклонение поперёк него
 * (это чужой цвет, его надо погасить). tolerance задаёт, насколько далеко
 * вбок можно отойти, оставаясь «своим».
 *
 * @param {ImageData} img
 * @param {{fg:number[], bg:number[], tolerance:number}} opts — цвета RGB 0..255
 * @returns {{w:number,h:number,data:Float32Array}}
 */
export function colorDistance(img, { fg, bg, tolerance = 60 }) {
  const out = createMask(img.width, img.height);
  const d = img.data;
  const ax = fg[0] - bg[0];
  const ay = fg[1] - bg[1];
  const az = fg[2] - bg[2];
  const den = ax * ax + ay * ay + az * az;
  if (den === 0) return out;   // фон и штрих совпали — различать нечего

  for (let i = 0, j = 0; j < out.data.length; i += 4, j += 1) {
    const cx = d[i] - bg[0];
    const cy = d[i + 1] - bg[1];
    const cz = d[i + 2] - bg[2];
    const t = (cx * ax + cy * ay + cz * az) / den;
    const px = cx - t * ax;
    const py = cy - t * ay;
    const pz = cz - t * az;
    const perp = Math.sqrt(px * px + py * py + pz * pz);
    const fall = tolerance <= 0 ? (perp === 0 ? 1 : 0) : 1 - perp / tolerance;
    out.data[j] = fall <= 0 ? 0 : clamp01(t) * fall;
  }
  return out;
}

/**
 * Покрытие → поле, по которому линейная изолиния точна на прямой кромке.
 * Пиксель с покрытием c между полным и пустым имеет край в c от своего
 * левого края; линейная интерполяция между центрами отсчётов ставит его
 * в 0.5/(1−c) — с промахом до 0.08 px на четверти покрытия. Кривая g снимает
 * промах: g(v) = 2v/(1+2v) при v<0.5, 0.5/(1.5−v) при v≥0.5; g(0.5)=0.5.
 */
export function coverageToField(mask) {
  const out = createMask(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i += 1) {
    const v = mask.data[i];
    out.data[i] = v < 0.5 ? (2 * v) / (1 + 2 * v) : 0.5 / (1.5 - v);
  }
  return out;
}

/** Средний цвет в квадрате со стороной 2r+1 — пипетка не должна ловить один случайный пиксель. */
export function sampleColor(img, cx, cy, r = 1) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      sr += img.data[i]; sg += img.data[i + 1]; sb += img.data[i + 2]; n += 1;
    }
  }
  return n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : [0, 0, 0];
}

/** Самый частый цвет кропа — разумная догадка про фон. Гистограмма по 4 битам на канал. */
export function guessBackground(img) {
  const hist = new Map();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; best = k; }
  // Возвращаем середину ячейки гистограммы.
  return [(((best >> 8) & 15) << 4) | 8, (((best >> 4) & 15) << 4) | 8, ((best & 15) << 4) | 8];
}

/**
 * Цвет штриха: СРЕДИННЫЙ среди далёких от фона, а не самый далёкий.
 *
 * Самый далёкий пиксель — это блик, а не чернила. На мелком кропе разница
 * незаметна, а на крупном мастере догадка уезжала в почти белый (255,245,81
 * вместо золотого), и по нему маска ловила полпроцента картинки: иконка
 * не обводилась вовсе.
 *
 * «Далёкие» отсекаются по доле от УСТОЙЧИВОГО максимума — сотой сверху,
 * а не абсолютного: одинокий пересвеченный пиксель не должен задавать шкалу.
 */
export function guessForeground(img, bg, { share = 0.6, percentile = 0.99 } = {}) {
  const d = img.data;
  const n = d.length >> 2;
  if (!n) return [...bg];

  const BINS = 256;
  const MAX_DIST = Math.sqrt(3) * 255;
  const hist = new Uint32Array(BINS);
  const binOf = (i) => {
    const dr = d[i] - bg[0];
    const dg = d[i + 1] - bg[1];
    const db = d[i + 2] - bg[2];
    return Math.min(BINS - 1, Math.round((Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST) * (BINS - 1)));
  };
  for (let i = 0; i < d.length; i += 4) hist[binOf(i)] += 1;

  let seen = 0;
  let robustMax = 0;
  const want = n * percentile;
  for (let b = 0; b < BINS; b += 1) {
    seen += hist[b];
    if (seen >= want) { robustMax = b; break; }
  }
  const cut = robustMax * share;
  if (robustMax === 0) return [...bg];

  // Медиана по каналам среди отобранных — считаем гистограммами, без сортировки.
  const ch = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (binOf(i) < cut) continue;
    ch[0][d[i]] += 1; ch[1][d[i + 1]] += 1; ch[2][d[i + 2]] += 1;
    count += 1;
  }
  if (!count) return [...bg];

  return ch.map((h) => {
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += h[v];
      if (acc * 2 >= count) return v;
    }
    return 255;
  });
}

// ─── увеличение ─────────────────────────────────────────────────────────────

function lanczos(x, a) {
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/** Веса разделимого фильтра для одной оси. Края зажимаются, а не заворачиваются. */
function axisWeights(srcLen, dstLen, a) {
  const scale = dstLen / srcLen;
  const rows = [];
  for (let i = 0; i < dstLen; i += 1) {
    const center = (i + 0.5) / scale - 0.5;
    const from = Math.ceil(center - a);
    const to = Math.floor(center + a);
    const idx = [];
    const wts = [];
    let sum = 0;
    for (let j = from; j <= to; j += 1) {
      const w = lanczos(center - j, a);
      if (w === 0) continue;
      idx.push(Math.min(srcLen - 1, Math.max(0, j)));
      wts.push(w);
      sum += w;
    }
    for (let n = 0; n < wts.length; n += 1) wts[n] /= sum;
    rows.push({ idx, wts });
  }
  return rows;
}

/**
 * Зажать увеличение по абсолютному размеру маски.
 *
 * Коэффициент выбирается от высоты буквы или ползунком, но кроп бывает и
 * большим: картинка 1254×1254 при ×6 дала бы маску 7524×7524 — это четверть
 * гигабайта на один массив. Крупному исходнику увеличение и не нужно, у него
 * край и так разрешён.
 */
export function capScale(w, h, k, maxPixels = 4e6) {
  const limit = Math.max(1, Math.floor(Math.sqrt(maxPixels / Math.max(1, w * h))));
  return Math.max(1, Math.min(Math.round(k), limit));
}

/**
 * Увеличение Ланцошем. Именно здесь субпиксельная информация превращается
 * в гладкое поле, по которому потом берётся изолиния.
 * Фильтр звенит — значения зажимаются в 0..1.
 */
export function upscale(mask, k, a = 3) {
  if (k === 1) return mask;
  const dw = Math.round(mask.w * k);
  const dh = Math.round(mask.h * k);

  const mid = new Float32Array(dw * mask.h);
  const wx = axisWeights(mask.w, dw, a);
  for (let y = 0; y < mask.h; y += 1) {
    const row = y * mask.w;
    for (let x = 0; x < dw; x += 1) {
      const { idx, wts } = wx[x];
      let s = 0;
      for (let n = 0; n < idx.length; n += 1) s += mask.data[row + idx[n]] * wts[n];
      mid[y * dw + x] = s;
    }
  }

  const out = createMask(dw, dh);
  const wy = axisWeights(mask.h, dh, a);
  for (let y = 0; y < dh; y += 1) {
    const { idx, wts } = wy[y];
    for (let x = 0; x < dw; x += 1) {
      let s = 0;
      for (let n = 0; n < idx.length; n += 1) s += mid[idx[n] * dw + x] * wts[n];
      out.data[y * dw + x] = clamp01(s);
    }
  }
  return out;
}

// ─── порог и морфология ─────────────────────────────────────────────────────

/** Бинаризация. Нужна для показа и для связных компонент, но не для трассировки. */
export function threshold(mask, level) {
  const out = createMask(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i += 1) out.data[i] = mask.data[i] > level ? 1 : 0;
  return out;
}

/**
 * Разделимый минимум или максимум в квадрате со стороной 2r+1.
 * За краем маски — фон (нуль), а не повтор края: иначе замыкание заливает
 * границу кропа, а размыкание не может съесть крапину, прилипшую к краю.
 */
function rank(mask, r, pick) {
  if (r <= 0) return mask;
  const { w, h } = mask;
  const mid = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = x - r < 0 ? 0 : mask.data[y * w + x - r];
      for (let dx = -r + 1; dx <= r; dx += 1) {
        const xx = x + dx;
        v = pick(v, xx < 0 || xx >= w ? 0 : mask.data[y * w + xx]);
      }
      mid[y * w + x] = v;
    }
  }
  const out = createMask(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = y - r < 0 ? 0 : mid[(y - r) * w + x];
      for (let dy = -r + 1; dy <= r; dy += 1) {
        const yy = y + dy;
        v = pick(v, yy < 0 || yy >= h ? 0 : mid[yy * w + x]);
      }
      out.data[y * w + x] = v;
    }
  }
  return out;
}

const MIN = (a, b) => (a < b ? a : b);
const MAX = (a, b) => (a > b ? a : b);

export const erode = (mask, r) => rank(mask, r, MIN);
export const dilate = (mask, r) => rank(mask, r, MAX);

/**
 * Размыкание убирает крапины генерации, замыкание латает разрывы штриха.
 * Работает по серому полю, а не по битам: иначе теряется всё, ради чего
 * порог отложен на потом.
 */
export function morph(mask, { open = 0, close = 0 } = {}) {
  let m = mask;
  if (open > 0) m = dilate(erode(m, open), open);
  if (close > 0) m = erode(dilate(m, close), close);
  return m;
}

/** Рамка из нулей. Гарантирует, что все изолинии замкнутся внутри сетки. */
export function pad(mask, n = 1, value = 0) {
  const out = createMask(mask.w + n * 2, mask.h + n * 2);
  if (value !== 0) out.data.fill(value);
  for (let y = 0; y < mask.h; y += 1) {
    out.data.set(mask.data.subarray(y * mask.w, (y + 1) * mask.w), (y + n) * out.w + n);
  }
  return out;
}
