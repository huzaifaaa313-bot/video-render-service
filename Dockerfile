# ============================================================
# Video Render Microservice — Docker Image
# Base: lightweight Node.js + FFmpeg + fonts for text rendering
# Hardened: non-root user, proper signal handling for FFmpeg
# child processes, container health checks.
# ============================================================

FROM node:18-alpine

# tini acts as a proper init process (PID 1). This matters because
# FFmpeg spawns child processes — without a real init system,
# Node.js alone can leave "zombie" processes behind and mishandle
# SIGTERM forwarding, which can cause silent slowdowns over time
# on a long-running free-tier container.
RUN apk add --no-cache ffmpeg font-dejavu tini

# Create a dedicated non-root user. Running as root inside a
# container is unnecessary risk — if the service is ever
# compromised via a malicious input, a non-root user limits
# what damage is possible.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy dependency manifest first for better Docker layer caching —
# dependencies only reinstall when package.json actually changes.
COPY package.json ./

RUN npm install --omit=dev && npm cache clean --force

# Copy application code and hand ownership to the non-root user
COPY . .
RUN chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
EXPOSE 3000

# Container-level health check. Render.com and most orchestrators
# use this to detect a hung or crashed service automatically,
# independent of whether the process technically still "exists."
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# tini as PID 1, forwarding signals correctly to Node and any
# FFmpeg child processes it spawns.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
