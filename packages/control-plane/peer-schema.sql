-- Public device identities and short-lived opaque relay delivery only.
CREATE TABLE IF NOT EXISTS peer_device (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id),
 public_keys jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS peer_device_user_idx ON peer_device(user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS peer_relay (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES team(id),
 sender_device uuid NOT NULL REFERENCES peer_device(id), recipient_device uuid NOT NULL REFERENCES peer_device(id),
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS peer_relay_destination_idx ON peer_relay(recipient_device,expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS peer_relay_message_idx ON peer_relay(sender_device,recipient_device,(envelope->>'id'));
