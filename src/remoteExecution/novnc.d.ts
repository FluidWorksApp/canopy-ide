declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    toDataURL(type?: string): string;
  }
}
