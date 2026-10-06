declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);
    scaleViewport: boolean;
    background: string;
    disconnect(): void;
    toDataURL(type?: string): string;
  }
}
