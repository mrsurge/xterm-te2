/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { C0 } from 'common/data/EscapeSequences';

const ANDROID_IME_PREFIX = '\u21dd';
const ANDROID_IME_SUFFIX = '\n\n';

export interface IAndroidInputProjection {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function createAndroidInputProjection(
  value: string,
  selectionStart: number = value.length,
  selectionEnd: number = selectionStart
): { value: string, selectionStart: number, selectionEnd: number } {
  const start = Math.min(Math.max(selectionStart, 0), value.length);
  const end = Math.min(Math.max(selectionEnd, start), value.length);
  return {
    value: `${ANDROID_IME_PREFIX}${value}${ANDROID_IME_SUFFIX}`,
    selectionStart: ANDROID_IME_PREFIX.length + start,
    selectionEnd: ANDROID_IME_PREFIX.length + end
  };
}

export function readAndroidInputProjection(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null
): IAndroidInputProjection | undefined {
  if (!value.startsWith(ANDROID_IME_PREFIX) || !value.endsWith(ANDROID_IME_SUFFIX)) {
    return undefined;
  }

  const bodyStart = ANDROID_IME_PREFIX.length;
  const bodyEnd = value.length - ANDROID_IME_SUFFIX.length;
  const body = value.substring(bodyStart, bodyEnd);
  const clampSelection = (offset: number | null): number => {
    return Math.min(Math.max((offset ?? bodyStart) - bodyStart, 0), body.length);
  };
  const start = clampSelection(selectionStart);
  const end = Math.max(start, clampSelection(selectionEnd));
  return { value: body, selectionStart: start, selectionEnd: end };
}

/**
 * Rewrites only the suffix owned by the active IME transaction. Terminal state
 * before that transaction remains owned by the PTY and is never inferred here.
 */
export function deduceAndroidInputData(previousValue: string, currentValue: string): string {
  const previous = Array.from(previousValue);
  const current = Array.from(currentValue);
  let prefixLength = 0;
  while (
    prefixLength < previous.length
    && prefixLength < current.length
    && previous[prefixLength] === current[prefixLength]
  ) {
    prefixLength++;
  }
  return C0.DEL.repeat(previous.length - prefixLength) + current.slice(prefixLength).join('');
}

/**
 * Android owns a cumulative textarea transaction. Only the latest native value
 * in an animation frame is projected into terminal input.
 */
export class AndroidInputTransaction {
  private _projection: IAndroidInputProjection = { value: '', selectionStart: 0, selectionEnd: 0 };
  private _active = false;
  private _disposed = false;
  private _generation = 0;
  private _pending = false;
  private _suppressNextInput = false;
  private _cancelFrame: (() => void) | undefined;
  private _cancelReseed: (() => void) | undefined;
  private _cancelSuppress: (() => void) | undefined;

  constructor(
    private readonly _textarea: HTMLTextAreaElement,
    private readonly _sendData: (data: string) => void
  ) {
  }

  public activate(): void {
    if (this._disposed) {
      return;
    }
    this._active = true;
    this.reset();
  }

  public deactivate(): void {
    if (!this._active) {
      return;
    }
    this.flush();
    this._active = false;
    this._cancelScheduledWork();
    this._projection = { value: '', selectionStart: 0, selectionEnd: 0 };
  }

  public keydown(ev: KeyboardEvent): boolean {
    if (!this._active) {
      this.activate();
    }
    if (ev.keyCode === 229) {
      // xterm clears its helper textarea after Enter and Ctrl+C. Gboard can
      // begin the next transaction with keyCode 229 before another ordinary
      // keydown gives us a chance to reset, so restore the guarded projection
      // before the browser inserts composition text.
      this._restoreProjectionIfMissing();
      return false;
    }
    if (
      ev.key
      && Array.from(ev.key).length === 1
      && !ev.ctrlKey
      && !ev.altKey
      && !ev.metaKey
    ) {
      // Android text is authoritative through the cumulative textarea input
      // projection. Letting xterm also process printable keydown/keypress
      // events can duplicate Gboard's post-composition commit events.
      this._restoreProjectionIfMissing();
      return false;
    }
    if (ev.keyCode === 16 || ev.keyCode === 17 || ev.keyCode === 18 || ev.keyCode === 20) {
      return true;
    }

    this.flush();
    this.reset();
    this._suppressNextInput = true;
    const handle = setTimeout(() => {
      this._cancelSuppress = undefined;
      this._suppressNextInput = false;
    }, 0);
    this._cancelSuppress = () => clearTimeout(handle);
    return true;
  }

