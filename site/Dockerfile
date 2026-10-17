# Landing page + downloadable agentmgr bundles, built from the repo root.
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json README.md ./
COPY bin bin
COPY src src
COPY public public
COPY scripts scripts
RUN scripts/build-release.sh /dist darwin-arm64 darwin-x64 linux-x64 \
 && cd /dist && for f in agentmanager-*-*.tar.gz; do \
      t=$(echo "$f" | sed -E 's/^agentmanager-[0-9.]+-(.*)\.tar\.gz$/\1/'); \
      cp "$f" "agentmanager-$t.tar.gz"; done \
 && sha256sum *.tar.gz > SHA256SUMS \
 && node -p "require('/src/package.json').version" > VERSION

FROM node:22-bookworm-slim
WORKDIR /site
COPY site/server.js ./
COPY site/public public
COPY --from=build /dist public/downloads
ENV NODE_ENV=production
CMD ["node", "server.js"]
