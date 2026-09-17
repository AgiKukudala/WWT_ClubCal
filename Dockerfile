# syntax=docker/dockerfile:1
# One image for the web/API process, the worker and one-off CLI tasks.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    STATIC_DIR=/app/web/dist \
    MIGRATIONS_DIR=/app/server/migrations
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY server/migrations server/migrations
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
