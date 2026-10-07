# Local control plane image: canopy-website source at the requested revision
# (copied into ./website by run.mjs) plus the replica adapter in ./control-plane.
FROM docker:28-cli AS dockercli
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux e2fsprogs ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /website
COPY website/package.json website/pnpm-lock.yaml website/pnpm-workspace.yaml ./
RUN corepack enable && CI=1 pnpm install --prod --frozen-lockfile --ignore-scripts
COPY website/ ./
COPY control-plane/ /replica/
RUN ln -s /website/node_modules /replica/node_modules
CMD ["node","--import","/replica/register.mjs","/replica/server.mjs"]
