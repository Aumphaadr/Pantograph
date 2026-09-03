// export/svg.js — ЕДИНСТВЕННОЕ место, где рождается SVG.
// Внутри системы строк-путей не существует (инвариант 3).

import { segment, segmentCount } from '../core/path.js';
import { piecesToPathData } from '../assemble/pieces.js';
import { piecesOf } from '../assemble/assemble.js';

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

// ─── сборка из примитивов ───────────────────────────────────────────────────


const deg = (rad) => round((rad * 180) / Math.PI);

/**
 * Сборка → SVG с настоящими примитивами: <circle>, <rect rx>, <line>,
 * <polyline>, <polygon>, <path> из отрезков и дуг; пятна — заливкой.
 * Толщина штриха одна на сборку (монолайн), цвет — currentColor.
 *
 * @param {{parts:object[], width:number}} asm — в пикселях кропа
 * @param {{width:number, height:number, box?:number, prec?:number}} opts
 *   box — если задан, кроп отображается в viewBox 0 0 box box
 */
export function toAssemblySvg(asm, { width, height, box = null, prec = 2 } = {}) {
  const s = box ? box / Math.max(width, height) : 1;
  const f = (v) => {
    const t = (v * s).toFixed(prec);
    return t.replace(/\.?0+$/, '') || '0';
  };
  const P = (p) => `${f(p.x)} ${f(p.y)}`;
  const body = asm.parts.map((part) => {
    switch (part.kind) {
      case 'blob': {
        if (part.circle) return `  <circle cx="${f(part.circle.c.x)}" cy="${f(part.circle.c.y)}" r="${f(part.circle.r)}" fill="currentColor" stroke="none"/>`;
        const local = { contours: part.shape.contours.map((c) => ({ ...c, nodes: c.nodes.map((nd) => ({
          p: { x: nd.p.x * s, y: nd.p.y * s }, in: nd.in && { x: nd.in.x * s, y: nd.in.y * s }, out: nd.out && { x: nd.out.x * s, y: nd.out.y * s }, type: nd.type })) })) };
        return `  <path d="${toPathData(local, prec)}" fill="currentColor" stroke="none"/>`;
      }
      case 'circle': return `  <circle cx="${f(part.c.x)}" cy="${f(part.c.y)}" r="${f(part.r)}"/>`;
      case 'rect':
      case 'roundRect': {
        const x = part.c.x - part.w / 2;
        const y = part.c.y - part.h / 2;
        const rot = Math.abs(part.angle ?? 0) > 1e-4 ? ` transform="rotate(${deg(part.angle)} ${f(part.c.x)} ${f(part.c.y)})"` : '';
        const rx = part.r > 0 ? ` rx="${f(part.r)}"` : '';
        return `  <rect x="${f(x)}" y="${f(y)}" width="${f(part.w)}" height="${f(part.h)}"${rx}${rot}/>`;
      }
      case 'line': return `  <line x1="${f(part.a.x)}" y1="${f(part.a.y)}" x2="${f(part.b.x)}" y2="${f(part.b.y)}"/>`;
      case 'polyline': return `  <polyline points="${part.points.map(P).join(' ')}"/>`;
      case 'polygon': return `  <polygon points="${part.corners.map(P).join(' ')}"/>`;
      case 'roundPolygon': {
        const scaled = piecesOf(part).map((p) => (p.kind === 'line'
          ? { ...p, a: { x: p.a.x * s, y: p.a.y * s }, b: { x: p.b.x * s, y: p.b.y * s } }
          : { ...p, r: p.r * s, a: { x: p.a.x * s, y: p.a.y * s }, b: { x: p.b.x * s, y: p.b.y * s } }));
        return `  <path d="${piecesToPathData(scaled, true, prec)}"/>`;
      }
      default: {
        const scaled = part.pieces.map((p) => (p.kind === 'line'
          ? { ...p, a: { x: p.a.x * s, y: p.a.y * s }, b: { x: p.b.x * s, y: p.b.y * s } }
          : { ...p, r: p.r * s, a: { x: p.a.x * s, y: p.a.y * s }, b: { x: p.b.x * s, y: p.b.y * s } }));
        return `  <path d="${piecesToPathData(scaled, part.closed, prec)}"/>`;
      }
    }
  }).join('\n');
  const vb = box ? `0 0 ${box} ${box}` : `0 0 ${width} ${height}`;
  const size = box ? `width="${box}" height="${box}"` : `width="${width}" height="${height}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" ${size} fill="none" stroke="currentColor" `
    + `stroke-width="${f(asm.width)}" stroke-linecap="round" stroke-linejoin="round">\n${body}\n</svg>\n`;
}
