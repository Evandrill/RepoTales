# frontend/Dockerfile
#
# Multi-stage: Node 20 builds the static bundle, Nginx serves it and proxies
# /api to the backend container (same-origin, so no CORS in production).
FROM node:20-alpine AS build

WORKDIR /app

# Lockfile first so `npm ci` is cached independently of source edits.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# `src/api/saga.ts` reads VITE_API_BASE at build time; /api is correct behind
# the Nginx proxy below.
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}

RUN npm run build

FROM nginx:1.27-alpine AS runtime

# The SPA needs history fallback + an /api reverse proxy.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
