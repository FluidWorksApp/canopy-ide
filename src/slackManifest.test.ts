import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { slackManifest } from "./slackManifest";

describe("the Slack app manifest", () => {
  const manifest = JSON.parse(slackManifest("Ash"));

  it("uses Socket Mode, so nothing has to reach this machine", () => {
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });

  it("subscribes to exactly the events slack.rs forwards", () => {
    const rust = readFileSync(join(__dirname, "..", "src-tauri", "src", "slack.rs"), "utf8");
    expect(rust).toContain('"app_mention" => true');
    expect(rust).toContain('"message" if channel_type == "im"');
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.im"]);
  });

  it("never asks to read channels it is not mentioned in", () => {
    const scopes: string[] = manifest.oauth_config.scopes.bot;
    expect(scopes.some((s) => s.startsWith("channels:") || s.startsWith("groups:"))).toBe(false);
  });

  it("names the bot after the companion", () => {
    expect(manifest.features.bot_user.display_name).toBe("Ash");
    expect(JSON.parse(slackManifest("  ")).features.bot_user.display_name).toBe("Canopy");
  });
});
