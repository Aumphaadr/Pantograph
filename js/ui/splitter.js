// ui/splitter.js — разделитель между столом и панелью.
//
// Ширина панели живёт в переменной CSS: вёрстка сеточная, менять надо одно
// число. Тянется мышью, слушается клавиатуры, помнится между сеансами.

import { setIcon } from './icons.js';

const KEY = 'pantograph.panelWidth';
const MIN = 240;
const STEP = 16;

const clamp = (w, deflt) => {
  const max = Math.max(MIN, Math.round(window.innerWidth * 0.62));
  if (!Number.isFinite(w)) return deflt;
  return Math.max(MIN, Math.min(max, Math.round(w)));
};

function load(deflt) {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? deflt : clamp(Number(raw), deflt);
  } catch {
    return deflt;   // приватный режим, запрет на хранилище — не беда
  }
}

const save = (w) => { try { localStorage.setItem(KEY, String(w)); } catch { /* не беда */ } };

/**
 * @param {{el:HTMLElement, host:HTMLElement, toggle?:HTMLElement,
 *          deflt?:number, onResize?:Function}} opts
 *   el — сам разделитель, host — элемент, на котором живёт переменная.
 */
export function createSplitter({ el, host, toggle, deflt = 340, onResize = () => {} }) {
  let width = load(deflt);
  let collapsed = false;
  let restore = width;
  let drag = null;

  const apply = () => {
    host.style.setProperty('--panel-w', `${collapsed ? 0 : width}px`);
    el.setAttribute('aria-valuenow', String(collapsed ? 0 : width));
    el.classList.toggle('collapsed', collapsed);
    if (toggle) {
      setIcon(toggle, collapsed ? 'chevron-left' : 'chevron-right');
      toggle.title = collapsed ? 'Показать панель' : 'Свернуть панель';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    onResize();
  };

  const setWidth = (w, remember = true) => {
    width = clamp(w, deflt);
    collapsed = false;
    if (remember) save(width);
    apply();
  };

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, from: collapsed ? 0 : width };
    try { el.setPointerCapture(ev.pointerId); } catch { /* синтетика */ }
    el.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    ev.preventDefault();
  });

  el.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    setWidth(drag.from - (ev.clientX - drag.x), false);
  });

  for (const type of ['pointerup', 'pointercancel']) {
    el.addEventListener(type, (ev) => {
      if (!drag) return;
      drag = null;
      try { el.releasePointerCapture(ev.pointerId); } catch { /* уже отпущен */ }
      el.classList.remove('dragging');
      document.body.style.cursor = '';
      save(width);
    });
  }

  // Двойной щелчок возвращает умолчание.
  el.addEventListener('dblclick', () => setWidth(deflt));

  // Тянуть мышью — не единственный способ работать.
  el.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? STEP * 3 : STEP;
    if (ev.key === 'ArrowLeft') setWidth((collapsed ? 0 : width) + step);
    else if (ev.key === 'ArrowRight') setWidth((collapsed ? 0 : width) - step);
    else if (ev.key === 'Home') setWidth(deflt);
    else if (ev.key === 'Enter' || ev.key === ' ') toggleCollapse();
    else return;
    ev.preventDefault();
  });

  function toggleCollapse() {
    if (collapsed) { collapsed = false; width = restore; } else { restore = width; collapsed = true; }
    apply();
  }

  if (toggle) {
    toggle.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCollapse(); });
  }

  window.addEventListener('resize', () => { width = clamp(width, deflt); apply(); });

  apply();
  return { get width() { return collapsed ? 0 : width; }, setWidth, toggleCollapse };
}
