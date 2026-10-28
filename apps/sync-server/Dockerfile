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
COPY --from=build /repo/apps/sync-server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web-dist
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/state/server WEB_DIST=/app/web-dist ENABLE_WEB=1 ENABLE_SYNC=1 REGISTRATION_MODE=invite BASE_PATH= TRUSTED_PROXIES= ALLOW_INSECURE_HTTP=0
# Run unprivileged: Docker initializes both named volumes with node-owned directories.
RUN mkdir -p /state/server /backups && chown -R node:node /state /backups /app
VOLUME /state
EXPOSE 8787
USER node
CMD ["node", "dist/server.mjs"]
