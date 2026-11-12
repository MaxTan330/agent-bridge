ARG BASE_IMAGE=node:26.13.0-bookworm-slim
FROM ${BASE_IMAGE} AS base
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
ENV npm_config_registry=${NPM_REGISTRY} \
    TZ=Asia/Shanghai
RUN sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g; s|https://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client ripgrep tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.14.0 \
    && npm cache clean --force
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build && pnpm test:bundle

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM base AS runtime
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/bridge /data/workspace /data/claude \
    && chown -R node:node /data
ENV NODE_ENV=production HOME=/home/node CLAUDE_CONFIG_DIR=/data/claude
USER node

RUN node --version && pnpm --version && git --version && ssh -V && rg --version \
    && test -w /data/bridge && test -w /data/workspace && test -w /data/claude
CMD ["node", "dist/index.cjs"]
