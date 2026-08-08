// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frameSrc, releaseFrameSrc } from "./browserFrame";

describe("browser freeze-frame resources", () => {
  const created = vi.fn((_blob: Blob) => "blob:canopy-frame-1");
  const revoked = vi.fn((_url: string) => undefined);
  let createDescriptor: PropertyDescriptor | undefined;
  let revokeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    created.mockClear();
    revoked.mockClear();
    createDescriptor = Object.getOwnPropertyDescriptor(window.URL, "createObjectURL");
    revokeDescriptor = Object.getOwnPropertyDescriptor(window.URL, "revokeObjectURL");
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: created,
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: revoked,
    });
  });

  afterEach(() => {
    if (createDescriptor) {
      Object.defineProperty(window.URL, "createObjectURL", createDescriptor);
    } else {
      Reflect.deleteProperty(window.URL, "createObjectURL");
    }
    if (revokeDescriptor) {
      Object.defineProperty(window.URL, "revokeObjectURL", revokeDescriptor);
    } else {
      Reflect.deleteProperty(window.URL, "revokeObjectURL");
    }
  });

  it("uses a revocable JPEG Blob URL in the renderer", () => {
    const src = frameSrc("QUJD");

    expect(src).toBe("blob:canopy-frame-1");
    expect(created).toHaveBeenCalledTimes(1);
    const blob = created.mock.calls[0][0];
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(3);
  });

  it("releases Blob URLs and ignores non-Blob sources", () => {
    releaseFrameSrc("blob:canopy-frame-1");
    releaseFrameSrc("data:image/jpeg;base64,QUJD");
    releaseFrameSrc(null);

    expect(revoked).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith("blob:canopy-frame-1");
  });
});
