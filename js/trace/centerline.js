// trace/centerline.js — осевая линия вместо заливки.
//
// Трассировщик даёт границу фигуры: линейная иконка выходит двухконтурной
// «трубой». Выглядит так же, но толщину потом не покрутить. Здесь фигура
// сводится к своей срединной оси, а толщина считается отдельно — как
// расстояние до ближайшего фона (см. BACKLOG.md, п. 1).
//
// Порядок: преобразование расстояний (толщина) → утоньшение до пикселя в
// ширину (ось) → разбор скелета на цепочки → отсев отростков.

const INF = 1e20;

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Точное евклидово преобразование расстояний, алгоритм Фельценсвальба:
 * одномерная нижняя огибающая парабол, сперва по столбцам, затем по строкам.
 * Приблизительной шахматной метрики тут мало — на ней толщина косого штриха
 * врёт на четверть.
 *
 * @param {{w:number,h:number,data:Float32Array}} bin — 0/1
 * @returns {Float32Array} расстояние до ближайшего нуля, в пикселях маски
 */
export function distanceTransform(bin) {
  const { w, h, data } = bin;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(w * h);
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);

  const pass = (n, get, set) => {
    for (let i = 0; i < n; i += 1) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q += 1) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1;
      const dq = q - v[k];
      set(q, dq * dq + f[v[k]]);
    }
  };

  for (let x = 0; x < w; x += 1) {
    pass(h, (y) => (data[y * w + x] > 0 ? INF : 0), (y, val) => { d[y * w + x] = val; });
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    pass(w, (x) => d[row + x], (x, val) => { out[row + x] = Math.sqrt(val); });
  }
  return out;
}

// Соседи по часовой стрелке от севера — порядок Чжана и Суня: P2…P9.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

/**
 * Утоньшение Чжана — Суня до линии в один пиксель.
 *
 * Идём не по всему растру, а по списку живых пикселей: он тает от прохода к
 * проходу, и полная стоимость выходит линейной по площади фигуры, а не по
 * площади кропа, помноженной на число проходов.
 *
 * @param {{w:number,h:number,data:Float32Array}} bin — 0/1
 * @returns {Uint8Array} скелет, 0/1
 */
