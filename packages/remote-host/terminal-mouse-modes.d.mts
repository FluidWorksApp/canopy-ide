import type {Terminal} from '@xterm/xterm';
import type {ISerializeOptions,SerializeAddon} from '@xterm/addon-serialize';

/** Tracks the mouse report encoding xterm's serializer drops, so a restored
 * screen keeps reporting wheel and clicks the way the program asked. */
export interface MouseEncodingTracker {
  reset(): void;
  serialize(serializer: Pick<SerializeAddon,'serialize'>, options?: ISerializeOptions): string;
  dispose(): void;
}
export function trackMouseEncoding(term: Pick<Terminal,'parser'>): MouseEncodingTracker;
