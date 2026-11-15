# The worker image (docs/operations/HOSTING.md): the job runner, its pools chosen with WORKER_POOLS, and
# `setup`, which readies the database for this version. Built from the repository root:
# docker build -f apps/worker/Dockerfile .
# Runs the TypeScript sources through tsx, as in development: the workspace packages export their sources.

FROM node:24.16.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS install
COPY . .
# Production dependencies of the worker and the packages it uses, nothing else (no web app, no test tools).
# No cache mount: Railway's builder accepts one only with its service id written in, which would tie this file to
# one deployment.
RUN pnpm install --frozen-lockfile --prod --filter "@opendash/worker..."

FROM node:24.16.0-bookworm-slim AS worker
ENV NODE_ENV=production WORKER_POOLS=all
WORKDIR /app
COPY --from=install --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/LICENSE /app/NOTICE ./
COPY --from=install --chown=node:node /app/licenses ./licenses
COPY --from=install --chown=node:node /app/node_modules ./node_modules
COPY --from=install --chown=node:node /app/scripts ./scripts
COPY --from=install --chown=node:node /app/packages ./packages
COPY --from=install --chown=node:node /app/ee ./ee
COPY --from=install --chown=node:node /app/apps/worker ./apps/worker
USER node
WORKDIR /app/apps/worker
# `docker run <image> setup` readies the database; anything else runs as given.
ENTRYPOINT ["/app/apps/worker/docker-entrypoint.sh"]
CMD ["start"]
