/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import {
  AndroidInputTransaction,
  createAndroidInputProjection,
  deduceAndroidInputData,
  readAndroidInputProjection
} from 'browser/input/AndroidInputTransaction';
import { C0 } from 'common/data/EscapeSequences';

function createTextarea(): HTMLTextAreaElement {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start: number, end: number): void {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  } as HTMLTextAreaElement;
}

function writeProjection(textarea: HTMLTextAreaElement, value: string, selection: number = value.length): void {
  const projection = createAndroidInputProjection(value, selection, selection);
  textarea.value = projection.value;
  textarea.setSelectionRange(projection.selectionStart, projection.selectionEnd);
}

describe('AndroidInputTransaction', () => {
  it('round trips the guarded textarea projection and selection', () => {
    const state = createAndroidInputProjection('hello', 2, 4);
    assert.deepEqual(readAndroidInputProjection(state.value, state.selectionStart, state.selectionEnd), {
      value: 'hello',
      selectionStart: 2,
      selectionEnd: 4
    });
    assert.isUndefined(readAndroidInputProjection('hello', 2, 2));
  });

  it('rewrites the changed suffix without touching prior terminal state', () => {
    assert.equal(deduceAndroidInputData('', 'hello'), 'hello');
    assert.equal(deduceAndroidInputData('hello', 'hallo'), `${C0.DEL.repeat(4)}allo`);
    assert.equal(deduceAndroidInputData('typing', 'type'), `${C0.DEL.repeat(3)}e`);
  });

  it('counts Unicode code points instead of UTF-16 code units when erasing', () => {
    assert.equal(deduceAndroidInputData('a😀', 'a😃'), `${C0.DEL}😃`);
  });

  it('coalesces cumulative native values and emits through one terminal data transaction', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    writeProjection(textarea, 'hel');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);
    writeProjection(textarea, 'hello');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['hello']);
    transaction.dispose();
  });

  it('emits suffix erasure and replacement for live recomposition', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    writeProjection(textarea, 'voice');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);
    transaction.flush();
    writeProjection(textarea, 'voiced');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);
    transaction.flush();
    writeProjection(textarea, 'voice');
    transaction.handleInput({ inputType: 'deleteCompositionText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['voice', 'd', C0.DEL]);
    transaction.dispose();
  });

  it('commits pending text before translating a native line break to carriage return', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    writeProjection(textarea, 'echo ok\n', 'echo ok\n'.length);
    transaction.handleInput({ inputType: 'insertLineBreak' } as InputEvent);

    assert.deepEqual(handled, ['echo ok', C0.CR]);
    transaction.dispose();
  });

  it('leaves key-driven input to xterm and suppresses its following DOM input event', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    assert.isTrue(transaction.keydown({ keyCode: 13 } as KeyboardEvent));
    writeProjection(textarea, '\n', 1);
    transaction.handleInput({ inputType: 'insertLineBreak' } as InputEvent);
    assert.deepEqual(handled, []);
    assert.isFalse(transaction.keydown({ keyCode: 229 } as KeyboardEvent));
    transaction.dispose();
  });

  it('owns printable Android text through textarea input instead of key events', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    assert.isFalse(transaction.keydown({ key: 'a', keyCode: 65 } as KeyboardEvent));
    writeProjection(textarea, 'a');
    transaction.handleInput({ inputType: 'insertText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['a']);
    transaction.dispose();
  });

  it('coalesces a post-composition printable key echo into one input', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    writeProjection(textarea, '-');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);

    // Gboard can echo the committed composition as keydown/keypress/insertText.
    // Android mode must leave those printable key events to the textarea.
    textarea.setSelectionRange(1, 2);
    assert.isFalse(transaction.keydown({ key: '-', keyCode: 0 } as KeyboardEvent));
    transaction.handleInput({ inputType: 'insertText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['-']);
    transaction.dispose();
  });

  it('restores the guard before a keyCode 229 composition after xterm clears the textarea', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    // xterm's ordinary Enter handling clears the helper after the Android
    // transaction has reset its internal projection.
    textarea.value = '';
    textarea.setSelectionRange(0, 0);

    assert.isFalse(transaction.keydown({ keyCode: 229 } as KeyboardEvent));
    assert.deepEqual(readAndroidInputProjection(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    ), {
      value: '',
      selectionStart: 0,
      selectionEnd: 0
    });

    writeProjection(textarea, 'j');
    transaction.handleInput({ inputType: 'insertCompositionText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['j']);
    transaction.dispose();
  });

  it('restores the guard before ordinary printable input after xterm clears the textarea', () => {
    const textarea = createTextarea();
    const handled: string[] = [];
    const transaction = new AndroidInputTransaction(textarea, data => handled.push(data));
    transaction.activate();

    textarea.value = '';
    textarea.setSelectionRange(0, 0);

    assert.isFalse(transaction.keydown({ key: 'h', keyCode: 72 } as KeyboardEvent));
    assert.deepEqual(readAndroidInputProjection(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd
    ), {
      value: '',
      selectionStart: 0,
      selectionEnd: 0
    });

    writeProjection(textarea, 'h');
    transaction.handleInput({ inputType: 'insertText' } as InputEvent);
    transaction.flush();

    assert.deepEqual(handled, ['h']);
    transaction.dispose();
  });
});
