FROM oven/bun:1.3.14 AS build
WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/mobile-web build

FROM nginx:1.27-alpine
COPY --from=build /workspace/packages/mobile-web/dist /usr/share/nginx/html
COPY packages/mobile-web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
