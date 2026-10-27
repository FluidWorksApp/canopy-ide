import { describe, expect, it } from "vitest";
import { hotspotReason, inferHotspots, shapeReason, CHURN_MIN } from "./hotspots";

describe("shapeReason", () => {
  it("recognises shared wiring by name", () => {
    expect(shapeReason("src/routes.ts")).toBe("a route table");
    expect(shapeReason("app/router.tsx")).toBe("a route table");
    expect(shapeReason("src/pluginRegistry.ts")).toBe("a registry");
    expect(shapeReason("package.json")).toBe("the project manifest");
    expect(shapeReason("vite.config.ts")).toBe("shared config");
    expect(shapeReason("src-tauri/src/lib.rs")).toBe("the app's wiring");
    expect(shapeReason("db/migrations/001_init.sql")).toBe("a database migration");
  });
  it("ignores ordinary files and lockfiles", () => {
    expect(shapeReason("src/components/Button.tsx")).toBeNull();
    expect(shapeReason("package-lock.json")).toBeNull();
    expect(shapeReason("Cargo.lock")).toBeNull();
  });
});

describe("inferHotspots", () => {
  it("combines churn, shape and claim refusals, strongest first", () => {
    const list = inferHotspots({
      churn: [
        { path: "src/App.tsx", commits: 20 },
        { path: "src/routes.ts", commits: 3 },
        { path: "src/feature.ts", commits: CHURN_MIN },
        { path: "src/quiet.ts", commits: 2 },
        { path: "package-lock.json", commits: 50 },
      ],
      refusals: ["src/checkout.ts"],
    });
    const paths = list.map((h) => h.path);
    expect(paths[0]).toBe("src/App.tsx");
    expect(paths).toContain("src/routes.ts");
    expect(paths).toContain("src/feature.ts");
    expect(paths).toContain("src/checkout.ts");
    expect(paths).not.toContain("src/quiet.ts");
    expect(paths).not.toContain("package-lock.json");
    const app = list.find((h) => h.path === "src/App.tsx")!;
    expect(app.reasons).toEqual(["changed in 20 commits in the last 30 days", "the app's wiring"]);
    expect(list.find((h) => h.path === "src/checkout.ts")!.reasons).toEqual(["agents have collided on it before"]);
  });

  it("uses the person's override instead of inference", () => {
    const list = inferHotspots({ churn: [{ path: "src/App.tsx", commits: 99 }] }, ["src/billing/", " ./config.yml "]);
    expect(list.map((h) => h.path)).toEqual(["src/billing/", "config.yml"]);
  });
});

describe("hotspotReason", () => {
  const list = inferHotspots({ churn: [] }, ["src/billing/"]);
  it("covers files inside a listed directory", () => {
    expect(hotspotReason("src/billing/invoice.ts", list, true)).toBe("you marked it as a hotspot");
    expect(hotspotReason("src/billingx.ts", list, true)).toBeNull();
  });
  it("falls back to shape only when the list was not overridden", () => {
    expect(hotspotReason("src/routes.ts", [], false)).toBe("a route table");
    expect(hotspotReason("src/routes.ts", list, true)).toBeNull();
  });
});
