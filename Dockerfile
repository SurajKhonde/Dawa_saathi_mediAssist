# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps for native modules (tesseract.js needs none, but pg can use them)
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Prune dev dependencies for smaller production image
RUN npm prune --production


# ---- Runtime stage ----
FROM node:20-alpine AS runtime

WORKDIR /app

# Tini for proper signal handling (Ctrl+C kills the process cleanly)
RUN apk add --no-cache tini

# Non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package*.json ./

USER app

# Health check uses the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
