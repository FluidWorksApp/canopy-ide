import { describe, expect, it } from "vitest";
import {
  generatePassword,
  monogram,
  suggestedDomain,
  suggestedLabel,
  tint,
} from "./vaultUi";

describe("the credential tile", () => {
  it("takes its letter from the name, or the site when there is no name", () => {
    expect(monogram("GitHub", "github.com")).toBe("G");
    expect(monogram("", "staging.example.com")).toBe("S");
    // Names come from people: emoji, punctuation and blanks all arrive.
    expect(monogram("🔐 vault", "x.com")).toBe("V");
    expect(monogram("", "")).toBe("?");
  });

  it("keeps a site's colour stable, and colours different sites differently", () => {
    expect(tint("github.com")).toBe(tint("github.com"));
    expect(tint("GITHUB.COM")).toBe(tint("github.com"));
    expect(tint("github.com")).not.toBe(tint("gitlab.com"));
    expect(tint("github.com")).toBeGreaterThanOrEqual(0);
    expect(tint("github.com")).toBeLessThan(360);
  });
});

describe("starting a new entry from the open page", () => {
  it("takes the site from the URL, without the www nobody means", () => {
    expect(suggestedDomain("https://www.github.com/login")).toBe("github.com");
    expect(suggestedDomain("https://gist.github.com/x")).toBe("gist.github.com");
    expect(suggestedDomain("about:blank")).toBe("");
    expect(suggestedDomain("")).toBe("");
  });

  it("proposes a name from the site, dropping the suffix", () => {
    expect(suggestedLabel("github.com")).toBe("Github");
    expect(suggestedLabel("db.staging.internal")).toBe("Db staging");
    expect(suggestedLabel("localhost")).toBe("Localhost");
    expect(suggestedLabel("")).toBe("");
  });
});

describe("generatePassword", () => {
  it("is the length asked for, from the safe alphabet, and never repeats", () => {
    const one = generatePassword();
    expect(one).toHaveLength(20);
    expect(generatePassword(32)).toHaveLength(32);
    // No characters that get misread when someone types one by hand.
    expect(one).not.toMatch(/[0O1lI]/);
    expect(one).toMatch(/^[A-Za-z2-9!@#%^&*\-_=+]+$/);
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });
});
