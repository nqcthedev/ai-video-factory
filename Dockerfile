# AI Video Factory — container image with ffmpeg, Chromium (Playwright) and Node 22.
# NOTE: written for portability but not built/tested in the original dev environment (no Docker daemon there).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production \
    AVF_MODELS_DIR=/models \
    AVF_JOBS_DIR=/data/jobs \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
# Chromium + its system libraries, at the version matching the installed playwright package.
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
# Bake the Kokoro model in with: docker build --build-arg KOKORO=1 .  (~350 MB, from GitHub releases)
ARG KOKORO=0
RUN if [ "$KOKORO" = "1" ]; then node dist/cli.js models download; fi
VOLUME ["/data", "/models"]
WORKDIR /data
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["doctor"]
