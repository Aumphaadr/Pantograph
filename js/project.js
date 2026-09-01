// project.js — что именно считается работой и как её сохранить.
//
// Сохраняются ВХОДЫ и РЕШЕНИЯ, а не всё подряд. Маски, контуры и разбор на
// буквы — производное: они пересчитываются из тех же параметров и выходят
// теми же. Класть их в файл значило бы хранить кэш и потом гадать, не
// разошёлся ли он с кодом.
//
// Исключение — отчуждённый контур: он уже принадлежит человеку и никакими
// параметрами не восстанавливается (ARCHITECTURE.md, п. 4).

import { makeZip, readZip } from './export/zip.js';

export const VERSION = 1;
const JSON_NAME = 'проект.json';
const IMAGE_NAME = 'исходник.png';

/**
 * Состояние приложения → простой объект. Картинка отдельно: она блоб,
 * а не JSON, и в архиве лежит своим файлом.
 */
export function snapshot(state) {
  return {
    version: VERSION,
    savedAt: new Date().toISOString(),
    image: { name: state.imageName ?? 'картинка.png' },
    crop: state.crop ? { ...state.crop } : null,
    route: state.route ?? 'icon',
    params: { ...state.params },
    colors: { fg: [...state.colors.fg], bg: [...state.colors.bg] },
    // Чернила — решение человека, а не кэш параметров: цвет снят пипеткой,
    // допуск подобран на глаз. Контуры слоёв не храним, они пересчитаются.
    layers: (state.layers ?? []).map((L) => ({
      id: L.id, name: L.name, fg: [...L.fg], tolerance: L.tolerance, visible: L.visible !== false,
    })),
    exclusive: state.exclusive !== false,
    stroke: Boolean(state.stroke),
    // Правки контура: только если он отчуждён — иначе это кэш параметров.
    detachedShape: state.phase === 'detached' ? state.shape : null,
    text: state.text ?? '',
    codes: state.codes ? [...state.codes] : [],
    glyphCount: state.glyphCount ?? 0,
    manualGroups: state.manualGroups ? state.manualGroups.map((g) => [...g]) : null,
    // Правки контуров букв — решения человека, позиционные, как codes.
    glyphEdits: state.glyphEdits ? state.glyphEdits.map(([i, sh]) => [i, sh]) : [],
    guides: state.guides ? { ...state.guides } : null,
    metrics: state.metrics ? { ...state.metrics } : null,
    font: { name: state.fontName ?? 'Пантограф', sample: state.fontSample ?? '' },
  };
}

const isRect = (r) => r && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(r[k]));

/**
 * Обратно, с проверкой. Файл мог прийти из другой версии или быть испорчен —
 * лучше отказать внятно, чем восстановить половину и молчать.
 */
export function restore(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Файл проекта пуст или испорчен.');
  if (raw.version !== VERSION) {
    throw new Error(`Файл проекта версии ${raw.version ?? '?'}, а нужна ${VERSION}.`);
  }
  if (raw.crop && !isRect(raw.crop)) throw new Error('В файле проекта испорчен прямоугольник кропа.');

  return {
    version: raw.version,
    savedAt: raw.savedAt ?? null,
    imageName: raw.image?.name ?? 'картинка.png',
    crop: raw.crop ? { ...raw.crop } : null,
    route: raw.route === 'font' ? 'font' : 'icon',
    params: { ...(raw.params ?? {}) },
    colors: {
      fg: [...(raw.colors?.fg ?? [232, 183, 90])],
      bg: [...(raw.colors?.bg ?? [15, 16, 18])],
    },
    layers: (Array.isArray(raw.layers) ? raw.layers : [])
      .filter((L) => L && Array.isArray(L.fg) && L.fg.length === 3)
      .map((L, i) => ({
        id: String(L.id ?? `L${i + 1}`),
        name: String(L.name ?? `Цвет ${i + 1}`),
        fg: L.fg.map((v) => Math.max(0, Math.min(255, Number(v) || 0))),
        tolerance: Number.isFinite(L.tolerance) ? L.tolerance : 70,
        visible: L.visible !== false,
        shape: null,
      })),
    exclusive: raw.exclusive !== false,
    stroke: Boolean(raw.stroke),
    detachedShape: raw.detachedShape ?? null,
    text: String(raw.text ?? ''),
    codes: Array.isArray(raw.codes) ? raw.codes.slice() : [],
    glyphCount: Number(raw.glyphCount) || 0,
    manualGroups: Array.isArray(raw.manualGroups) ? raw.manualGroups.map((g) => [...g]) : null,
    glyphEdits: (Array.isArray(raw.glyphEdits) ? raw.glyphEdits : [])
      .filter((e) => Array.isArray(e) && Number.isInteger(e[0]) && e[1] && Array.isArray(e[1].contours)),
    guides: raw.guides ?? null,
    metrics: raw.metrics ?? null,
    font: { name: raw.font?.name ?? 'Пантограф', sample: raw.font?.sample ?? '' },
  };
}

/**
 * Привязка букв к символам позиционна, поэтому годится только если разбор
 * дал столько же букв, сколько было при сохранении. Иначе она молча
 * съехала бы на соседние буквы — лучше сложить заново из текста.
 */
export const codesFit = (saved, count) =>
  saved.glyphCount === count && saved.codes.length === count;

/** Проект одним файлом: json плюс исходная картинка. */
export async function exportBundle(record, imageBlob) {
  const json = JSON.stringify(record, null, 2);
  const files = [{ name: JSON_NAME, data: json }];
  if (imageBlob) {
    files.push({ name: IMAGE_NAME, data: new Uint8Array(await imageBlob.arrayBuffer()) });
  }
  return makeZip(files);
}

export async function importBundle(blob) {
  const files = await readZip(blob);
  const json = files.get(JSON_NAME);
  if (!json) throw new Error(`В архиве нет «${JSON_NAME}» — это не файл проекта.`);
  const record = restore(JSON.parse(new TextDecoder().decode(json)));
  const image = files.get(IMAGE_NAME);
  return { record, imageBlob: image ? new Blob([image], { type: 'image/png' }) : null };
}
