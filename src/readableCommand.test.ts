import { describe, expect, it } from "vitest";
import { readableCommand } from "./readableCommand";

describe("readableCommand", () => {
  it("drops quotes that say nothing", () => {
    expect(readableCommand('"npm" "run" "test"')).toBe("npm run test");
    expect(readableCommand('"cargo" "test"')).toBe("cargo test");
    expect(readableCommand('"pnpm" "--filter=@acme/web" "dev"')).toBe("pnpm --filter=@acme/web dev");
  });

  it("keeps quoting that carries meaning", () => {
    for (const cmd of [
      '"npm" "run" "my script"',
      '"echo" "$HOME"',
      '"ls" "*.ts"',
      '"sh" "-c" "a && b"',
      '"say" "it\\"s"',
      '"a" ""',
    ]) {
      expect(readableCommand(cmd)).toBe(cmd);
    }
  });

  it("leaves hand-written commands alone", () => {
    for (const cmd of ["npm run dev", "cd /srv/app && make", 'echo "hi there"', '"npm"  "ci"', ""]) {
      expect(readableCommand(cmd)).toBe(cmd);
    }
    expect(readableCommand(readableCommand('"npm" "ci"'))).toBe("npm ci");
  });
});
