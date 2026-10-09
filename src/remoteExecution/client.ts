import {requestQueue,requestPriority} from './requestQueue';
import {connectionKey,reportConnection} from './connectionState';
export interface RemoteWorkspace {
  id: string;
  name: string;
  accounts: string[];
  memoryMiB: number;
  memoryMaxMiB?: number;
  cpus: number;
  cpusMax?: number;
}
export interface RemoteSession {
  id: number;
  pid?: number;
  title: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  accountId: string | null;
  kind?: "terminal" | "build";
}
export function remoteEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Enter a host URL without credentials or a path");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Remote hosts require HTTPS; an SSH-forwarded loopback endpoint may use HTTP");
  return url.origin;
}

/** Remote operations have no native fallback. Tokens live only in this client,
 * never in persisted settings, URLs, terminal environments or command args. */
export class RemoteExecutionClient {
  readonly endpoint: string;
  private readonly token: string;
  private readonly resolveToken?: () => Promise<string>;
  constructor(endpoint: string, token: string, resolveToken?: () => Promise<string>) { this.endpoint = remoteEndpoint(endpoint); this.token = token; this.resolveToken = resolveToken; }
  async request<T>(route: string, args?: unknown): Promise<T> {
    return requestQueue(this.endpoint).run(requestPriority(route,args),()=>this.performRequest<T>(route,args));
  }
  private async performRequest<T>(route: string, args?: unknown, retries=0): Promise<T> {
    const id=route.match(/^\/workspaces\/([a-z][a-z0-9-]*)(?:\/|$)/)?.[1];
    const key=id?connectionKey(this.endpoint,id):null;
    let response:Response;
    try { const token = this.resolveToken ? await this.resolveToken() : this.token;
      response = await fetch(`${this.endpoint}/v1${route}`, {
      method: args === undefined ? "GET" : "POST", redirect:"error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: args === undefined ? undefined : JSON.stringify(args), signal: AbortSignal.timeout(route.endsWith("/native") && ["git_clone","git_fetch","git_pull","git_push"].includes(String((args as {command?:string})?.command)) ? 330_000 : 30_000),
    });
    } catch(error) { if(key)reportConnection(key,'reconnecting');throw error; }
    if(response.status===429&&retries<2){
      // A rejected request was never admitted: retrying it cannot repeat a mutation.
      await new Promise(resolve=>setTimeout(resolve,500));
      return this.performRequest<T>(route,args,retries+1);
    }
    const result = await response.json();
    const unavailable=response.status>=500 || /^(fetch failed|Workspace.*(?:unavailable|unreachable)|connect E(?:CONNREFUSED|TIMEDOUT))/i.test(String(result.error??''));
    if(key)reportConnection(key,response.status===401||response.status===403?'authentication-error':unavailable?'reconnecting':'connected');
    if (!response.ok) throw new Error(result.error ?? `Host request failed (${response.status})`);
    return result as T;
  }
  list() { return this.request<{ principal: string; scope: "view" | "drive" | "admin"; workspaces: RemoteWorkspace[] }>("/workspaces"); }
  workspace<T>(id: string, route: string, args?: unknown) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) return Promise.reject(new Error("Invalid workspace"));
    return this.request<T>(`/workspaces/${id}${route}`, args);
  }
  /** A long-lived workspace response (an SSE stream) with this client's credential; outside the request queue and its timeout. */
  async open(id: string, route: string, signal: AbortSignal): Promise<Response> {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) throw new Error("Invalid workspace");
    const token = this.resolveToken ? await this.resolveToken() : this.token;
    return fetch(`${this.endpoint}/v1/workspaces/${id}${route}`, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal });
  }
  async streamUrl(id: string, stream: string) {
    const { ticket } = await this.workspace<{ ticket: string }>(id, "/ticket", { stream });
    return `${this.endpoint.replace(/^http/, "ws")}/v1/stream?ticket=${encodeURIComponent(ticket)}`;
  }
}
