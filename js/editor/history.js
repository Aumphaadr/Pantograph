// editor/history.js — отмена и повтор снимками.
//
// Снимками, а не обратными операциями: Shape маленький (сотни узлов), а
// обратные операции пришлось бы писать и отлаживать к каждой правке отдельно.
//
// begin() и end() оборачивают перетаскивание, чтобы движение мышью стало одним
// шагом отмены, а не сорока.

export function createHistory(limit = 100) {
  let stack = [];
  let index = -1;
  let inTxn = false;

  const trim = () => {
    if (stack.length > limit) {
      const cut = stack.length - limit;
      stack = stack.slice(cut);
      index -= cut;
    }
  };

  return {
    reset(state) { stack = [state]; index = 0; inTxn = false; },

    /** Записать состояние как отдельный шаг. Внутри транзакции — не записывать. */
    push(state) {
      if (inTxn) return;
      stack = stack.slice(0, index + 1);
      stack.push(state);
      index = stack.length - 1;
      trim();
    },

    begin() { inTxn = true; },

    /** Закрыть транзакцию одним шагом. Если состояние не изменилось — шага нет. */
    end(state) {
      if (!inTxn) return;
      inTxn = false;
      if (stack[index] === state) return;
      this.push(state);
    },

    undo() { return index > 0 ? stack[(index -= 1)] : null; },
    redo() { return index < stack.length - 1 ? stack[(index += 1)] : null; },

    get canUndo() { return index > 0; },
    get canRedo() { return index < stack.length - 1; },
    get depth() { return stack.length; },
    get current() { return index >= 0 ? stack[index] : null; },
  };
}
