// Finds the moment a program switches to the alternate screen (DECSET 47,
// 1047, 1049). The engine cannot be asked for the primary screen while the
// alternate one is up, so the terminal reads it just before the switch: at
// the final byte of the sequence, which is what this locates.

const GROUND = 0;
const ESC = 1;
const CSI = 2;
const PRIVATE = 3;

export class AltScreenWatcher {
  private state = GROUND;
  private params = "";

  /** Index in `bytes` (at or after `from`) of the final `h` of a sequence
   *  that enters the alternate screen, or -1. Call again with the index + 1
   *  to keep looking; every byte must pass through exactly once. */
  find(bytes: Uint8Array, from = 0): number {
    let i = from;
    if (this.state === GROUND) {
      i = bytes.indexOf(0x1b, from);
      if (i < 0) return -1;
    }
    for (; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this.state) {
        case GROUND:
          if (b === 0x1b) this.state = ESC;
          break;
        case ESC:
          this.state = b === 0x5b ? CSI : b === 0x1b ? ESC : GROUND;
          break;
        case CSI:
          if (b === 0x3f) {
            this.state = PRIVATE;
            this.params = "";
          } else this.state = b === 0x1b ? ESC : GROUND;
          break;
        default:
          if ((b >= 0x30 && b <= 0x39) || b === 0x3b) {
            if (this.params.length < 64) this.params += String.fromCharCode(b);
          } else {
            this.state = b === 0x1b ? ESC : GROUND;
            if (b === 0x68 && /(^|;)(47|1047|1049)(;|$)/.test(this.params)) return i;
          }
      }
    }
    return -1;
  }

  reset(): void {
    this.state = GROUND;
    this.params = "";
  }
}
