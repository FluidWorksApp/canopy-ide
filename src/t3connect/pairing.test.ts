// Ported from T3 Code packages/shared/src/remote.test.ts (MIT, commit d0f1f720),
// plus Canopy's entry point that unwraps app links first.
import { describe, expect, it } from "vitest";
import {
  buildPairingAppLink,
  parseT3PairingLink,
  readPairingAppLink,
  RemotePairingError,
  resolveRemotePairingTarget,
} from "./pairing";

describe("T3 pairing links", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair#token=pairing-token" })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair?token=pairing-token" })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives backend urls from hosted app pairing links", () => {
    expect(resolveRemotePairingTarget({
      pairingUrl: "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
    })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(resolveRemotePairingTarget({ host: "https://remote.example.com", pairingCode: "pairing-token" })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(resolveRemotePairingTarget({ host: "//remote.example.com", pairingCode: "pairing-token" }).httpBaseUrl).toBe("https://remote.example.com/");
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(resolveRemotePairingTarget({ host: "///example.com", pairingCode: "pairing-token" }).httpBaseUrl).toBe("https://example.com/");
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(resolveRemotePairingTarget({ host: "//https://example.com", pairingCode: "pairing-token" }).httpBaseUrl).toBe("https://example.com/");
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(resolveRemotePairingTarget({ host: "myserver.com:3000", pairingCode: "pairing-token" })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let error: unknown;
    try {
      resolveRemotePairingTarget({ pairingUrl: "ftp://remote.example.com/pair#token=pairing-token" });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(RemotePairingError);
    expect(error).toMatchObject({ _tag: "RemotePairingUrlInvalidError", protocol: "ftp:" });
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(expect.objectContaining({ _tag: "RemoteBackendUrlMissingError" }));
    expect(() => resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }))
      .toThrowError(expect.objectContaining({ _tag: "RemotePairingTokenMissingError" }));
    expect(() => resolveRemotePairingTarget({ host: "https://user:secret@remote.example.com/path?token=sensitive#fragment" }))
      .toThrowError(expect.objectContaining({ _tag: "RemotePairingCodeMissingError", host: "remote.example.com" }));
  });

  it("round-trips pairing urls through app links on every channel scheme", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const appLink = buildPairingAppLink(pairingUrl);
    expect(appLink.startsWith("t3code://pair?")).toBe(true);
    expect(readPairingAppLink(appLink)).toBe(pairingUrl);
    expect(readPairingAppLink(appLink.replace("t3code:", "t3code-dev:"))).toBe(pairingUrl);
    expect(readPairingAppLink("t3code://pair")).toBeNull();
    expect(readPairingAppLink(appLink.replace("//pair?", "//pair/other?"))).toBeNull();
    expect(readPairingAppLink(`t3code://threads?pairingUrl=${encodeURIComponent(pairingUrl)}`)).toBeNull();
    expect(readPairingAppLink(`https://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`)).toBeNull();
  });

  it("reads whatever someone pastes: a direct link, an app link, or the CLI's LAN link", () => {
    expect(parseT3PairingLink("  https://box.example.com/pair#token=T1  ")).toMatchObject({ credential: "T1", httpBaseUrl: "https://box.example.com/" });
    expect(parseT3PairingLink(buildPairingAppLink("http://192.168.1.4:3773/pair#token=T2"))).toMatchObject({ credential: "T2", httpBaseUrl: "http://192.168.1.4:3773/" });
    // What `t3 serve` and `t3 pair` print (recorded from 0.1.7).
    expect(parseT3PairingLink("t3code://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A43413%2Fpair%23token%3DQ6X28AD3LU5V"))
      .toEqual({ credential: "Q6X28AD3LU5V", httpBaseUrl: "http://127.0.0.1:43413/", wsBaseUrl: "ws://127.0.0.1:43413/" });
    expect(() => parseT3PairingLink("")).toThrowError(expect.objectContaining({ _tag: "RemoteBackendUrlMissingError" }));
  });
});
