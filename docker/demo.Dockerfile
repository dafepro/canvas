# Build the browser demo and serve the static bundle.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /src
COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
COPY packages/client/package.json packages/client/
COPY apps/demo/package.json apps/demo/
RUN pnpm install --frozen-lockfile=false
COPY . .
ARG VITE_SERVER_URL=http://localhost:8081
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
# The workspace files were copied after the install, so skip the freshness
# check that would otherwise re-run the install inside the build step.
ENV npm_config_verify_deps_before_run=false
RUN pnpm --filter @canvas-physics/demo build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/demo/dist /usr/share/nginx/html
EXPOSE 80
