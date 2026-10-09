// The Slack app a user creates for their own workspace ("Create an app → From
// a manifest"). Socket Mode, so nothing has to reach this machine; the scopes
// are exactly what slack.rs and slackBridge.ts use and no more.

export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
] as const;

export const SLACK_BOT_EVENTS = ["app_mention", "message.im"] as const;

export function slackManifest(name: string): string {
  const display = (name.trim() || "Canopy").slice(0, 35);
  return JSON.stringify(
    {
      display_information: { name: display, description: "Your Canopy companion, in Slack." },
      features: {
        app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: display, always_online: true },
      },
      oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
      settings: {
        event_subscriptions: { bot_events: SLACK_BOT_EVENTS },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
