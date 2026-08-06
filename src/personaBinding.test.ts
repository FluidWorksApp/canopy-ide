import { describe, expect, it } from "vitest";
import { personaBinding } from "./personaBinding";

describe("personaBinding", () => {
  it("shows Companion in Engineer mode", () => {
    expect(personaBinding(true, false)).toEqual({
      companionVisible: true,
      attentionFallbackVisible: false,
    });
  });

  it("gives Build mode one persona without dropping attention", () => {
    expect(personaBinding(true, true)).toEqual({
      companionVisible: false,
      attentionFallbackVisible: true,
    });
  });

  it("keeps attention visible when Companion is disabled", () => {
    expect(personaBinding(false, false)).toEqual({
      companionVisible: false,
      attentionFallbackVisible: true,
    });
  });
});
