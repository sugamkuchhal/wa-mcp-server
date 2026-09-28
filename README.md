# wa-mcp-server

Personal WhatsApp MCP server. Connects to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys)
(no browser, no WhatsApp Business API), and exposes 7 tools over MCP:

- `wa_debug` — connection status, self identity, counts, uptime
- `wa_list_chats` — recent chats (individuals + groups)
- `wa_search_contacts` — search known contacts by name
- `wa_read_messages` — read recent messages from a chat
- `wa_draft_message` — create a draft (does not send)
- `wa_list_drafts` — list pending/sent drafts
- `wa_send_draft` — send a previously created draft (the only tool that actually sends)

Every outgoing message goes through the draft → review → send flow. Nothing is sent silently.

## Setup on the VM

```bash
git clone https://github.com/sugamkuchhal/wa-mcp-server.git
cd wa-mcp-server
npm install
```

Create `.env` (not committed) with:

```
WA_MCP_TOKEN=<a long random secret — remote MCP clients must send this as a Bearer token>
PORT=8787
```

Generate a token with: `openssl rand -hex 32`

## First run (QR pairing)

```bash
node index.js
```

A QR code prints in the terminal. Scan it from WhatsApp on your phone:
Settings → Linked Devices → Link a Device. Once connected, `Ctrl+C` and
install it as a systemd service (below) so it runs persistently.

Session credentials are saved under `auth_info/` (gitignored) — as long as
that folder persists, you won't need to re-scan on restart.

## Running as a service

```bash
sudo cp wa-mcp.service /etc/systemd/system/wa-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now wa-mcp
sudo systemctl status wa-mcp
```

Logs: `tail -f wa-mcp.log`

## Exposing it remotely (Cloudflare Tunnel)

The server binds to `127.0.0.1:8787` only — a Cloudflare Tunnel is what
makes it reachable from outside the VM, without opening any inbound ports.
See the main setup guide for the tunnel + MCP registration steps.
