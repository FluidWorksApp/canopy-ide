// Ported from T3 Code apps/web/src/components/device/deviceFrameLayout.ts
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License, Copyright (c) 2026 T3 Tools Inc.). Unchanged.
export function fitDeviceFrame(aspect: number, width: number, height: number, rightInset: number) {
  const availableWidth = Math.max(0, width - rightInset);
  if (availableWidth === 0 || height === 0) return { width: 0, height: 0 };
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= availableWidth
    ? byHeight
    : { width: availableWidth, height: availableWidth / aspect };
}
