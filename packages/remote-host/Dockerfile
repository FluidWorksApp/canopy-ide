FROM rust:1-bookworm AS hook-builder
WORKDIR /build
COPY hook-build/ ./
RUN cargo build --locked --release --manifest-path packages/agent-hook/Cargo.toml

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git openssh-client bash ca-certificates xvfb x11vnc openbox xterm chromium xfce4 xfce4-terminal thunar dbus-x11 adwaita-icon-theme hicolor-icon-theme tango-icon-theme librsvg2-common && rm -rf /var/lib/apt/lists/*
COPY --from=hook-builder /build/packages/agent-hook/target/release/canopy-hook /usr/local/bin/canopy-hook
WORKDIR /opt/canopy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npm install -g @anthropic-ai/claude-code@2.1.287 @openai/codex@0.160.0 typescript-language-server@5.3.0 typescript@5.9.3
COPY agents.lock.json install-agents.sh ./
RUN bash install-agents.sh
COPY install-native-build.sh ./
RUN bash install-native-build.sh
RUN apt-get update && apt-get install -y --no-install-recommends nano vim-tiny && rm -rf /var/lib/apt/lists/*
COPY git-identity.mjs activity.mjs agent-workspace.mjs agent-usage.mjs runner.mjs http.mjs history.mjs language.mjs native.mjs terminal-screen.mjs agent-accounts.mjs profiles.mjs workspace-metrics.mjs open-url.mjs git-source.mjs git-clone.mjs file-write.mjs file-upload.mjs file-search.mjs session-processes.mjs session-digests.mjs session-transfer.mjs agent-integrations.mjs agent-events.mjs agent-mcp.mjs ./
RUN chmod 755 /opt/canopy/open-url.mjs && ln -sf /opt/canopy/open-url.mjs /usr/local/bin/xdg-open
RUN usermod --login agent --home /home/agent --move-home node && groupmod --new-name agent node && mkdir /workspace && chown agent:agent /workspace
ENV NPM_CONFIG_PREFIX="/home/agent/.local"
ENV PATH="/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin"
USER 1000:1000
EXPOSE 8080
CMD ["node", "runner.mjs"]
