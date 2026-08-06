import * as ipc from "./ipc";
import type { Component } from "./projects";
import type { VibePackageFact, VibePackageFacts } from "./vibeTargetInference";

const join = (root: string, name: string) => {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${name}`;
};

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
    const text = (key: "dev" | "start") =>
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
      scripts: { dev: text("dev"), start: text("start") },
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
