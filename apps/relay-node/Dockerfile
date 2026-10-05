# Official Docker Hub multi-architecture index resolved 2026-09-29 with
# docker buildx imagetools inspect node:22.23.1-bookworm-slim
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/relay-core/package.json packages/relay-core/tsconfig.json ./packages/relay-core/
COPY packages/relay-core/src ./packages/relay-core/src
COPY apps/relay-node/package.json apps/relay-node/tsconfig.json apps/relay-node/tsdown.config.ts ./apps/relay-node/
COPY apps/relay-node/src ./apps/relay-node/src
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @shellbell/relay-node... && pnpm -F @shellbell/relay-node build
RUN mkdir -p /runtime/node_modules && cp -R apps/relay-node/dist /runtime/dist && cp -RL node_modules/ws /runtime/node_modules/ws
RUN for package in @noble/ciphers @noble/curves @noble/hashes cborg zod; do mkdir -p "/runtime/licenses/$package" && cp "node_modules/$package/LICENSE" "node_modules/$package/package.json" "/runtime/licenses/$package/"; done

FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
WORKDIR /app
COPY --from=build /runtime/ ./
COPY apps/relay-node/package.json LICENSE TRADEMARK.md THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /var/lib/shellbell && chown 1000:1000 /var/lib/shellbell && chmod 0700 /var/lib/shellbell
USER 1000:1000
VOLUME ["/var/lib/shellbell"]
EXPOSE 8787
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--data-dir", "/var/lib/shellbell", "--host", "0.0.0.0", "--port", "8787"]
