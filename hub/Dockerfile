# The hub only: one place for agents on several machines (docs/distributed.md).
# Build from the repo root:  docker build -f hub/Dockerfile .
# Railway: set RAILWAY_DOCKERFILE_PATH=hub/Dockerfile, AGENTMGR_HUB_TOKEN, and a volume at /data.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
# Only what the hub needs (server, WebSockets, the browser terminal): no node-pty, no Claude.
RUN node -e "const p=require('./package.json');const d=p.dependencies;p.dependencies={express:d.express,ws:d.ws,'@xterm/xterm':d['@xterm/xterm'],'@xterm/addon-fit':d['@xterm/addon-fit']};delete p.scripts;require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY bin/agentmgr-hub.js bin/
COPY src/hub.js src/hubbacklog.js src/fleet.js src/
COPY public/hub public/hub
COPY public/touchscroll.js public/
ENV NODE_ENV=production AGENTMGR_HUB_HOME=/data
CMD ["node", "bin/agentmgr-hub.js"]
