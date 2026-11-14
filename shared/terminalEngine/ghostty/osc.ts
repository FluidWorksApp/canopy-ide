// Watches the byte stream for OSC sequences (ESC ] id ; data BEL|ST) so the
// app's handlers (notifications on 9/777/99, clipboard on 52) see them. The
// engine still receives every byte: this only observes.

const GROUND = 0;
const ESC = 1;
const BODY = 2;
const BODY_ESC = 3;

/** A longer payload is not delivered (the engine still parses it). */
export const MAX_OSC_BYTES = 4 * 1024 * 1024;

export class OscScanner {
  private state = GROUND;
  private body: number[] = [];
  private overflow = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  /** Calls `emit(id, data)` for every OSC completed inside `bytes`. */
  scan(bytes: Uint8Array, emit: (id: number, data: string) => void): void {
    // Nearly every chunk has no ESC ] at all and no sequence open.
    if (this.state === GROUND && bytes.indexOf(0x1b) < 0) return;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this.state) {
        case GROUND:
          if (b === 0x1b) this.state = ESC;
          break;
        case ESC:
          if (b === 0x5d) {
            this.state = BODY;
            this.body = [];
            this.overflow = false;
          } else {
            this.state = b === 0x1b ? ESC : GROUND;
          }
          break;
        case BODY:
          if (b === 0x07) this.finish(emit);
          else if (b === 0x1b) this.state = BODY_ESC;
          else if (b === 0x18 || b === 0x1a) this.state = GROUND;
          else this.push(b);
          break;
        default:
          // ESC \ ends the string; ESC anything else aborts it and starts
          // that sequence instead.
          if (b === 0x5c) this.finish(emit);
          else if (b === 0x5d) {
            this.state = BODY;
            this.body = [];
            this.overflow = false;
          } else this.state = b === 0x1b ? ESC : GROUND;
      }
    }
  }

  reset(): void {
    this.state = GROUND;
    this.body = [];
    this.overflow = false;
  }

  private push(b: number): void {
    if (this.overflow) return;
    if (this.body.length >= MAX_OSC_BYTES) {
      this.overflow = true;
      this.body = [];
      return;
    }
    this.body.push(b);
  }

  private finish(emit: (id: number, data: string) => void): void {
    this.state = GROUND;
    const body = this.body;
    this.body = [];
    if (this.overflow) return;
    let split = body.indexOf(0x3b);
    if (split < 0) split = body.length;
    if (split === 0 || split > 6) return;
    let id = 0;
    for (let i = 0; i < split; i++) {
      const d = body[i] - 0x30;
      if (d < 0 || d > 9) return;
      id = id * 10 + d;
    }
    emit(id, this.decoder.decode(Uint8Array.from(body.slice(split + 1))));
  }
}
