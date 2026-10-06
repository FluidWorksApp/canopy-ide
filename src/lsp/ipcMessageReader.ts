import {
  AbstractMessageReader,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
} from "vscode-jsonrpc";

export interface LspReaderLimits {
  maxFrameChars: number;
  maxBufferedMessages: number;
  maxBufferedBytes: number;
}

export const DEFAULT_LSP_READER_LIMITS: LspReaderLimits = {
  // Native framing already rejects bodies beyond 16 MiB. The renderer uses a
  // tighter ceiling because it temporarily holds the IPC string and parsed
  // object in the same heap.
  maxFrameChars: 4 * 1024 * 1024,
  maxBufferedMessages: 128,
  maxBufferedBytes: 16 * 1024 * 1024,
};

export class IpcMessageReader
  extends AbstractMessageReader
  implements MessageReader
{
  private readonly limits: LspReaderLimits;
  private callback: DataCallback | null = null;
  private buffered: Message[] = [];
  private bufferedBytes = 0;
  private failed = false;

  constructor(limits: LspReaderLimits = DEFAULT_LSP_READER_LIMITS) {
    super();
    this.limits = limits;
  }

  push(raw: string, observe?: (message: Message) => void) {
    if (this.failed) return;
    if (raw.length > this.limits.maxFrameChars) {
      this.fail(
        new Error(
          `LSP frame exceeded the ${this.limits.maxFrameChars}-character renderer limit`,
        ),
      );
      return;
    }
    try {
      const message = JSON.parse(raw) as Message;
      observe?.(message);
      if (this.callback) this.callback(message);
      else {
        // A parsed JSON tree and its source string can coexist until this turn
        // completes. Four UTF-16 bytes per input character is a conservative
        // retained-tree estimate without recursively walking attacker-shaped
        // objects and allocating yet more bookkeeping.
        const charge = Math.min(Number.MAX_SAFE_INTEGER, raw.length * 4);
        if (
          this.buffered.length >= this.limits.maxBufferedMessages ||
          this.bufferedBytes + charge > this.limits.maxBufferedBytes
        ) {
          this.fail(
            new Error(
              `LSP startup buffer exceeded its ${this.limits.maxBufferedMessages}-message/${this.limits.maxBufferedBytes}-byte limit`,
            ),
          );
          return;
        }
        this.buffered.push(message);
        this.bufferedBytes += charge;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(error: unknown) {
    this.failed = true;
    this.buffered = [];
    this.bufferedBytes = 0;
    this.fireError(error instanceof Error ? error : new Error(String(error)));
  }

  snapshot() {
    return {
      bufferedMessages: this.buffered.length,
      bufferedBytes: this.bufferedBytes,
      failed: this.failed,
    };
  }

  notifyClosed() {
    this.buffered = [];
    this.bufferedBytes = 0;
    this.fireClose();
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    for (const message of this.buffered) callback(message);
    this.buffered = [];
    this.bufferedBytes = 0;
    return { dispose: () => (this.callback = null) };
  }
}
