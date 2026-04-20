# ── Stage 1: Build ────────────────────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile

COPY packages/ packages/

RUN pnpm run build

# ── Stage 2: Production (server + web UI) ─────────────────────
FROM node:22-slim AS production

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/cli/dist packages/cli/dist
COPY --from=builder /app/packages/web/build packages/web/build

# Default config location (mount your own at runtime)
COPY microagent.config.json /etc/microagent/config.json

ENV NODE_ENV=production
ENV MICROAGENT_CONFIG=/etc/microagent/config.json

EXPOSE 3100

# Default: serve API + web UI
CMD ["node", "packages/cli/dist/bin.js", "ui", "-c", "/etc/microagent/config.json", "--host", "0.0.0.0", "--port", "3100"]
