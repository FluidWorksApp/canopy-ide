// Android devices stay on the computer showing the IDE (LOCAL_UI), but in a
// cloud workspace the project — and the APK its build produced — live in the
// VM. These two commands bridge that:
//
//  - android_run: the APK is copied from the VM in slices (fs_read_range)
//    into a staging file on this computer (android_stage_file), then installed
//    and launched on the attached device with the desktop's own android_run.
//  - android_describe: the desktop's `android describe` needs the project on
//    disk and the Android SDK to evaluate its Gradle build, and the workspace
//    image has no SDK. So it is answered from the VM's files instead: the
//    modules settings.gradle includes, which are apps, their application ids,
//    and the APKs their builds have already produced — what a run needs.
import { basename } from "../paths";
type Call = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export const isWorkspacePath = (path: unknown): path is string =>
  typeof path === "string" && (path === "/workspace" || path.startsWith("/workspace/"));

/** Does this android_* call name something in the VM? */
export function wantsWorkspaceAndroid(command: string, args: Record<string, unknown>): boolean {
  if (command === "android_run") return isWorkspacePath(args.apk);
  if (command === "android_describe") return isWorkspacePath(args.projectDir);
  return false;
}

const SLICE = 1024 * 1024;
const MAX_APK = 1024 * 1024 * 1024;

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** Copy a VM file to this computer's staging directory; resolves with its local path. */
export async function stageWorkspaceApk(native: Call, desktop: Call, path: string): Promise<string> {
  const base = basename(path) || "app.apk";
  const ext = /\.apks$/i.test(base) ? "apks" : "apk";
  const name = `${crypto.randomUUID()}.${ext}`;
  let offset = 0;
  let size = 0;
  for (;;) {
    const slice = await native<{ b64: string; size: number }>("fs_read_range", { path, offset, length: SLICE });
    size = slice.size;
    if (size > MAX_APK) throw Error(`${base} is larger than 1 GB; Canopy won't copy it to this computer`);
    const bytes = decode(slice.b64);
    const done = offset + bytes.length >= size || !bytes.length;
    const staged = await desktop<string | null>("android_stage_file", { name, offset, b64: encode(bytes), done });
    offset += bytes.length;
    if (done) {
      if (!staged) throw Error(`couldn't stage ${base} on this computer`);
      return staged;
    }
  }
}

async function readText(native: Call, path: string): Promise<string | null> {
  try {
    const slice = await native<{ b64: string; size: number }>("fs_read_range", { path, offset: 0, length: 256 * 1024 });
    return new TextDecoder().decode(decode(slice.b64));
  } catch {
    return null;
  }
}

/** Module paths (`:app`, `:feature:home`) a settings.gradle(.kts) includes. */
export function includedModules(settings: string): string[] {
  const text = settings.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of text.matchAll(/\binclude\s*\(?([^\n)]*)/g))
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) out.push(q[1].startsWith(":") ? q[1] : `:${q[1]}`);
  return [...new Set(out)];
}

/** What a module's build file says it is. */
export function moduleKind(build: string): { app: boolean; applicationId: string | null } {
  const app = /com\.android\.application|android\.application\b|alias\(libs\.plugins\.android\.application\)/.test(build);
  const id = /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/.exec(build)?.[1] ?? null;
  return { app, applicationId: id };
}

async function apksUnder(native: Call, dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 3 || out.length >= 40) return out;
  let entries: { name: string; path: string; is_dir: boolean }[];
  try {
    entries = await native("fs_read_dir", { path: dir });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.is_dir) await apksUnder(native, e.path, depth + 1, out);
    else if (/\.apks?$/i.test(e.name)) out.push(e.path);
  }
  return out;
}

/** android_describe for a project in the VM, read from its files. */
export async function describeWorkspaceProject(native: Call, projectDir: string): Promise<string> {
  const root = projectDir.replace(/\/+$/, "");
  const settings = (await readText(native, `${root}/settings.gradle.kts`)) ?? (await readText(native, `${root}/settings.gradle`));
  const modules = settings ? includedModules(settings) : [];
  const dirs = modules.length ? modules.map((m) => ({ module: m, dir: `${root}/${m.slice(1).replaceAll(":", "/")}` })) : [{ module: ":", dir: root }];
  const described = [];
  for (const { module, dir } of dirs) {
    const build = (await readText(native, `${dir}/build.gradle.kts`)) ?? (await readText(native, `${dir}/build.gradle`));
    if (build == null) continue;
    const kind = moduleKind(build);
    described.push({
      module,
      dir,
      type: kind.app ? "application" : "library",
      applicationId: kind.applicationId,
      apks: kind.app ? await apksUnder(native, `${dir}/build/outputs/apk`) : [],
    });
  }
  if (!settings && !described.length)
    throw Error(`${projectDir} doesn't look like a Gradle Android project (no settings.gradle or build.gradle)`);
  return JSON.stringify(
    {
      project: projectDir,
      source: "cloud workspace files",
      note:
        "This project lives in a cloud workspace, so it is described from its Gradle files rather than by the Android SDK. " +
        "APK paths are builds already in the workspace: build the app there first (for example ./gradlew assembleDebug), then run one of them.",
      modules: described,
    },
    null,
    2,
  );
}

/** The adapter's hook for android_run / android_describe on a workspace path. */
export async function workspaceAndroid(command: string, args: Record<string, unknown>, native: Call, desktop: Call): Promise<unknown> {
  if (command === "android_describe") return describeWorkspaceProject(native, String(args.projectDir));
  const apk = await stageWorkspaceApk(native, desktop, String(args.apk));
  // No local project directory: the desktop resolves its own SDK.
  return desktop("android_run", { projectDir: "", apk, serial: args.serial });
}
