import {
  VERSION, snapshot, restore, codesFit, exportBundle, importBundle,
} from '../js/project.js';

const state = () => ({
  imageName: 'картинка.png',
  crop: { x: 361, y: 277, w: 525, h: 46 },
  route: 'font',
  params: { tolerance: 70, upscale: 6, level: 0.5 },
  colors: { fg: [248, 187, 74], bg: [8, 8, 8] },
  phase: 'derived',
  shape: { contours: [{ closed: true, nodes: [] }] },
  text: 'ГОРНАЯ ДОЛИНА',
  codes: [1060, 1054, 1056],
  glyphCount: 3,
  manualGroups: [[0, 1], [2]],
  guides: { capHeight: 3, xHeight: 12.5, baseline: 37, descender: 44 },
  metrics: { capUnits: 700, sideBearing: 72, spaceUnits: 484 },
  fontName: 'Горная Долина',
  fontSample: 'проба',
});

// ─── снимок ─────────────────────────────────────────────────────────────────

test('в снимок попадают входы и решения', () => {
  const s = snapshot(state());
  eq(s.version, VERSION);
  eq(s.crop, { x: 361, y: 277, w: 525, h: 46 });
  eq(s.text, 'ГОРНАЯ ДОЛИНА');
  eq(s.font.name, 'Горная Долина');
  eq(s.guides.baseline, 37);
});

test('производный контур не сохраняется — он кэш параметров', () => {
  eq(snapshot(state()).detachedShape, null);
});

test('отчуждённый контур сохраняется — он уже принадлежит человеку', () => {
  const s = snapshot({ ...state(), phase: 'detached' });
  eq(s.detachedShape !== null, true);
});

test('снимок не держит ссылок на исходные объекты', () => {
  const st = state();
  const s = snapshot(st);
  st.crop.x = 0;
  st.codes.push(9);
  st.colors.fg[0] = 0;
  eq(s.crop.x, 361, 'кроп скопирован');
  eq(s.codes.length, 3, 'коды скопированы');
  eq(s.colors.fg[0], 248, 'цвета скопированы');
});

// ─── восстановление ─────────────────────────────────────────────────────────

test('снимок восстанавливается обратно', () => {
  const r = restore(snapshot(state()));
  eq(r.crop, { x: 361, y: 277, w: 525, h: 46 });
  eq(r.route, 'font');
  eq(r.metrics.sideBearing, 72);
  eq(r.manualGroups, [[0, 1], [2]]);
});

test('чужая версия отвергается внятно', () => {
  let msg = '';
  try { restore({ version: 99 }); } catch (e) { msg = e.message; }
  eq(msg.includes('версии 99'), true, `сказано: ${msg}`);
});

test('пустой или не-объект отвергается', () => {
  for (const bad of [null, undefined, 'строка', 42]) {
    let threw = false;
    try { restore(bad); } catch { threw = true; }
    eq(threw, true, `${bad} отвергнут`);
  }
});

test('испорченный кроп отвергается, а не восстанавливается наполовину', () => {
  let msg = '';
  try { restore({ version: VERSION, crop: { x: 1, y: 2 } }); } catch (e) { msg = e.message; }
  eq(msg.includes('кропа'), true, `сказано: ${msg}`);
});

test('недостающие поля заменяются разумными умолчаниями', () => {
  const r = restore({ version: VERSION });
  eq(r.route, 'icon');
  eq(r.codes, []);
  eq(r.font.name, 'Пантограф');
  eq(r.crop, null);
});

// ─── привязка ───────────────────────────────────────────────────────────────

test('привязка годится только при том же числе букв', () => {
  const saved = { glyphCount: 13, codes: new Array(13).fill(65) };
  eq(codesFit(saved, 13), true);
  eq(codesFit(saved, 12), false, 'букв стало меньше — привязка съехала бы');
  eq(codesFit({ glyphCount: 13, codes: [] }, 13), false, 'кодов нет — нечего применять');
});

// ─── перенос одним файлом ───────────────────────────────────────────────────

test('проект уходит в архив и возвращается целым', async () => {
  const rec = snapshot(state());
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])]);
  const bundle = await exportBundle(rec, png);
  const back = await importBundle(bundle);
  eq(back.record.text, 'ГОРНАЯ ДОЛИНА');
  eq(back.record.guides.baseline, 37);
  eq(back.imageBlob !== null, true, 'картинка вернулась');
  eq(new Uint8Array(await back.imageBlob.arrayBuffer())[1], 80, 'и байты те же');
});

test('проект без картинки тоже переносится', async () => {
  const back = await importBundle(await exportBundle(snapshot(state()), null));
  eq(back.imageBlob, null);
  eq(back.record.route, 'font');
});

test('архив без файла проекта отвергается внятно', async () => {
  const { makeZip } = await import('../js/export/zip.js');
  let msg = '';
  try { await importBundle(await makeZip([{ name: 'чужое.txt', data: 'x' }])); }
  catch (e) { msg = e.message; }
  eq(msg.includes('не файл проекта'), true, `сказано: ${msg}`);
});
