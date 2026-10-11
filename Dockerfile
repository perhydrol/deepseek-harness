# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-trixie-slim
FROM ${NODE_IMAGE} AS base

WORKDIR /opt/harness
COPY package.json ./
# The repository owns the pnpm version; the linter cannot evaluate this substitution.
# hadolint ignore=DL3016
RUN npm install --global "$(node -p 'require("./package.json").packageManager')" \
    && npm cache clean --force

FROM base AS build
# Debian security updates are selected when rebuilding the image.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential ca-certificates curl git musl-tools pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*

ARG BUILD_NODE_OPTIONS=--max-old-space-size=4096
ARG DSH_CLIENT_COMMIT_HASH
ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_OPTIONS=${BUILD_NODE_OPTIONS} \
    DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm run build --artifacts-only \
    && pnpm exec tsx native/system/scripts/build.ts

FROM base AS runtime
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        bash ca-certificates curl git openssh-client python3 ripgrep tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/dsh /workspace \
    && chown node:node /var/lib/dsh /workspace \
    && chmod 700 /var/lib/dsh

# Retain workspace links and private Hydrogen packages without registry publication.
COPY --from=build /opt/harness /opt/harness
COPY --chown=node:node deploy/docker/profile/ /var/lib/dsh/profiles/server/
COPY deploy/docker/auth.yml /etc/hydrogen-harness/auth.yml
ENV NODE_ENV=production \
    DSH_HOME=/var/lib/dsh
WORKDIR /workspace
USER 1000:1000
VOLUME ["/var/lib/dsh", "/workspace"]
EXPOSE 3080
ENTRYPOINT ["tini", "--", "node", "/opt/harness/apps/cli/lib/bin.js"]
CMD ["--profile", "server", "--patch", "/etc/hydrogen-harness/auth.yml", "--host", "127.0.0.1", "--port", "3080", "--no-open", "--public-url", "https://harness.example.com/", "--trusted-host", "harness.example.com"]