export function thin(bin) {
  const { w, h } = bin;
  const px = new Uint8Array(w * h);
  let live = [];
  for (let i = 0; i < px.length; i += 1) {
    if (bin.data[i] > 0) {
      px[i] = 1;
      const x = i % w;
      const y = (i - x) / w;
      // Край кропа фигуру обрезает: пиксель на самой кромке соседей не имеет,
      // и трогать его нельзя — иначе штрих у края съедается.
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) live.push(i);
    }
  }

  const nb = new Uint8Array(8);
  const doomed = [];

  const step = (parity) => {
    doomed.length = 0;
    const keep = [];
    for (const i of live) {
      if (!px[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      let b = 0;
      for (let k = 0; k < 8; k += 1) {
        const v = px[(y + DY[k]) * w + (x + DX[k])];
        nb[k] = v;
        b += v;
      }
      keep.push(i);
      if (b < 2 || b > 6) continue;
      let a = 0;
      for (let k = 0; k < 8; k += 1) {
        if (nb[k] === 0 && nb[(k + 1) & 7] === 1) a += 1;
      }
      if (a !== 1) continue;
      const [p2, p3, p4, p5, p6, p7, p8] = nb;
      void p3; void p5; void p7;
      const ok = parity === 0
        ? (p2 * p4 * p6) === 0 && (p4 * p6 * p8) === 0
        : (p2 * p4 * p8) === 0 && (p2 * p6 * p8) === 0;
      if (ok) doomed.push(i);
    }
    live = keep;
    for (const i of doomed) px[i] = 0;
    return doomed.length;
  };

  // Потолок проходов — страховка от зацикливания на испорченных данных:
  // честнее отдать недоутоньшённый скелет, чем повесить воркер.
  for (let pass = 0; pass < 200; pass += 1) {
    const a = step(0);
    const b = step(1);
    if (a + b === 0) break;
  }

  // Чжан и Сунь оставляют на пологих диагоналях лесенки в два пикселя шириной,
  // и каждый второй пиксель в них оказывается развилкой: у кольца в 1254 px
  // выходило 884 развилки и полторы тысячи обрывков вместо одной линии.
  // Числом пересечений это не лечится — соседи такого пикселя связаны в обход,
  // и поодиночке каждый выглядит нужным. Лечится проходом Холта, который
  // смотрит именно на лесенку.
  staircase(px, w, h, live);
  cleanup(px, w, h, live);
  return px;
}

/**
 * Снятие лесенки по Холту: из пары соседних пикселей, идущих уступом, лишний
 * тот, у которого по вертикали есть сосед, а по горизонтали — сосед без
 * диагональной подпорки. Два прохода, северный и южный, иначе снимался бы
 * только один наклон.
 */
function staircase(px, w, h, live) {
  const nb = new Uint8Array(8);
  for (const south of [false, true]) {
    const doomed = [];
    for (const i of live) {
      if (!px[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      for (let k = 0; k < 8; k += 1) nb[k] = px[(y + DY[k]) * w + (x + DX[k])];
      const [N, NE, E, SE, S, SW, W, NW] = nb;
      const hit = south
        ? S && ((E && !SE && !NW) || (W && !SW && !NE))
        : N && ((E && !NE && !SW) || (W && !NW && !SE));
      if (hit) doomed.push(i);
    }
    for (const i of doomed) px[i] = 0;
  }
}

/** Снять пиксели, ничего не держащие: A(P) === 1 и соседей не меньше двух. */
function cleanup(px, w, h, live) {
  const nb = new Uint8Array(8);
  for (let pass = 0; pass < 8; pass += 1) {
    let gone = 0;
    for (const i of live) {
      if (!px[i]) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      let b = 0;
      for (let k = 0; k < 8; k += 1) {
        const v = px[(y + DY[k]) * w + (x + DX[k])];
        nb[k] = v;
        b += v;
      }
      if (b < 2) continue;                 // свободный конец держит линию
      let a = 0;
      for (let k = 0; k < 8; k += 1) {
        if (nb[k] === 0 && nb[(k + 1) & 7] === 1) a += 1;
      }
      if (a !== 1) continue;               // соседи в двух дугах — пиксель нужен
      px[i] = 0;
      gone += 1;
    }
    if (!gone) break;
  }
}

/**
 * Скелет → цепочки пикселей.
 *
 * Узлы — концы (один сосед) и развилки (три и больше). Между ними идут
 * цепочки из пикселей ровно с двумя соседями. Пройденное помечается по РЁБРАМ,
 * а не по пикселям: через развилку проходит несколько цепочек, и пометка по
 * пикселю обрубила бы все, кроме первой.
 *
 * @returns {number[][]} цепочки индексов пикселей
 */
export function skeletonPaths(px, w, h) {
  const deg = new Uint8Array(px.length);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : px[y * w + x]);
  for (let i = 0; i < px.length; i += 1) {
    if (!px[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    let n = 0;
    for (let k = 0; k < 8; k += 1) n += at(x + DX[k], y + DY[k]);
    deg[i] = n;
  }

  const used = new Set();
  const edge = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const neighbours = (i) => {
    const x = i % w;
    const y = (i - x) / w;
    const out = [];
    for (let k = 0; k < 8; k += 1) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (at(nx, ny)) out.push(ny * w + nx);
    }
    return out;
  };

  const paths = [];

  const walk = (from, first) => {
    const chain = [from, first];
    used.add(edge(from, first));
    let prev = from;
    let curr = first;
    while (deg[curr] === 2) {
      const next = neighbours(curr).find((n) => n !== prev);
      if (next === undefined || used.has(edge(curr, next))) break;
      used.add(edge(curr, next));
      chain.push(next);
      prev = curr;
      curr = next;
    }
    return chain;
  };

  for (let i = 0; i < px.length; i += 1) {
    if (!px[i] || deg[i] === 2 || deg[i] === 0) continue;
    for (const n of neighbours(i)) {
      if (used.has(edge(i, n))) continue;
      paths.push(walk(i, n));
    }
  }

  // Остались кольца: у них узлов нет вовсе, только пиксели со степенью два.
  for (let i = 0; i < px.length; i += 1) {
    if (!px[i] || deg[i] !== 2) continue;
    const n = neighbours(i).find((q) => !used.has(edge(i, q)));
    if (n === undefined) continue;
    const chain = walk(i, n);
    if (chain[chain.length - 1] !== i) chain.push(i);   // замыкаем кольцо
    paths.push(chain);
  }

  return paths;
}

const chainLen = (chain, w) => {
  let s = 0;
  for (let i = 1; i < chain.length; i += 1) {
    const a = chain[i - 1];
    const b = chain[i];
    s += (Math.abs((a % w) - (b % w)) + Math.abs(Math.floor(a / w) - Math.floor(b / w))) > 1
      ? Math.SQRT2 : 1;
  }
  return s;
};

/**
 * Сварка цепочек: скелет реален, а не идеален.
 *
 * Утоньшение оставляет на пологих дугах лесенки в два пикселя, и там, где
 * должна идти одна линия, встают две развилки в пикселе друг от друга. Кольцо
 * из-за такой мелочи распадалось на полсотни обрывков. Локальной чисткой это
 * не лечится — соседи развилки связаны в обход, и любой отдельно взятый
 * пиксель выглядит нужным. Чинить надо граф:
 *
 *  1. стянуть микрозвенья между двумя развилками — они и есть лесенка;
 *  2. сшить цепочки в вершинах, где после стягивания сходятся ровно две.
 */
export function weldChains(chains, w, micro, deg) {
  const parent = new Map();
  const find = (a) => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = a;
    while (parent.has(c) && parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of chains) { parent.set(c[0], c[0]); parent.set(c[c.length - 1], c[c.length - 1]); }

  const keep = [];
  for (const c of chains) {
    const a = c[0];
    const b = c[c.length - 1];
    const bothForks = deg[a] >= 3 && deg[b] >= 3;
    if (a !== b && bothForks && chainLen(c, w) <= micro) { union(a, b); continue; }
    keep.push(c);
  }

  // Сшивка. Вершина, в которой сходятся ровно две цепочки, — не развилка,
  // а шов: разрывать в ней линию нечем. Сшивать надо до упора: каждый шов
  // может открыть следующий, и за один проход кольцо остаётся парой дуг.
  let list = keep;
  for (let pass = 0; pass < 64; pass += 1) {
    const ends = new Map();
    list.forEach((c, i) => {
      if (find(c[0]) === find(c[c.length - 1])) return;   // уже кольцо
      for (const v of [c[0], c[c.length - 1]]) {
        const k = find(v);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(i);
      }
    });

    let sewn = false;
    for (const [, pair] of ends) {
      if (pair.length !== 2 || pair[0] === pair[1]) continue;
      const [i, j] = pair;
      const A = list[i];
      const B = list[j];
      if (!A || !B) continue;
      const a = find(A[A.length - 1]) === find(B[0]) || find(A[A.length - 1]) === find(B[B.length - 1])
        ? A : [...A].reverse();
      const b = find(a[a.length - 1]) === find(B[0]) ? B : [...B].reverse();
      list[i] = a.concat(b.slice(1));
      list[j] = null;
      sewn = true;
      break;                                    // концы разъехались — пересобираем
    }
    list = list.filter(Boolean);
    if (!sewn) break;
  }

  // Кольцо после сварки кончается там же, где началось, но РАЗНЫМИ пикселями
  // лесенки. Замыкаем явно, иначе замкнутость дальше не распознать.
  return list.map((c) => (c.length > 2 && c[0] !== c[c.length - 1]
    && find(c[0]) === find(c[c.length - 1]) ? c.concat([c[0]]) : c));
}

/**
 * Отсев отростков: утоньшение плодит короткие усы на каждом утолщении и
 * скруглении. Убираем только те, что висят свободным концом, — цепочку между
 * двумя развилками трогать нельзя, это часть фигуры.
 */
export function pruneSpurs(paths, w, minLen, deg) {
  return paths.filter((chain) => {
    if (chainLen(chain, w) >= minLen) return true;
    const a = chain[0];
    const b = chain[chain.length - 1];
    return !(deg[a] === 1 || deg[b] === 1);
  });
}

/** Степени вершин скелета — нужны и отсеву, и вызывающему. */
export function degrees(px, w, h) {
  const deg = new Uint8Array(px.length);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : px[y * w + x]);
  for (let i = 0; i < px.length; i += 1) {
    if (!px[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    let n = 0;
    for (let k = 0; k < 8; k += 1) n += at(x + DX[k], y + DY[k]);
    deg[i] = n;
  }
  return deg;
}

export const DEFAULTS = {
  weld: 2,          // микрозвено между развилками короче этого — лесенка, px
  minBranch: 3,     // пол отсева отростков, пиксели исходника
  minLength: 2,     // короче этого цепочка не нужна вовсе, px
  branchShare: 0.9, // и ещё отсев по толщине штриха: доля от неё
  minShare: 0.4,    // тоньше этой доли от общей толщины — не штрих, а шум
};

/**
 * Маска → осевые линии с толщиной.
 *
 * @param {{w,h,data:Float32Array}} bin — БИНАРНАЯ маска
 * @param {number} scale — во сколько раз маска крупнее кропа
 * @returns {{points:{x,y}[], width:number, closed:boolean}[]} в crop-пространстве
 */
export function centerline(bin, scale = 1, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { w, h } = bin;
  const dist = distanceTransform(bin);
  const px = thin(bin);
  const deg = degrees(px, w, h);

  // Отсев меряется толщиной штриха, а не пикселями. Каждая ступенька на
  // границе фигуры отращивает от оси ребро длиной примерно в половину
  // толщины; на иконке в 48 px это три пикселя, на мастере в 1254 — тридцать.
  // Порог в пикселях годится только для мелких, а на мастере оставлял бы
  // десяток лишних обрывков. Толщину берём с самого скелета.
  let bulk = 0;
  {
    const vals = [];
    for (let i = 0; i < px.length; i += 1) if (px[i]) vals.push(2 * dist[i]);
    bulk = median(vals);
  }
  const cut = Math.max(o.minBranch * scale, bulk * o.branchShare);

  // Порядок важен. Усы отсекаются ДО сварки: пока они на месте, вершина с
  // усом выглядит развилкой, сшивать в ней нельзя, и кольцо остаётся десятком
  // дуг. После сварки отсеиваем ещё раз — сварка открывает новые концы.
  let paths = skeletonPaths(px, w, h);
  paths = pruneSpurs(paths, w, cut, deg);
  paths = weldChains(paths, w, o.weld * scale, deg);
  paths = pruneSpurs(paths, w, cut, deg);

  return paths
    .filter((chain) => chainLen(chain, w) >= o.minLength * scale)
    .map((chain) => ({
      points: chain.map((i) => ({ x: ((i % w) + 0.5) / scale, y: (Math.floor(i / w) + 0.5) / scale })),
      // Толщина. Расстояние меряется до ЦЕНТРА ближайшего фонового пикселя,
      // а кромка штриха лежит на полпикселя ближе, — оттого вычитаем единицу:
      // у полосы в три пикселя иначе выходило четыре.
      //
      // На ЧЁТНОЙ толщине ответ на полпикселя занижен, и починить это нечем:
      // ось такой полосы проходит между пикселями, а скелет шириной в пиксель
      // встать между ними не может и ложится на одну из двух сторон. Полоса
      // в 6 пикселей даёт 5. Врать округлением вверх хуже: тогда занижение
      // сменится завышением, а на нечётной толщине пропадёт точность.
      //
      // Медиана, а не среднее: на концах и развилках расстояние проседает,
      // и среднее занижало бы толщину тем сильнее, чем короче штрих.
      width: Math.max(1, 2 * median(chain.map((i) => dist[i])) - 1) / scale,
      closed: chain.length > 2 && chain[0] === chain[chain.length - 1],
    }))
    // Обрывки заметно тоньше самого штриха — не штрих, а бахрома по краю
    // фигуры. На нелинейной картинке их набираются сотни: у срединной оси
    // залитого пятна ветвей столько же, сколько неровностей на границе.
    .filter((line) => line.width * scale >= bulk * o.minShare);
}
