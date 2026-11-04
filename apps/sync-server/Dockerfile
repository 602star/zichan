# syntax=docker/dockerfile:1.7
# Build from the REPO ROOT:  docker build -f apps/sync-server/Dockerfile -t zichan-sync .
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace @zichan/web
RUN npm run build --workspace @zichan/sync-server

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
# Both runtime entries bundle workspace packages and dependencies; only Node builtins remain external.
# Keep TypeScript's intermediate JS, declarations and source maps out of the runtime image.
COPY --from=build /repo/apps/sync-server/dist/server.mjs ./dist/server.mjs
COPY --from=build /repo/apps/sync-server/dist/maintenance.mjs ./dist/maintenance.mjs
COPY --from=build /repo/apps/web/dist ./web-dist
COPY --from=build /repo/apps/sync-server/dist/server.mjs ./bootstrap/release/dist/server.mjs
COPY --from=build /repo/apps/sync-server/dist/maintenance.mjs ./bootstrap/release/dist/maintenance.mjs
COPY --from=build /repo/apps/web/dist ./bootstrap/release/web-dist
COPY --from=build /repo/apps/sync-server/package.json ./bootstrap/release/package.json
COPY apps/sync-server/scripts/update-launcher.mjs ./bootstrap/update-launcher.mjs
COPY apps/sync-server/scripts/pre-update-backup.mjs ./bootstrap/pre-update-backup.mjs
COPY apps/sync-server/keys/update-public.pem ./bootstrap/update-public.pem
ARG ZICHAN_REQUIRE_RELEASE_TOKEN=0
RUN --mount=type=secret,id=release_token \
    if [ "$ZICHAN_REQUIRE_RELEASE_TOKEN" = 1 ]; then \
      test -s /run/secrets/release_token && \
      install -d -o node -g node -m 700 /keys && \
      install -o node -g node -m 600 /run/secrets/release_token /keys/github-token; \
    fi
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/state/server WEB_DIST=/app/web-dist ENABLE_WEB=1 ENABLE_SYNC=1 REGISTRATION_MODE=invite BASE_PATH= TRUSTED_PROXIES= ALLOW_INSECURE_HTTP=0
# Run unprivileged: Docker initializes both named volumes with node-owned directories.
RUN mkdir -p /state/server /backups /app/runtime /keys && chown -R node:node /state /backups /app
VOLUME /state
EXPOSE 8787
USER node
CMD ["node", "bootstrap/update-launcher.mjs"]
