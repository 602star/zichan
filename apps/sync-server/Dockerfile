# Build from the REPO ROOT:  docker build -f apps/sync-server/Dockerfile -t zichan-sync .
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci
RUN npm run build --workspace @zichan/web
RUN npm run build --workspace @zichan/sync-server

FROM node:22-alpine
WORKDIR /app
# The esbuild entry bundles workspace packages and decimal.js; only Node builtins remain external.
COPY --from=build /repo/apps/sync-server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web-dist
ENV PORT=8787 DATA_DIR=/state/server WEB_DIST=/app/web-dist ENABLE_WEB=1 ENABLE_SYNC=1 REGISTRATION_MODE=invite BASE_PATH= TRUSTED_PROXIES=private ALLOW_INSECURE_HTTP=0
VOLUME /state
EXPOSE 8787
CMD ["node", "dist/server.mjs"]
