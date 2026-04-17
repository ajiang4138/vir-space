import * as Y from "yjs";

const REMOTE_UPDATE_ORIGIN = Symbol("editor-crdt-remote");

type TextChangedCallback = (nextText: string) => void;
type LocalUpdateCallback = (updateBase64: string) => void;

function encodeUpdateBase64(update: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < update.length; index += chunkSize) {
    const chunk = update.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function decodeUpdateBase64(updateBase64: string): Uint8Array {
  const binary = atob(updateBase64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function computeDiffRange(currentText: string, nextText: string): {
  prefixLength: number;
  suffixLength: number;
} {
  const currentLength = currentText.length;
  const nextLength = nextText.length;
  let prefixLength = 0;

  while (
    prefixLength < currentLength &&
    prefixLength < nextLength &&
    currentText.charCodeAt(prefixLength) === nextText.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  const maxSuffix = Math.min(currentLength - prefixLength, nextLength - prefixLength);

  while (
    suffixLength < maxSuffix &&
    currentText.charCodeAt(currentLength - 1 - suffixLength) === nextText.charCodeAt(nextLength - 1 - suffixLength)
  ) {
    suffixLength += 1;
  }

  return { prefixLength, suffixLength };
}

export class EditorCrdtManager {
  private roomId: string | null = null;
  private doc: Y.Doc | null = null;
  private text: Y.Text | null = null;
  private textCallbacks = new Set<TextChangedCallback>();
  private localUpdateCallbacks = new Set<LocalUpdateCallback>();
  private textObserver: ((event: Y.YTextEvent) => void) | null = null;
  private docUpdateObserver: ((update: Uint8Array, origin: unknown) => void) | null = null;

  init(roomId: string): void {
    if (this.doc && this.text && this.roomId === roomId) {
      return;
    }

    this.dispose();

    const doc = new Y.Doc();
    const text = doc.getText("shared-editor-text");

    this.textObserver = () => {
      const nextText = text.toString();
      for (const callback of this.textCallbacks) {
        callback(nextText);
      }
    };
    text.observe(this.textObserver);

    this.docUpdateObserver = (update, origin) => {
      if (origin === REMOTE_UPDATE_ORIGIN) {
        return;
      }

      const encodedUpdate = encodeUpdateBase64(update);
      for (const callback of this.localUpdateCallbacks) {
        callback(encodedUpdate);
      }
    };
    doc.on("update", this.docUpdateObserver);

    this.doc = doc;
    this.text = text;
    this.roomId = roomId;
  }

  dispose(): void {
    if (this.text && this.textObserver) {
      this.text.unobserve(this.textObserver);
    }

    if (this.doc && this.docUpdateObserver) {
      this.doc.off("update", this.docUpdateObserver);
    }

    this.doc?.destroy();
    this.doc = null;
    this.text = null;
    this.roomId = null;
    this.textObserver = null;
    this.docUpdateObserver = null;
    this.textCallbacks.clear();
    this.localUpdateCallbacks.clear();
  }

  getText(): string {
    return this.text?.toString() ?? "";
  }

  applyLocalText(nextText: string): void {
    if (!this.doc || !this.text) {
      return;
    }

    const currentText = this.text.toString();
    if (currentText === nextText) {
      return;
    }

    const { prefixLength, suffixLength } = computeDiffRange(currentText, nextText);
    const currentReplaceEnd = currentText.length - suffixLength;
    const nextReplaceEnd = nextText.length - suffixLength;

    this.doc.transact(() => {
      const deleteLength = currentReplaceEnd - prefixLength;
      if (deleteLength > 0) {
        this.text?.delete(prefixLength, deleteLength);
      }

      const insertSlice = nextText.slice(prefixLength, nextReplaceEnd);
      if (insertSlice.length > 0) {
        this.text?.insert(prefixLength, insertSlice);
      }
    }, null);
  }

  applyRemoteUpdate(updateBase64: string): void {
    if (!this.doc) {
      return;
    }

    try {
      const update = decodeUpdateBase64(updateBase64);
      Y.applyUpdate(this.doc, update, REMOTE_UPDATE_ORIGIN);
    } catch {
      // Ignore malformed remote updates and keep the current document state.
    }
  }

  encodeStateAsUpdateBase64(): string {
    if (!this.doc) {
      return "";
    }

    return encodeUpdateBase64(Y.encodeStateAsUpdate(this.doc));
  }

  onTextChanged(callback: TextChangedCallback): () => void {
    this.textCallbacks.add(callback);
    return () => {
      this.textCallbacks.delete(callback);
    };
  }

  onLocalUpdate(callback: LocalUpdateCallback): () => void {
    this.localUpdateCallbacks.add(callback);
    return () => {
      this.localUpdateCallbacks.delete(callback);
    };
  }
}
