# Build from the REPO ROOT:  docker build -f apps/sync-server/Dockerfile -t zichan-sync .
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace @zichan/web
RUN npm run build --workspace @zichan/sync-server

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
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
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/state/server WEB_DIST=/app/web-dist ENABLE_WEB=1 ENABLE_SYNC=1 REGISTRATION_MODE=invite BASE_PATH= TRUSTED_PROXIES= ALLOW_INSECURE_HTTP=0
# Run unprivileged: Docker initializes both named volumes with node-owned directories.
RUN mkdir -p /state/server /backups /app/runtime /keys && chown -R node:node /state /backups /app
VOLUME /state
EXPOSE 8787
USER node
CMD ["node", "bootstrap/update-launcher.mjs"]
