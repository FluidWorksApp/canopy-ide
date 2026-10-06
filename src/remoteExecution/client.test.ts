import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteExecutionClient, remoteEndpoint } from "./client";
afterEach(() => vi.unstubAllGlobals());
it("requires TLS off loopback and rejects credentials in endpoints", () => {
  expect(remoteEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  expect(remoteEndpoint("https://vm.example")).toBe("https://vm.example");
  expect(() => remoteEndpoint("http://vm.example")).toThrow();
  expect(() => remoteEndpoint("https://user:secret@vm.example")).toThrow();
});
it("keeps tokens out of stream URLs and sends a one-use ticket", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: "one-use" }) });
  vi.stubGlobal("fetch", fetcher);
  const client = new RemoteExecutionClient("https://vm.example", "private-token");
  expect(await client.streamUrl("alice", "/desktop/ws")).toBe("wss://vm.example/v1/stream?ticket=one-use");
  expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer private-token");
  expect(fetcher.mock.calls[0][0]).not.toContain("private-token");
});

it("native connection policy permits TLS hosts and forwarded loopback streams", () => {
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    const connect = policy.split(";").find((part: string) => part.trim().startsWith("connect-src"));
    expect(connect).toContain("https:"); expect(connect).toContain("wss:");
    expect(connect).toContain("http://127.0.0.1:*"); expect(connect).toContain("ws://127.0.0.1:*");
    expect(connect).not.toMatch(/(?:^| )http:(?: |$)/);
  }
});
it('retries only admission rejection and never repeats an admitted mutation after failure',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:'Too many pending operations'}),{status:429})).mockResolvedValueOnce(new Response(JSON.stringify({saved:true}),{status:200}));
 vi.stubGlobal('fetch',fetcher);const client=new RemoteExecutionClient('https://admission.example','token');
 await expect(client.workspace('alice','/files/write',{path:'/workspace/test',content:'test'})).resolves.toEqual({saved:true});expect(fetcher).toHaveBeenCalledTimes(2);
 fetcher.mockClear().mockResolvedValue(new Response(JSON.stringify({error:'backend unavailable'}),{status:500}));
 await expect(client.workspace('alice','/files/write',{path:'/workspace/test',content:'test'})).rejects.toThrow('backend unavailable');expect(fetcher).toHaveBeenCalledTimes(1);
});
