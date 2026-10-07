# Shared CLI execution checkpoint — 2026-10-05

The gateway now prepares agent/Git facades during authenticated `/sessions` startup using the requested project ID and fresh trusted grants. The runner receives only facade URLs and random scoped credentials. Provider access/refresh keys, management signing keys, billing controls and Docker controls remain outside development containers.

Claude and Codex wrappers route generation through the trusted host. Claude token counting/model discovery and Codex model discovery have fixed routes. Anthropic capability/version headers are bounded printable values; they cannot replace authentication or destination headers. Each provider request creates and consumes a private single-use execution ticket, then uses the same live-authority broker as the explicit transport.

A facade keeps its original actor, workspace, project and grant generation. Member requests resolve the latest matching member lease. IDE heartbeats renew that lease; an optional management-only detached renewal endpoint can renew it while trusted Docker inspection confirms a running member container, subject to fresh external membership/generation checks and a 24-hour bound since actual IDE admission. Owner facade delegation is internal only, bound to project/session and workspace generation, and bounded to 24 hours since authenticated owner activity. It requires trusted Docker running state and fresh external running-state authority; it never mints or exposes an owner administrative connection token. Revocation, lease expiry, session stop, observed exit, downstream cancellation and bounded provider deadlines end access. Detached renewal uses a 30-second purpose-bound HMAC request with a random nonce. The host accepts only a server-signed V2 token for the original member, grant version and scope; revoked or rejoined access cannot be adopted silently. Without the configured endpoint, an expired IDE lease ends access. Collaboration publications use their independent registry and do not enter external member renewal.

Git smart HTTP supports fetch/push advertisement and pack exchange only. Its repository comes from the encrypted vault. The generated Git launcher selects exact shared remote URLs; similar-name personal repositories retain personal routing and credentials. Member author/committer defaults continue through the existing trusted Git identity environment. Multi-remote `fetch --all` runs per-remote fetches with a separate exact shared-remote selection, honors skipFetchAll, and retains personal routing for every other remote. Git payloads retain the existing 4 MiB request bound.

## Subscription credentials

Owner import can submit normalized OAuth records directly to the host:

```
{ provider: "anthropic" | "openai", authType: "oauth",
  token: "access token", refreshToken: "refresh token",
  expiresAt: <epoch milliseconds>,
  providerAccountId: "required for OpenAI" }
```

Access/refresh tokens are encrypted together. Store, removal and renewal serialize per workspace/account so a delayed refresh cannot recreate a removed account. Refresh routes and public client IDs are fixed, response size/deadline bounded, rotated refresh tokens persisted, and a changed Codex account claim rejected. Developer containers receive neither access nor refresh tokens. Anthropic OAuth uses Bearer authentication plus the OAuth capability; Codex OAuth uses the fixed ChatGPT backend and trusted account header.

Primary implementation references:

- [Claude gateway protocol and subscription headers](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Claude subscription gateway behavior](https://code.claude.com/docs/en/llm-gateway)
- [Codex 0.160.0 OAuth renewal](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/login/src/auth/manager.rs)
- [Codex 0.160.0 provider models](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/model-provider/src/models_endpoint.rs)

Claude refresh endpoint/client ID were also checked against the installed official Claude Code 2.1.287 executable, without opening any personal credential store.

## Evidence and remaining validation

53 focused CLI tests plus eight detached-renewal helper/lease tests passed: synthetic gateway session startup/renewal, owner state denial, fixed provider endpoints, actual executable wrappers and local Git configuration, token/header leakage denial, replay protections, OAuth concurrency/rotation/removal/account-switch and hanging forged responses, and installer/image dependency checks. Subsequent final integration checks are recorded separately.

These are source implementation results. No real provider account was imported or called, no VM was started, and no deployment was performed by this implementation task. Real installed CLI/provider compatibility, host firewall behavior, updated image/DMG installation and deployed multi-member adversarial tests remain to be verified. Detached renewal is a bounded authorization extension, not process redundancy. The external endpoint must be deployed alongside the host renewal URL; its production activation is tracked separately.
