export interface ChromeCapture {
  image: string;
  width: number;
  height: number;
}

/** Ask the actual Chrome page for pixels, including when its iframe is hidden. */
export function captureChromeFrame(frame: HTMLIFrameElement | null): Promise<ChromeCapture> {
  if (!frame?.contentWindow) return Promise.reject(new Error("Chrome is not connected yet."));
  const source = frame.contentWindow;
  const origin = new URL(frame.src).origin;
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.source !== source || event.origin !== origin || event.data?.canopy !== "capture-result" || event.data.id !== id) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data as ChromeCapture);
    };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("Chrome did not answer the screenshot request.")); }, 12_000);
    window.addEventListener("message", receive);
    source.postMessage({ canopy: "capture", id }, origin);
  });
}
