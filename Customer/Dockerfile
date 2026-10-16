# ==============================================================================
# GONGO Customer Backend — Production Dockerfile
# ==============================================================================
# Multi-stage production container build.
# Security features:
#   - Minimal Alpine Linux base image (node:20-alpine)
#   - Runs under non-root unprivileged user ('node')
#   - Deterministic dependency resolution (npm ci --omit=dev)
#   - Built-in container health check probe
#   - Zero credentials or dev files baked into runtime image
# ==============================================================================

# ── Stage 1: Build & Dependencies ──────────────────────────────────────────────
FROM node:20-alpine AS dependencies

WORKDIR /usr/src/app

# Install build dependencies required by native packages if any
RUN apk add --no-cache python3 make g++

# Copy package manifests for layer caching
COPY package.json package-lock.json ./

# Install only production dependencies deterministically
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ── Stage 2: Production Runtime ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

LABEL maintainer="GONGO Engineering <devops@gongo.in>" \
      description="GONGO Customer Backend Production API" \
      version="1.0.0"

WORKDIR /usr/src/app

# Enforce production node environment
ENV NODE_ENV=production \
    PORT=3000

# Copy node_modules from dependencies stage
COPY --chown=node:node --from=dependencies /usr/src/app/node_modules ./node_modules

# Copy application source code and database migrations
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node database/ ./database/

# Switch to unprivileged non-root user for security
USER node

# Expose standard API port
EXPOSE 3000

# Built-in lightweight Docker healthcheck probing /health/live
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start the Node.js production server
CMD ["node", "src/server.js"]
