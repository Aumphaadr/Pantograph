// ui/icons.js — значки интерфейса. Все они из набора Klaarheid Icons: копии
// файлов лежат в icons/klaarheid/, разметку собирает tools/sync-icons.mjs в
// ./icon-data.js. Значок рисуется встроенным <svg> и красится цветом текста
// (currentColor), поэтому следует теме и состояниям кнопки сам.
//
// В разметке страницы место значка — <span data-icon="имя">, его заменяет
// mountIcons(); в коде — icon('имя'). Страж tests/icons.test.js проверяет,
// что каждое имя из кода лежит в наборе.

import { ICONS, ICON_VIEWBOX } from './icon-data.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Значок как элемент <svg class="ico">. Подпись у значка не своя: её несёт
 * кнопка (title, aria-label), поэтому сам он от чтения с экрана скрыт.
 *
 * @param {string} name — имя значка набора
 * @param {string} [cls] — добавочный класс
 */
export function icon(name, cls = '') {
  const markup = ICONS[name];
  if (!markup) throw new Error(`значка «${name}» нет в icons/klaarheid — npm run icons:sync -- <набор> ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('class', cls ? `ico ${cls}` : 'ico');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = markup;
  return svg;
}

/** Поставить в элемент один значок вместо всего содержимого. */
export function setIcon(host, name, cls = '') {
  host.replaceChildren(icon(name, cls));
}

/** Заменить места <span data-icon="имя" class="…"> значками, классы переносятся. */
export function mountIcons(root = document) {
  for (const spot of root.querySelectorAll('[data-icon]')) {
    spot.replaceWith(icon(spot.dataset.icon, spot.getAttribute('class') ?? ''));
  }
}
