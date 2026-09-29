// ui/hints.js — подсказки к настройкам.
//
// Не `title`: браузер показывает его через секунду, мелким шрифтом и никогда
// с клавиатуры. Своя всплывашка открывается по наведению, по фокусу и по
// щелчку — на сенсорном экране наведения нет вовсе.
//
// Всплывашка живёт в конце body: панель прокручивается и обрезает всё, что
// вылезает за её край.

import { icon } from './icons.js';

let pop = null;
let owner = null;
let seq = 0;

function ensure() {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.className = 'hint-pop';
  pop.setAttribute('role', 'tooltip');
  pop.hidden = true;
  document.body.append(pop);
  return pop;
}

function place(btn) {
  const p = ensure();
  const b = btn.getBoundingClientRect();
  const r = p.getBoundingClientRect();
  const left = Math.max(8, Math.min(b.left + b.width / 2 - r.width / 2,
    window.innerWidth - r.width - 8));
  const above = b.top - r.height - 8;
  p.style.left = `${Math.round(left)}px`;
  p.style.top = `${Math.round(above >= 8 ? above : b.bottom + 8)}px`;
  p.classList.toggle('below', above < 8);
}

export function showHint(btn) {
  const text = btn.dataset.hint;
  if (!text) return;
  const p = ensure();
  p.textContent = text;
  p.hidden = false;
  if (!btn.id) { seq += 1; btn.id = `hint-btn-${seq}`; }
  p.id = `${btn.id}-tip`;
  btn.setAttribute('aria-describedby', p.id);
  owner = btn;
  place(btn);
}

export function hideHint(btn) {
  if (btn && btn !== owner) return;
  if (owner) owner.removeAttribute('aria-describedby');
  owner = null;
  if (pop) pop.hidden = true;
}

/** Кнопка-вопрос рядом с названием настройки. */
export function hintButton(text) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hint';
  b.dataset.hint = text;
  b.append(icon('circle-question'));
  b.setAttribute('aria-label', 'Что это');
  return b;
}

/** Один набор слушателей на всё дерево: кнопок много, а поведение одно. */
export function installHints(root = document) {
  const near = (ev) => ev.target.closest?.('.hint');

  root.addEventListener('pointerover', (ev) => { const b = near(ev); if (b) showHint(b); });
  root.addEventListener('pointerout', (ev) => {
    const b = near(ev);
    if (b && !b.matches(':focus-visible')) hideHint(b);
  });
  root.addEventListener('focusin', (ev) => { const b = near(ev); if (b) showHint(b); });
  root.addEventListener('focusout', (ev) => { const b = near(ev); if (b) hideHint(b); });

  root.addEventListener('click', (ev) => {
    const b = near(ev);
    if (!b) { hideHint(); return; }
    ev.preventDefault();
    if (owner === b && !pop.hidden) hideHint(b); else showHint(b);
  });

  root.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideHint(); });
  window.addEventListener('scroll', () => hideHint(), true);
}
