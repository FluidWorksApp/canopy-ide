import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const windowsPackaging = readFileSync(
  join(root, ".github/workflows/windows-packaging.yml"),
  "utf8",
);

describe("remote desktop release packaging", () => {
  it("enables native capture and input in both macOS release artifacts", () => {
    expect(release).toContain(
      'args: "--target aarch64-apple-darwin --features desk-native"',
    );
    expect(release).toContain(
      'args: "--target x86_64-apple-darwin -- --no-default-features --features desk-native"',
    );
  });

  it("enables native capture and input in Windows release and packaging checks", () => {
    expect(release).toContain(
      'args: "--target x86_64-pc-windows-msvc --bundles nsis --features desk-native"',
    );
    expect(windowsPackaging).toContain(
      "build --target x86_64-pc-windows-msvc --bundles nsis --features desk-native --config",
    );
  });
});
