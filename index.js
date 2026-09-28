'use strict';
const { Store } = require('./src/store');
const { WhatsAppClient } = require('./src/whatsapp');
const { buildHttpApp } = require('./src/mcpServer');

const PORT = process.env.PORT || 8787;

async function main() {
  const store = new Store();
  const wa = new WhatsAppClient(store);
  await wa.start();

  const app = buildHttpApp(wa, store);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] wa-mcp-server listening on 127.0.0.1:${PORT} (put a Cloudflare Tunnel in front of this)`);
  });
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
