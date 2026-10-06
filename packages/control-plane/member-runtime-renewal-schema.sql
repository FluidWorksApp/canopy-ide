-- Trusted-host renewal replay protection. No provider credentials or billing.
CREATE TABLE IF NOT EXISTS member_runtime_renewal_nonce (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{32}$'),
 member_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 generation bigint NOT NULL CHECK(generation>=0),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,nonce)
);
CREATE INDEX IF NOT EXISTS member_runtime_renewal_nonce_expiry_idx ON member_runtime_renewal_nonce(workspace_id,expires_at);
