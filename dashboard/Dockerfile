# Dashboard — Next.js 14. Build stage compiles; runtime stage runs the same
# start.js launcher the host/PM2 setup uses (kept `next start`, not standalone,
# so the run contract is unchanged). Build context is the dashboard/ directory.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Next resolves next.config rewrites() at BUILD time into routes-manifest.json;
# `next start` reads that manifest, not the live env. So the server-side proxy
# target (/api/* → the api container) must be baked here, not just at runtime.
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
# Browser-side API key — Next.js inlines NEXT_PUBLIC_* into the client bundle
# at build time, not read at runtime, so it has to be baked in here (matches
# API_INTERNAL_URL's reasoning above). Without this every mutating request
# the dashboard makes from the browser (login, manual scrape triggers, etc.)
# 401s with "missing X-API-Key header" — api's middleware requires it whenever
# API_KEY is set, and the browser has no other way to know what value to send.
ARG NEXT_PUBLIC_API_KEY=""
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
# Carry the built app + its production deps. .next holds the build output;
# start.js spawns node_modules/next to serve it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/start.js ./start.js

EXPOSE 3000
CMD ["node", "start.js"]
