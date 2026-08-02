/// <reference types="node" />
// A path's last segment has one implementation, and it knows about Windows.
//
// This started as twenty copies of `p.split("/").pop()`, which is right on a
// Mac and silently wrong on Windows: the separator is a backslash, the split
// finds nothing to cut, and the whole path comes back as the "name". A Windows
// user saw `C:\USERS\CORAA\DESKTOP\PROJECT` in the components list where a Mac
// user sees `Project` — and the same in the project tab, the terminal chips and
// every claim row, because one wrong line had been written everywhere.
//
// The guard is deliberately narrow. Splitting on "/" is correct for plenty of
// things that are not filesystem paths — URLs, repo slugs, branch names, MIME
// types — so it flags only the shape that means "give me the file name":
// a split immediately followed by `.pop()`.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { basename, dirname, tailPath } from "./paths";

const ROOT = process.cwd();

describe("basename", () => {
  it("reads a Windows path", () => {
    expect(basename("C:\\Users\\coraa\\Desktop\\Project")).toBe("Project");
    expect(basename("C:\\Users\\coraa\\Desktop\\Project\\")).toBe("Project");
    expect(basename("\\\\server\\share\\app")).toBe("app");
  });

  it("reads a POSIX path", () => {
    expect(basename("/Users/shoaib/Documents/GitHub/canopy")).toBe("canopy");
    expect(basename("/Users/shoaib/canopy/")).toBe("canopy");
    expect(basename("canopy")).toBe("canopy");
  });

  it("answers something for the edges rather than an empty row", () => {
    // A bare root has no last segment; the path itself is the honest answer and
    // it is short enough to show.
    expect(basename("/")).toBe("/");
    expect(basename("C:\\")).toBe("C:");
    expect(basename("")).toBe("");
    expect(basename(undefined)).toBe("");
    expect(basename(null)).toBe("");
  });

  it("keeps the rest of the path available", () => {
    expect(dirname("C:\\Users\\coraa\\Project")).toBe("C:\\Users\\coraa");
    expect(dirname("/a/b/c")).toBe("/a/b");
    expect(dirname("solo")).toBe("");
    expect(tailPath("C:\\Users\\coraa\\Desktop\\Project")).toBe("Desktop\\Project");
    expect(tailPath("/Users/shoaib/GitHub/canopy")).toBe("GitHub/canopy");
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("nothing writes its own", () => {
  it("has no POSIX-only last-segment split left in src", () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (rel === "src/paths.ts") continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*")) return;
          // `.split("/")` … `.pop()` on the same line: the file-name idiom.
          if (/\.split\(\s*["']\/["']\s*\)[^;]*\.pop\(\)/.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${code}`);
          }
        });
    }
    expect(
      offenders,
      "use basename() from src/paths.ts — a split on \"/\" alone returns the " +
        "whole path on Windows, and the name is what these lines are for",
    ).toEqual([]);
  });
});
