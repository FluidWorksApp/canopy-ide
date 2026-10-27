import { describe, expect, it, vi } from "vitest";
import { describeWorkspaceProject, includedModules, moduleKind, wantsWorkspaceAndroid, workspaceAndroid } from "./androidBridge";

const b64 = (s: string) => btoa(s);

describe("Android for a project in a cloud workspace", () => {
  it("only bridges calls that name the VM", () => {
    expect(wantsWorkspaceAndroid("android_run", { apk: "/workspace/app/app.apk" })).toBe(true);
    expect(wantsWorkspaceAndroid("android_run", { apk: "/Users/me/app.apk" })).toBe(false);
    expect(wantsWorkspaceAndroid("android_describe", { projectDir: "/workspace/app" })).toBe(true);
    expect(wantsWorkspaceAndroid("android_tap", { projectDir: "/workspace/app" })).toBe(false);
  });

  it("copies the APK here in slices, then installs it with the desktop's run", async () => {
    const apk = "x".repeat(2.5 * 1024 * 1024);
    const native = vi.fn(async (_c: string, a: Record<string, unknown>) => {
      const offset = Number(a.offset);
      return { b64: b64(apk.slice(offset, offset + Number(a.length))), size: apk.length };
    });
    const staged: { offset: number; len: number; done: boolean; name: string }[] = [];
    const desktop = vi.fn(async (command: string, a: Record<string, unknown>) => {
      if (command === "android_stage_file") {
        staged.push({ offset: Number(a.offset), len: atob(String(a.b64)).length, done: !!a.done, name: String(a.name) });
        return a.done ? "/tmp/canopy-android-stage/x.apk" : null;
      }
      return "Launched";
    });
    expect(await workspaceAndroid("android_run", { projectDir: "/workspace/app", apk: "/workspace/app/build/app-debug.apk", serial: "emulator-5554" }, native as never, desktop as never)).toBe("Launched");
    expect(staged.map((s) => [s.offset, s.len, s.done])).toEqual([[0, 1048576, false], [1048576, 1048576, false], [2097152, 524288, true]]);
    expect(new Set(staged.map((s) => s.name)).size).toBe(1);
    expect(staged[0].name).toMatch(/^[0-9a-f-]{36}\.apk$/);
    expect(desktop).toHaveBeenLastCalledWith("android_run", { projectDir: "", apk: "/tmp/canopy-android-stage/x.apk", serial: "emulator-5554" });
  });

  it("describes the project from its Gradle files and the APKs already built", async () => {
    const files: Record<string, string> = {
      "/workspace/app/settings.gradle.kts": 'rootProject.name = "demo"\ninclude(":app", ":core")\n// include(":old")',
      "/workspace/app/app/build.gradle.kts": 'plugins { id("com.android.application") }\nandroid { defaultConfig { applicationId = "com.acme.demo" } }',
      "/workspace/app/core/build.gradle": "plugins { id 'com.android.library' }",
    };
    const native = vi.fn(async (command: string, a: Record<string, unknown>) => {
      if (command === "fs_read_range") {
        const text = files[String(a.path)];
        if (text == null) throw Error("ENOENT");
        return { b64: b64(text), size: text.length };
      }
      if (command === "fs_read_dir") {
        if (a.path === "/workspace/app/app/build/outputs/apk") return [{ name: "debug", path: "/workspace/app/app/build/outputs/apk/debug", is_dir: true }];
        if (a.path === "/workspace/app/app/build/outputs/apk/debug") return [{ name: "app-debug.apk", path: "/workspace/app/app/build/outputs/apk/debug/app-debug.apk", is_dir: false }, { name: "output-metadata.json", path: "x", is_dir: false }];
        throw Error("ENOENT");
      }
      throw Error(command);
    });
    const out = JSON.parse(await describeWorkspaceProject(native as never, "/workspace/app/"));
    expect(out.modules).toEqual([
      { module: ":app", dir: "/workspace/app/app", type: "application", applicationId: "com.acme.demo", apks: ["/workspace/app/app/build/outputs/apk/debug/app-debug.apk"] },
      { module: ":core", dir: "/workspace/app/core", type: "library", applicationId: null, apks: [] },
    ]);
    await expect(describeWorkspaceProject((async () => { throw Error("ENOENT"); }) as never, "/workspace/none")).rejects.toThrow(/doesn't look like a Gradle Android project/);
  });

  it("reads Groovy and Kotlin includes", () => {
    expect(includedModules("include ':app', ':feature:home'\ninclude 'lib'")).toEqual([":app", ":feature:home", ":lib"]);
    expect(moduleKind("apply plugin: 'com.android.application'\napplicationId 'a.b'")).toEqual({ app: true, applicationId: "a.b" });
  });
});
