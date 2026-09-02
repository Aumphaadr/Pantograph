import { nodePrior, judgeNodes, sheetPrior, describeNodes, PRIORS } from '../js/glyphs/priors.js';

test('таблица покрывает кириллицу, латиницу и цифры', () => {
  for (const ch of 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    eq(Boolean(PRIORS[ch]), true, `есть «${ch}»`);
  }
});

test('прямые буквы — одни углы, кольцо — ни одного', () => {
  const H = nodePrior('Н');
  eq(H.sans, H.corners.sans, 'у «Н» сансерифа все узлы угловые');
  eq(H.serif > H.sans, true, 'антиква тяжелее: засечки');
  eq(nodePrior('О').corners.sans, 0, 'у «О» углов нет');
});

test('вердикт по коридору', () => {
  eq(judgeNodes('Н', 12), 'ok');
  eq(judgeNodes('Н', 60), 'many');
  eq(judgeNodes('Н', 4), 'few');
  eq(judgeNodes('ℵ', 4), null, 'неизвестный знак не судится');
});

test('сумма по листу считает только известные знаки', () => {
  const p = sheetPrior([...'НО', 'ℵ']);
  eq(p.known, 2);
  eq(p.sans, nodePrior('Н').sans + nodePrior('О').sans);
});

test('подпись говорит словами', () => {
  eq(describeNodes('Н', 12).startsWith('узлов 12, обычно 12'), true, describeNodes('Н', 12));
  eq(describeNodes('Н', 60).endsWith('— много'), true);
  eq(describeNodes('', 7), 'узлов 7', 'без знака — просто число');
});