  public handleInput(ev: InputEvent): boolean {
    if (!this._active) {
      this.activate();
    }
    if (this._suppressNextInput) {
      this._cancelSuppress?.();
      this._cancelSuppress = undefined;
      this._suppressNextInput = false;
      this.reset();
      return true;
    }

    if (ev.inputType === 'insertFromPaste' || ev.inputType === 'insertFromDrop') {
      this.reset();
      return true;
    }
    if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
      this._acceptCurrentProjection(true);
      this._sendData(C0.CR);
      this.reset();
      return true;
    }

    this._generation++;
    this._pending = true;
    this._scheduleFrame();
    return true;
  }

  public flush(): void {
    if (!this._pending) {
      return;
    }
    this._cancelFrame?.();
    this._cancelFrame = undefined;
    this._pending = false;
    this._acceptCurrentProjection(false);
  }

  public reset(): void {
    this._cancelScheduledWork();
    this._generation++;
    this._pending = false;
    this._suppressNextInput = false;
    this._projection = { value: '', selectionStart: 0, selectionEnd: 0 };
    if (this._active) {
      this._writeProjection(this._projection);
    }
  }

  public dispose(): void {
    if (this._disposed) {
      return;
    }
    this._active = false;
    this._cancelScheduledWork();
    this._projection = { value: '', selectionStart: 0, selectionEnd: 0 };
    this._disposed = true;
  }

  private _acceptCurrentProjection(stripLineBreak: boolean): void {
    let current = readAndroidInputProjection(
      this._textarea.value,
      this._textarea.selectionStart,
      this._textarea.selectionEnd
    );
    if (!current) {
      this._scheduleReseed(this._generation);
      return;
    }

    if (stripLineBreak && current.value.endsWith('\n')) {
      current = {
        value: current.value.substring(0, current.value.length - 1),
        selectionStart: Math.min(current.selectionStart, current.value.length - 1),
        selectionEnd: Math.min(current.selectionEnd, current.value.length - 1)
      };
    }
    if (current.value.includes('\r') || current.value.includes('\n')) {
      this._scheduleReseed(this._generation);
      return;
    }

    const data = deduceAndroidInputData(this._projection.value, current.value);
    this._projection = current;
    if (data) {
      this._sendData(data);
    }
    this._scheduleReseed(this._generation);
  }

  private _scheduleFrame(): void {
    if (this._cancelFrame) {
      return;
    }
    const ownerWindow = this._textarea.ownerDocument?.defaultView;
    if (ownerWindow?.requestAnimationFrame) {
      const handle = ownerWindow.requestAnimationFrame(() => {
        this._cancelFrame = undefined;
        this.flush();
      });
      this._cancelFrame = () => ownerWindow.cancelAnimationFrame(handle);
      return;
    }

    const handle = setTimeout(() => {
      this._cancelFrame = undefined;
      this.flush();
    }, 0);
    this._cancelFrame = () => clearTimeout(handle);
  }

  private _scheduleReseed(generation: number): void {
    this._cancelReseed?.();
    const handle = setTimeout(() => {
      this._cancelReseed = undefined;
      if (this._active && !this._pending && generation === this._generation) {
        this._writeProjection(this._projection);
      }
    }, 0);
    this._cancelReseed = () => clearTimeout(handle);
  }

  private _writeProjection(projection: IAndroidInputProjection): void {
    const state = createAndroidInputProjection(
      projection.value,
      projection.selectionStart,
      projection.selectionEnd
    );
    this._textarea.value = state.value;
    this._textarea.setSelectionRange(state.selectionStart, state.selectionEnd);
  }

  private _restoreProjectionIfMissing(): void {
    if (!readAndroidInputProjection(
      this._textarea.value,
      this._textarea.selectionStart,
      this._textarea.selectionEnd
    )) {
      this._writeProjection(this._projection);
    }
  }

  private _cancelScheduledWork(): void {
    this._cancelFrame?.();
    this._cancelFrame = undefined;
    this._cancelReseed?.();
    this._cancelReseed = undefined;
    this._cancelSuppress?.();
    this._cancelSuppress = undefined;
  }
}
