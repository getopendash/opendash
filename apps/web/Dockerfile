# The web image (docs/operations/HOSTING.md): the Next.js app as a standalone server. Built from the
# repository root: docker build -f apps/web/Dockerfile .
# It never migrates: the worker image's `setup` does, before a version starts serving.

FROM node:24.16.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
# No cache mount: Railway's builder accepts one only with its service id written in, which would tie this file to
# one deployment.
RUN pnpm install --frozen-lockfile --filter "@opendash/web..."
RUN pnpm --filter @opendash/web build

FROM node:24.16.0-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server and what it traced (the PDF fonts included), then the files it doesn't copy: the built static
# files, and the public folder (the logo emails show).
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/docker-entrypoint.sh ./docker-entrypoint.sh
# The licences travel with the code they cover.
COPY --from=build --chown=node:node /app/LICENSE /app/NOTICE ./
COPY --from=build --chown=node:node /app/licenses ./licenses
COPY --from=build --chown=node:node /app/ee/LICENSE ./ee/LICENSE
COPY --from=build --chown=node:node /app/packages/pdf/fonts/OFL-Geist.txt /app/packages/pdf/fonts/OFL-Noto.txt ./packages/pdf/fonts/
COPY --from=build --chown=node:node /app/packages/ui/vendor/pair/LICENSE ./packages/ui/vendor/pair/LICENSE
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
