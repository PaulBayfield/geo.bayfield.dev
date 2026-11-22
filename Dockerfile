# Web build + API server in one image (the database is PostGIS, see docker-compose.yml).
#   docker build -t geopol .
#   docker run -p 8840:8840 --env-file server/.env geopol

FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY server/scripts ./scripts
COPY --from=web /app/dist /app/dist
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=8840 \
    DIST_DIR=/app/dist \
    APP_VERSION=$APP_VERSION
EXPOSE 8840
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:8840/api/health || exit 1
CMD ["node", "src/index.ts"]
