// export/svg.js — ЕДИНСТВЕННОЕ место, где рождается SVG.
// Внутри системы строк-путей не существует (инвариант 3).

import { segment, segmentCount } from '../core/path.js';

const fix = (v, prec) => {
  const s = v.toFixed(prec);
  return s.replace(/\.?0+$/, '') || '0';
};

/** Shape → атрибут d. */
export function toPathData(shape, prec = 2) {
  const parts = [];
  for (const c of shape.contours) {
    if (c.nodes.length === 0) continue;
    const first = c.nodes[0].p;
    parts.push(`M${fix(first.x, prec)} ${fix(first.y, prec)}`);
    for (let i = 0; i < segmentCount(c); i += 1) {
      const [, p1, p2, p3] = segment(c, i);
      parts.push(`C${fix(p1.x, prec)} ${fix(p1.y, prec)} ${fix(p2.x, prec)} ${fix(p2.y, prec)} `
        + `${fix(p3.x, prec)} ${fix(p3.y, prec)}`);
    }
    if (c.closed) parts.push('Z');
  }
  return parts.join('');
}

/** Готовый самостоятельный файл. */
export function toSvgDocument(shape, { width, height, fill = '#000' } = {}) {
  const d = toPathData(shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" `
    + `width="${width}" height="${height}">\n`
    + `  <path d="${d}" fill="${fill}" fill-rule="nonzero"/>\n</svg>\n`;
}

const esc = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const round = (v) => Math.round(v * 100) / 100;

const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Несколько чернил — один файл, слой на группу.
 *
 * Группам проставляются inkscape:groupmode и inkscape:label: это ничего не
 * стоит, а файл тогда открывается в Inkscape настоящими слоями. Прочие
 * редакторы лишние атрибуты игнорируют.
 *
 * @param {{name:string, fg:number[], shape:object, visible?:boolean}[]} layers
 * @param {{width:number, height:number, colored?:boolean}} opts
 *   colored — заливать снятым с картинки цветом (сохранить вид) или плоским
 *   чёрным (обычный случай: иконку потом красят стилями).
 */
export function toLayeredSvg(layers, { width, height, colored = false } = {}) {
  const live = layers.filter((L) => L.visible !== false && L.shape);
  const body = live.map((L, i) => {
    const name = L.name || `Слой ${i + 1}`;
    const paint = colored ? hex(L.fg) : '#000';
    // Осевая линия без толщины — не фигура, а просто кривая, поэтому у неё
    // своё представление: путь с обводкой, а не с заливкой. Толщина у каждого
    // контура своя, так что и путь на контур свой.
    const inner = L.shape.contours.some((c) => c.width)
      ? L.shape.contours.map((c) => `    <path d="${toPathData({ contours: [c] })}" fill="none"`
        + ` stroke="${paint}" stroke-width="${round(c.width)}"`
        + ' stroke-linecap="round" stroke-linejoin="round"/>').join('\n')
      : `    <path d="${toPathData(L.shape)}" fill="${paint}" fill-rule="nonzero"/>`;
    return `  <g inkscape:groupmode="layer" inkscape:label="${esc(name)}" id="layer${i + 1}">\n`
      + `${inner}\n  </g>`;
  }).join('\n');
  return '<svg xmlns="http://www.w3.org/2000/svg" '
    + 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
    + `viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n`
    + `${body}\n</svg>\n`;
}
