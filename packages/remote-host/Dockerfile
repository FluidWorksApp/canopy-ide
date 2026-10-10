FROM rust:1-bookworm AS hook-builder
WORKDIR /build
COPY hook-build/ ./
RUN cargo build --locked --release --manifest-path packages/agent-hook/Cargo.toml

# Split agents.lock.json into one fragment per CLI, so each CLI layer below is
# keyed only by its own version: bumping one CLI re-pulls only its layer.
FROM node:22-bookworm-slim AS agent-locks
COPY agents.lock.json /tmp/agents.lock.json
RUN node -e '\
const fs=require("fs"),lock=JSON.parse(fs.readFileSync("/tmp/agents.lock.json","utf8"));\
const out=(name,value)=>fs.writeFileSync(`/locks/${name}.json`,JSON.stringify(value));\
fs.mkdirSync("/locks");\
const npmNames={"@ampcode/cli":"amp","opencode-ai":"opencode","@oh-my-pi/pi-coding-agent":"omp"};\
const unknown=Object.keys(lock.npm).filter(name=>!npmNames[name]);\
if(unknown.length)throw Error("Add a Dockerfile layer for npm CLI: "+unknown.join(", "));\
for(const [name,file] of Object.entries(npmNames))out("npm-"+file,{[name]:lock.npm[name]});\
out("bun",{bun:lock.bun});out("aider",{aider:lock.aider});out("agy",{agy:lock.agy});\
for(const cli of ["cursor","grok"])out(cli,{installer:lock.installers[cli],version:lock[cli]});'

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
# One layer per agent CLI.
COPY --from=agent-locks /locks/bun.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh bun /tmp/locks/bun.json
COPY --from=agent-locks /locks/aider.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh aider /tmp/locks/aider.json
COPY --from=agent-locks /locks/agy.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh agy /tmp/locks/agy.json
COPY --from=agent-locks /locks/cursor.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh cursor /tmp/locks/cursor.json
COPY --from=agent-locks /locks/grok.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh grok /tmp/locks/grok.json
COPY --from=agent-locks /locks/npm-opencode.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh npm /tmp/locks/npm-opencode.json
COPY --from=agent-locks /locks/npm-omp.json /tmp/locks/
# oh-my-pi is ~725 MB compressed: ship a pinned launcher, install on first use.
RUN bash /usr/local/lib/canopy/install-agents.sh lazy-npm /tmp/locks/npm-omp.json omp
COPY --from=agent-locks /locks/npm-amp.json /tmp/locks/
RUN bash /usr/local/lib/canopy/install-agents.sh npm /tmp/locks/npm-amp.json
RUN npm install -g --cache /tmp/npm-cache --no-audit --no-fund typescript-language-server@5.3.0 typescript@5.9.3 && rm -rf /tmp/npm-cache
RUN npm install -g --cache /tmp/npm-cache --no-audit --no-fund @openai/codex@0.160.0 && rm -rf /tmp/npm-cache
RUN npm install -g --cache /tmp/npm-cache --no-audit --no-fund @anthropic-ai/claude-code@2.1.287 && rm -rf /tmp/npm-cache
RUN bash /usr/local/lib/canopy/install-agents.sh verify && rm -rf /tmp/locks
# Canopy's own runtime and code change most often.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache --no-audit --no-fund && rm -rf /tmp/npm-cache
COPY runner-harness.mjs agent-browser.mjs terminal-input.mjs terminal-mouse-modes.mjs workspace-file-paths.mjs scratch-environment.mjs browser-streams.mjs opencode-usage.mjs shared-git-launch.mjs shared-agent-launch.mjs git-identity.mjs activity.mjs agent-workspace.mjs agent-usage.mjs runner.mjs http.mjs history.mjs language.mjs native.mjs git-read.mjs terminal-screen.mjs agent-accounts.mjs profiles.mjs workspace-metrics.mjs open-url.mjs git-source.mjs git-clone.mjs file-write.mjs file-upload.mjs file-search.mjs session-processes.mjs session-digests.mjs session-transfer.mjs agent-integrations.mjs agent-events.mjs agent-mcp.mjs mcp-servers.mjs ./
COPY chrome-stream/ ./chrome-stream/
RUN chmod 755 /opt/canopy/open-url.mjs && ln -sf /opt/canopy/open-url.mjs /usr/local/bin/xdg-open
RUN usermod --login agent --home /home/agent --move-home node && groupmod --new-name agent node && mkdir /workspace && chown agent:agent /workspace
ENV NPM_CONFIG_PREFIX="/home/agent/.local"
ENV PATH="/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin"
USER 1000:1000
EXPOSE 8080
CMD ["node", "runner.mjs"]
