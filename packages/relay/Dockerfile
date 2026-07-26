FROM oven/bun:1.3.14-alpine

WORKDIR /app
COPY package.json ./package.json
COPY packages/mobile-protocol/package.json ./packages/mobile-protocol/package.json
COPY packages/relay/package.json ./packages/relay/package.json
COPY bun.lock ./bun.lock
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/mobile-protocol ./packages/mobile-protocol
COPY packages/relay ./packages/relay

WORKDIR /app/packages/relay
ENV HOSTNAME=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "start"]
