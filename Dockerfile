# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Reproducible install when a lockfile is committed, best effort otherwise.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev --no-audit --no-fund; fi

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Run unprivileged; the node image already ships a "node" user.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
