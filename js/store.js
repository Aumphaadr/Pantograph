// store.js — состояние и оповещение. Логики здесь нет и не будет.
//
// Темы по мере роста проекта: source params shape glyphs metrics selection ui.
// Сейчас живут только те, что нужны нулевому этапу.

const state = {
  source: null,   // { bitmap, w, h, name } — исходная картинка
  crop:   null,   // { rect, imageData } — rect в image-пространстве, целые пиксели
  ui:     { tool: 'crop', busy: false, message: null },
};

const subs = new Map();

export function get(topic) {
  if (!(topic in state)) throw new Error(`store: нет темы «${topic}»`);
  return state[topic];
}

/** Заменить тему целиком (для null-able) или домешать патч в объект. */
export function set(topic, value) {
  if (!(topic in state)) throw new Error(`store: нет темы «${topic}»`);
  const prev = state[topic];
  if (value !== null && typeof value === 'object' && prev !== null && typeof prev === 'object'
      && !Array.isArray(value)) {
    state[topic] = { ...prev, ...value };
  } else {
    state[topic] = value;
  }
  notify(topic);
}

export function subscribe(topic, fn) {
  if (!(topic in state)) throw new Error(`store: нет темы «${topic}»`);
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}

function notify(topic) {
  const set_ = subs.get(topic);
  if (!set_) return;
  for (const fn of [...set_]) {
    try {
      fn(state[topic]);
    } catch (err) {
      // Подписчик не должен ронять остальных.
      console.error(`store: подписчик темы «${topic}» упал`, err);
    }
  }
}
