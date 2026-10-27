FROM rust:1-bookworm AS hook-builder
WORKDIR /build
COPY hook-build/ ./
RUN cargo build --locked --release --manifest-path packages/agent-hook/Cargo.toml

# Split agents.lock.json into one fragment per tool, so each tool's layer below
# is keyed only by its own pin: bumping one tool re-pulls only its layer.
FROM node:22-bookworm-slim AS agent-locks
COPY agents.lock.json /tmp/agents.lock.json
RUN node -e '\
const fs=require("fs"),lock=JSON.parse(fs.readFileSync("/tmp/agents.lock.json","utf8"));\
fs.mkdirSync("/locks");fs.copyFileSync("/tmp/agents.lock.json","/locks/all.json");\
for(const [name,tool] of Object.entries(lock))fs.writeFileSync(`/locks/${name}.json`,JSON.stringify({[name]:tool}));'

FROM node:22-bookworm-slim
# Layers run from least to most frequently changed.
# OS, desktop and the packages the tool installers need.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip make g++ git gh curl ripgrep jq unzip zstd openssh-client bash ca-certificates libsecret-1-0 dbus-x11 xvfb x11vnc openbox xterm chromium xfce4 xfce4-session xfce4-panel xfdesktop4 xfwm4 xfce4-terminal xfce4-settings thunar adwaita-icon-theme hicolor-icon-theme tango-icon-theme librsvg2-common nano vim-tiny && rm -rf /var/lib/apt/lists/*
# Native desktop build prerequisites and the Rust toolchain.
COPY install-native-build.sh /tmp/install-native-build.sh
RUN bash /tmp/install-native-build.sh && rm /tmp/install-native-build.sh
COPY --from=hook-builder /build/packages/agent-hook/target/release/canopy-hook /usr/local/bin/canopy-hook
WORKDIR /opt/canopy
COPY install-agents.sh /usr/local/lib/canopy/install-agents.sh
# One layer per tool, in agents.lock.json order (agents-lock.test.mjs checks both agree).
COPY --from=agent-locks /locks/bun.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/bun.json
COPY --from=agent-locks /locks/aider.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/aider.json
COPY --from=agent-locks /locks/agy.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/agy.json
COPY --from=agent-locks /locks/cursor.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/cursor.json
COPY --from=agent-locks /locks/grok.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/grok.json
COPY --from=agent-locks /locks/opencode.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/opencode.json
# oh-my-pi is ~725 MB compressed: the lock ships it as a lazy launcher.
COPY --from=agent-locks /locks/omp.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/omp.json
COPY --from=agent-locks /locks/amp.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/amp.json
COPY --from=agent-locks /locks/typescript.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/typescript.json
COPY --from=agent-locks /locks/typescript-language-server.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/typescript-language-server.json
COPY --from=agent-locks /locks/codex.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/codex.json
COPY --from=agent-locks /locks/claude.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh /tmp/locks/claude.json
COPY --from=agent-locks /locks/all.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh verify /tmp/locks/all.json && rm -rf /tmp/locks
# Canopy's own runtime and code change most often.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache --no-audit --no-fund && rm -rf /tmp/npm-cache
COPY runner-harness.mjs agent-browser.mjs terminal-input.mjs terminal-mouse-modes.mjs workspace-file-paths.mjs scratch-environment.mjs browser-streams.mjs opencode-usage.mjs shared-git-launch.mjs shared-agent-launch.mjs git-identity.mjs activity.mjs agent-workspace.mjs agent-usage.mjs runner.mjs http.mjs history.mjs language.mjs native.mjs git-read.mjs git-history.mjs terminal-screen.mjs agent-accounts.mjs profiles.mjs workspace-metrics.mjs open-url.mjs git-source.mjs git-clone.mjs file-write.mjs file-upload.mjs file-search.mjs session-processes.mjs session-digests.mjs session-transfer.mjs agent-integrations.mjs agent-events.mjs agent-mcp.mjs mcp-servers.mjs claude-ide.mjs receipt-check.mjs clipboard-shims.mjs session-transcript.mjs git-ops.mjs checkout-errors.mjs workspace-misc.mjs mcp-client.mjs spot-index.mjs workspace-tools.mjs workspace-cleanup.mjs lsp.mjs github.mjs task-store.mjs workflow-store.mjs structured-runner.mjs turns.mjs provenance.mjs pr-observer.mjs channels.mjs native-commands.mjs gates.mjs ./
COPY chrome-stream/ ./chrome-stream/
RUN chmod 755 /opt/canopy/open-url.mjs && ln -sf /opt/canopy/open-url.mjs /usr/local/bin/xdg-open
RUN usermod --login agent --home /home/agent --move-home node && groupmod --new-name agent node && mkdir /workspace && chown agent:agent /workspace
ENV NPM_CONFIG_PREFIX="/home/agent/.local"
# agents.lock.json pins every CLI by version and checksum; the CLIs that update
# themselves in the background would otherwise replace the pinned build inside
# the persistent home (Claude Code was seen at 2.1.310 over a 2.1.287 pin).
# These are each CLI's own "no background update" switch — a manual update
# still works. The desktop's "Keep agent CLIs up to date" setting never
# reaches a workspace; image releases are its update path (see src/projects.ts
# AgentCliAutoUpdate for the per-CLI evidence).
ENV DISABLE_AUTOUPDATER="1" GROK_DISABLE_AUTOUPDATER="1" AGY_CLI_DISABLE_AUTO_UPDATE="true"
ENV PATH="/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin"
USER 1000:1000
EXPOSE 8080
CMD ["node", "runner.mjs"]
