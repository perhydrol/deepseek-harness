# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:0.13.1 AS uv
FROM node:24-trixie-slim AS proxy-build
RUN npm install --global pnpm@11.25.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY tsconfig.tests.json eslint.config.js ./
COPY tests ./tests
RUN pnpm check && pnpm test && pnpm build && pnpm prune --prod

FROM node:24-trixie-slim
ARG DSH_VERSION=0.2.1-rc.2
COPY --from=uv /uv /uvx /usr/local/bin/
# Debian security updates are selected when rebuilding the image.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends -y bash ca-certificates curl fish git neovim openssh-client python3 ripgrep supervisor \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/dsh
RUN npm install --omit=dev --save-exact "@deepseek-ai/dsh@${DSH_VERSION}" \
    && npm cache clean --force
COPY --from=proxy-build /app/package.json /opt/auth/package.json
COPY --from=proxy-build /app/node_modules /opt/auth/node_modules
COPY --from=proxy-build /app/dist /opt/auth/dist
COPY deploy/supervisord.conf /etc/supervisor/dsh.conf
ENV NODE_ENV=production HOME=/home/node DSH_HOME=/var/lib/dsh \
    UV_CACHE_DIR=/var/lib/uv/cache UV_PYTHON_INSTALL_DIR=/var/lib/uv/python/managed \
    UV_PYTHON_BIN_DIR=/var/lib/uv/python/bin UV_TOOL_DIR=/var/lib/uv/python/tools \
    UV_TOOL_BIN_DIR=/var/lib/uv/python/bin VIRTUAL_ENV=/var/lib/uv/python/venv \
    PATH=/var/lib/uv/python/venv/bin:/var/lib/uv/python/bin:/opt/dsh/node_modules/.bin:${PATH} \
    DSH_TELEMETRY_DISABLED=1 TMPDIR=/data/tmp
RUN mkdir -p /data/dsh /data/auth /data/uv /data/tmp /run/dsh \
    && mv /home/node /data/home \
    && ln -s /data/home /home/node \
    && ln -s /data/dsh /var/lib/dsh \
    && ln -s /data/auth /var/lib/dsh-auth \
    && ln -s /data/uv /var/lib/uv \
    && chown -R node:node /data /run/dsh \
    && chmod 700 /data /data/auth /data/dsh /data/tmp /run/dsh
USER 1000:1000
WORKDIR /home/node
RUN uv venv --python /usr/bin/python3 /var/lib/uv/python/venv
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
    CMD ["node", "/opt/auth/dist/healthcheck.js"]
ENTRYPOINT ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/dsh.conf"]
