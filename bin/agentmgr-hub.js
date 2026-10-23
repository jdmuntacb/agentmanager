#!/usr/bin/env node
// The hub on its own, for hosts without the rest of Agent Manager (Railway, a container).
// Locally, "agentmgr hub serve" does the same.
import { startHub } from '../src/hub.js';

const port = Number(process.env.PORT || 4720);
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const hub = await startHub({ port, host });
console.log(`[hub] listening on ${hub.url}`);
if (hub.createdToken) console.log('[hub] generated an access token; set AGENTMGR_HUB_TOKEN instead to choose your own');
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await hub.close();
    process.exit(0);
  });
}
