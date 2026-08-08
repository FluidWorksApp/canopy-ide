import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
const settings = readFileSync(join(process.cwd(), "src/settings.ts"), "utf8");
const dialog = readFileSync(
  join(process.cwd(), "src/components/SettingsDialog.tsx"),
  "utf8",
);

describe("notification pop-up delivery preference", () => {
  it("defaults on and explains that disabled notices remain in the bell", () => {
    expect(settings).toContain("notificationPopupsEnabled: true");
    expect(dialog).toContain("checked={s.notificationPopupsEnabled}");
    expect(dialog).toContain("Off keeps every notice in the top-right bell.");
  });

  it("gates every delivery surface without filtering the notification centre", () => {
    expect(app).toContain("if (!notificationPopupsEnabled) continue;");
    expect(app).toContain(
      "notificationPopupsEnabled ? remoteAttentionSnapshot() : []",
    );
    expect(app).toContain(
      "const deliveredToasts = notificationPopupsEnabled ? toasts : [];",
    );
    expect(app).toContain("notices={deliveredToasts}");
    expect(app).toContain("items={visibleAttention}");
  });
});
