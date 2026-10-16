# ==============================================================================
# GONGO Unified Backend (Customer + Partner + Admin) — production image
# ==============================================================================
# Build from the server/ directory:   docker build -t gongo-api .
# Runs `node src/server.js` (same as `npm start`) on $PORT (default 8080).
# All configuration comes from platform environment variables; no .env is baked in.
# Migrations are NOT run on start — see docs/DEPLOYMENT.md.
# ==============================================================================

FROM node:20-alpine AS dependencies
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production \
    PORT=8080

COPY --chown=node:node --from=dependencies /usr/src/app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node Customer/package.json ./Customer/package.json
COPY --chown=node:node Customer/src/ ./Customer/src/
COPY --chown=node:node Customer/database/ ./Customer/database/
COPY --chown=node:node Partner/package.json ./Partner/package.json
COPY --chown=node:node Partner/src/ ./Partner/src/
COPY --chown=node:node Partner/database/ ./Partner/database/
COPY --chown=node:node Admin/package.json ./Admin/package.json
COPY --chown=node:node Admin/src/ ./Admin/src/
COPY --chown=node:node Admin/database/ ./Admin/database/

USER node
EXPOSE 8080

# Liveness only; use GET /health/ready for platform readiness checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
