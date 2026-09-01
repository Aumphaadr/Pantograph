// editor/render.js — показ правимого контура.
//
// Растровая подложка живёт в <canvas>, вектор с узлами и рычагами — в <svg>
// поверх. SVG даёт попадание курсором даром, а с ним фокус и доступность;
// рисовать узлы на канве значило бы писать собственный hit-testing.
//
// В экранные координаты переводит ТОЛЬКО viewport (инвариант 4).

import { transform } from '../core/path.js';
import { toPathData } from '../export/svg.js';
import { key } from './ops.js';

const NS = 'http://www.w3.org/2000/svg';
const NODE_R = 3.5;
const HANDLE_R = 2.8;

const make = (name, attrs) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

const square = (p, r, cls) =>
  make('rect', { x: p.x - r, y: p.y - r, width: r * 2, height: r * 2, class: cls });

export function renderEditor(svg, { shape, selection, hover, viewport, fill, marquee }) {
  svg.replaceChildren();
  if (!shape) return;

  const screen = transform(shape, (p) => viewport.toScreen(p));

  svg.append(make('path', {
    d: toPathData(screen, 2),
    class: fill ? 'ed-path filled' : 'ed-path',
    'fill-rule': 'nonzero',
  }));

  screen.contours.forEach((c, ci) => {
    c.nodes.forEach((nd, ni) => {
      const k = key(ci, ni);
      const on = selection.has(k);

      // Рычаги показываем только у выделенных: иначе они закрывают собой контур.
      if (on) {
        for (const which of ['in', 'out']) {
          const h = nd[which];
          if (!h) continue;
          svg.append(make('line', {
            x1: nd.p.x, y1: nd.p.y, x2: h.x, y2: h.y, class: 'ed-handle-line',
          }));
          const hot = hover && hover.kind === 'handle' && hover.ci === ci
            && hover.ni === ni && hover.which === which;
          svg.append(make('circle', {
            cx: h.x, cy: h.y, r: HANDLE_R, class: `ed-handle${hot ? ' hot' : ''}`,
          }));
        }
      }

      const hot = hover && hover.kind === 'node' && hover.ci === ci && hover.ni === ni;
      const cls = ['ed-node', nd.type === 'corner' ? 'corner' : 'smooth',
        on ? 'on' : '', hot ? 'hot' : ''].filter(Boolean).join(' ');
      svg.append(square(nd.p, NODE_R, cls));
    });
  });

  if (hover && hover.kind === 'curve') {
    const p = viewport.toScreen(hover.point);
    svg.append(make('circle', { cx: p.x, cy: p.y, r: 3, class: 'ed-insert' }));
  }

  if (marquee) {
    const a = viewport.toScreen({ x: marquee.x, y: marquee.y });
    const b = viewport.toScreen({ x: marquee.x + marquee.w, y: marquee.y + marquee.h });
    svg.append(make('rect', {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y), class: 'ed-marquee',
    }));
  }
}
