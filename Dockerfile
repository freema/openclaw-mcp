# ---- Builder stage ----
FROM node:20-slim AS builder

WORKDIR /app

# Install tini for proper PID 1 signal handling
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies (leverage Docker layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build configuration
COPY tsup.config.ts tsconfig.json ./
COPY src/ src/

# Build the project
RUN npm run build

# Prune dev dependencies for a lean production image
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:20-slim AS runtime

ARG VERSION=dev

# OCI image labels
LABEL org.opencontainers.image.title="openclaw-mcp" \
      org.opencontainers.image.description="Model Context Protocol server for OpenClaw AI assistant integration" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/freema/openclaw-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.freema/openclaw-mcp"

# Copy tini binary from builder
COPY --from=builder /usr/bin/tini /usr/bin/tini

WORKDIR /app

# Copy only the production artifacts
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/package.json package.json

# Environment defaults
ENV NODE_ENV=production
ENV OPENCLAW_URL=http://openclaw:18789

# Run as non-root user
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw r.status}).then(()=>process.exit(0)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "node", "dist/index.js", "--transport", "sse"]
