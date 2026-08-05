FROM node:26-trixie-slim AS base

WORKDIR /app

FROM base AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]