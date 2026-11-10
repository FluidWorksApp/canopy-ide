// Ported from T3 Code packages/client-runtime/src/device/hubAccess.ts
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License, Copyright (c) 2026 T3 Tools Inc.).
// Unchanged from T3.
export interface DeviceHubAccess {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
  readonly credentials: boolean;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};
