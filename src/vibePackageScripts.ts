import * as ipc from "./ipc";
import type { VibeCheckScript } from "./vibeCheckInference";
import type { Component } from "./projects";
import type { VibePackageFact, VibePackageFacts } from "./vibeTargetInference";

const join = (root: string, name: string) => {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${name}`;
};

/** Every script key a fact carries. `dev` and `start` answer "what runs this
 *  app?" for `inferVibeTarget`; the rest answer "what proves the change is
 *  sound?" for `inferVibeCheck`. Narrowing to the first two — which this did —
 *  meant a fact could never carry a check, so `verified` was unreachable for a
 *  project whose only check lives in package.json, which is every project
 *  Canopy set up from nothing. */
type VibeScriptKey = "dev" | "start" | VibeCheckScript;

const SCRIPT_KEYS: readonly VibeScriptKey[] = [
  "dev",
  "start",
  "check",
  "typecheck",
  "tsc",
  "test",
  "build",
];

export function parseVibePackageFact(raw: string): VibePackageFact {
  try {
    const parsed = JSON.parse(raw) as {
      scripts?: unknown;
      packageManager?: unknown;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object"
        ? (parsed.scripts as Record<string, unknown>)
        : {};
    const text = (key: VibeScriptKey) =>
      typeof scripts[key] === "string" && scripts[key].trim()
        ? scripts[key].trim()
        : undefined;
    const packageManager =
      typeof parsed.packageManager === "string"
        ? parsed.packageManager.split("@")[0]
        : "";
    const runner = ["npm", "pnpm", "yarn", "bun"].includes(packageManager)
      ? (packageManager as "npm" | "pnpm" | "yarn" | "bun")
      : "npm";
    return {
      status: "loaded",
      // Only the keys that are present: an explicit `undefined` for every
      // absent script would make `"typecheck" in fact.scripts` true, and the
      // check inference reads presence as well as value.
      scripts: Object.fromEntries(
        SCRIPT_KEYS.flatMap((key) => {
          const value = text(key);
          return value ? [[key, value] as const] : [];
        }),
      ),
      runner,
    };
  } catch {
    return { status: "invalid" };
  }
}

async function loadOne(component: Component): Promise<VibePackageFact> {
  const inspect = async () => {
    const entries = await ipc.fsReadDir(component.path);
    if (!entries.some((entry) => entry.name === "package.json" && !entry.is_dir)) {
      return { status: "missing" } as const;
    }
    const path = join(component.path, "package.json");
    const stat = await ipc.fsStat(path);
    if (stat.is_dir || stat.size > 1024 * 1024) return { status: "invalid" } as const;
    return parseVibePackageFact(await ipc.fsReadText(path));
  };
  try {
    return await inspect();
  } catch {
    try {
      await ipc.workspaceAdd(component.path);
      return await inspect();
    } catch {
      return { status: "error" };
    }
  }
}

export async function loadVibePackageFacts(
  components: readonly Component[],
  componentIds: readonly string[],
): Promise<VibePackageFacts> {
  const wanted = new Set(componentIds);
  return Object.fromEntries(
    await Promise.all(
      components
        .filter((component) => wanted.has(component.id))
        .map(async (component) => [component.id, await loadOne(component)] as const),
    ),
  );
}
