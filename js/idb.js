// idb.js — хранилище проекта в браузере.
//
// Обёртка тонкая нарочно: нужен один снимок под одним ключом, а не база.
// Всякое обращение может не удаться (приватный режим, запрет на хранилище),
// и это не повод ронять приложение — работа просто не сохранится.

const DB = 'pantograph';
const STORE = 'projects';
const KEY = 'current';

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('хранилище недоступно')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('не удалось открыть хранилище'));
  });
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  }));
}

export const saveLocal = (record) => run('readwrite', (s) => s.put(record, KEY));
export const loadLocal = () => run('readonly', (s) => s.get(KEY));
export const clearLocal = () => run('readwrite', (s) => s.delete(KEY));
