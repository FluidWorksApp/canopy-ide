// The language servers Canopy knows how to run, and the pure decisions around
// them: which spec covers a file, which directory the server should call its
// root, and what to tell an agent when the binary isn't installed.
//
// Separate from client.ts because that file imports Monaco (and its
// stylesheets), which a test runner can't load. Everything here is string work
// over an injected stat, so it is testable on its own.

export interface ServerSpec {
  id: string;
  languages: string[];
  extensions: string[];
  command: string;
  args: string[];
  /** Files marking the directory this server wants as its root. Canopy passes
   *  the component root; a Cargo workspace usually sits deeper (src-tauri/),
   *  and rust-analyzer given a root with no Cargo.toml analyses nothing. */
  rootMarkers?: string[];
  /** Sent verbatim as LSP initializationOptions. */
  initializationOptions?: unknown;
  /** How long a diagnostics call may wait for this server to stop indexing.
   *  Absent = it answers as fast as the editor does, so the ordinary
   *  first-publish wait is enough. */
  indexingWaitMs?: number;
  /** How to get the binary, quoted back to the agent when spawn fails. */
  install?: string;
}

export const SERVERS: ServerSpec[] = [
  {
    id: "typescript",
    languages: ["typescript", "javascript", "typescriptreact", "javascriptreact"],
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
    command: "typescript-language-server",
    args: ["--stdio"],
    install: "install with: npm i -g typescript-language-server typescript",
  },
  {
    id: "rust",
    languages: ["rust"],
    extensions: ["rs"],
    command: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml"],
    // Without this rust-analyzer only publishes what `cargo check` printed,
    // and cargo check runs on didSave — which Canopy's agent tools never send.
    // The experimental set is its own analysis, which is the live answer the
    // editor already shows.
    initializationOptions: { diagnostics: { experimental: { enable: true } } },
    indexingWaitMs: 60_000,
    install: "install with: rustup component add rust-analyzer",
  },
  {
    id: "python",
    languages: ["python"],
    extensions: ["py", "pyi"],
    command: "pyright-langserver",
    args: ["--stdio"],
    install: "install with: npm i -g pyright",
  },
];

export function specForPath(path: string): ServerSpec | undefined {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return SERVERS.find((s) => s.extensions.includes(ext));
}

/** Every language Canopy can answer for, for the message an agent reads when
 *  it asked about a file none of them cover. */
export const SUPPORTED_LANGUAGES = "TypeScript/JavaScript, Rust and Python";

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** The directory this server should treat as its workspace: the nearest
 *  ancestor of the file holding one of the spec's markers, never above the
 *  project root Canopy passed. Falls back to that root, which is what a spec
 *  with no markers (TypeScript) always gets. */
export async function resolveServerRoot(
  filePath: string,
  root: string,
  spec: Pick<ServerSpec, "rootMarkers">,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const markers = spec.rootMarkers;
  if (!markers?.length) return root;
  const stop = root.replace(/\/+$/, "");
  let dir = dirOf(filePath);
  while (dir.length >= stop.length && (dir === stop || dir.startsWith(`${stop}/`))) {
    for (const marker of markers) {
      if (await exists(`${dir}/${marker}`)) return dir;
    }
    const up = dirOf(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return root;
}

/** Everything needed to spawn a server for one project. Only TypeScript varies
 *  by project today, which is why this isn't simply the spec. */
export interface ServerLaunch {
  command: string;
  args: string[];
  initializationOptions?: unknown;
}

/** The platform packages npm publishes TypeScript 7's compiler in. Exactly one
 *  is ever installed — they are optionalDependencies picked by platform — so
 *  probing the list costs a stat each and spares us guessing the architecture,
 *  which `navigator.platform` cannot tell us (it reports MacIntel on Apple
 *  silicon). */
const NATIVE_TSC_PACKAGES = [
  "typescript-darwin-arm64",
  "typescript-darwin-x64",
  "typescript-linux-arm64",
  "typescript-linux-x64",
  "typescript-win32-arm64",
  "typescript-win32-x64",
];

/** TypeScript 7's compiler binary, which is also a language server. */
export async function resolveNativeTsc(
  root: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  for (const pkg of NATIVE_TSC_PACKAGES) {
    const lib = `${root}/node_modules/@typescript/${pkg}/lib`;
    for (const exe of [`${lib}/tsc`, `${lib}/tsc.exe`]) {
      if (await exists(exe)) return exe;
    }
  }
  return undefined;
}

/** How to run the TypeScript language service for a project.
 *
 *  A project carrying its own `tsserver.js` keeps typescript-language-server
 *  driving that tsserver, so anything pinning its own toolchain is analysed
 *  exactly as it was. TypeScript 7 is the native port and ships no tsserver at
 *  all — there the compiler binary *is* an LSP server, so Canopy talks to it
 *  directly and skips the wrapper entirely. With neither we still hand the
 *  wrapper an undefined path and let it find a tsserver of its own, which is
 *  what happened before any of this existed. */
export async function resolveTypescriptLaunch(
  spec: ServerSpec,
  root: string,
  wrapperCommand: string,
  exists: (path: string) => Promise<boolean>,
): Promise<ServerLaunch> {
  const tsserver = `${root}/node_modules/typescript/lib/tsserver.js`;
  if (await exists(tsserver)) {
    return {
      command: wrapperCommand,
      args: spec.args,
      initializationOptions: { tsserver: { path: tsserver } },
    };
  }
  const native = await resolveNativeTsc(root, exists);
  if (native) return { command: native, args: ["--lsp", "--stdio"] };
  return {
    command: wrapperCommand,
    args: spec.args,
    initializationOptions: { tsserver: { path: undefined } },
  };
}

/** Spawn failures that mean "the binary isn't there" rather than "it started
 *  and died". lsp_start's own error is `failed to spawn <cmd>: <io error>`. */
const MISSING = /failed to spawn|no such file|not found|enoent|cannot find/i;

/** What the agent is told instead of a silent empty answer. Naming the binary
 *  and the install line is the difference between the agent retrying forever
 *  and it either installing the server or moving on. */
export function serverUnavailableMessage(spec: ServerSpec, err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (MISSING.test(text)) {
    return `${spec.command} not found on PATH${spec.install ? ` — ${spec.install}` : ""}`;
  }
  return `${spec.command} failed to start: ${text.slice(0, 200)}`;
}
