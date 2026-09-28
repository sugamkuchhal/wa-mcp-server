'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { normalizeJid } = require('./whatsapp');

/**
 * Builds the MCP server (tool definitions) and the Express app that serves
 * it over HTTP, protected by a static bearer token. Every tool that could
 * send a message only ever writes a draft; wa_send_draft is the single
 * choke point that actually calls WhatsApp.
 */
function buildMcpServer(wa, store) {
  const server = new McpServer({ name: 'wa-mcp-server', version: '1.0.0' });

  server.tool(
    'wa_debug',
    'Diagnostic info: connection status, self identity, counts of known chats/contacts/pending drafts, uptime.',
    {},
    async () => {
      const info = {
        status: wa.status,
        selfJid: wa.selfJid,
        connectedAt: wa.connectedAt,
        uptimeSeconds: wa.connectedAt ? Math.floor((Date.now() - wa.connectedAt) / 1000) : null,
        knownChats: store.chats.size,
        knownContacts: store.contacts.size,
        pendingDrafts: store.listDrafts('pending').length,
      };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
  );

  server.tool(
    'wa_list_chats',
    'List recent WhatsApp chats (individuals and groups), most recently active first.',
    { limit: z.number().int().min(1).max(200).optional().describe('Max chats to return (default 50)') },
    async ({ limit }) => {
      const chats = store.listChats(limit || 50);
      return { content: [{ type: 'text', text: JSON.stringify(chats, null, 2) }] };
    }
  );

  server.tool(
    'wa_search_contacts',
    'Search known WhatsApp contacts by name (substring match, case-insensitive).',
    { query: z.string().min(1).describe('Name (or part of it) to search for') },
    async ({ query }) => {
      const results = store.searchContacts(query);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'wa_read_messages',
    'Read recent messages from a specific chat (by jid, phone number, or group id).',
    {
      chat: z.string().min(1).describe('Phone number, contact jid, or group jid to read messages from'),
      limit: z.number().int().min(1).max(100).optional().describe('Max messages to return (default 20)'),
    },
    async ({ chat, limit }) => {
      const jid = normalizeJid(chat);
      const messages = store.getMessages(jid, limit || 20);
      return { content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.tool(
    'wa_draft_message',
    'Create a draft WhatsApp message (to an individual or a group). Does NOT send it — use wa_send_draft after the user reviews the text.',
    {
      to: z.string().min(1).describe('Recipient: phone number, contact jid, or group jid'),
      text: z.string().min(1).describe('Message text'),
    },
    async ({ to, text }) => {
      const draft = store.createDraft(to, text);
      return {
        content: [
          {
            type: 'text',
            text: `Draft created (id: ${draft.id}). Review it, then call wa_send_draft with this id to actually send.\n\n${JSON.stringify(draft, null, 2)}`,
          },
        ],
      };
    }
  );

  server.tool(
    'wa_list_drafts',
    'List drafts. Defaults to pending (unsent) drafts.',
    { status: z.enum(['pending', 'sent', 'all']).optional().describe('Filter by status (default: pending)') },
    async ({ status }) => {
      const filter = !status || status === 'all' ? '' : status;
      const drafts = store.listDrafts(filter);
      return { content: [{ type: 'text', text: JSON.stringify(drafts, null, 2) }] };
    }
  );

  server.tool(
    'wa_send_draft',
    'Send a previously created draft by id. This is the ONLY tool that actually sends a WhatsApp message — only call it after the message content has been explicitly approved.',
    { draft_id: z.string().min(1).describe('The draft id returned by wa_draft_message') },
    async ({ draft_id }) => {
      const draft = store.getDraft(draft_id);
      if (!draft) {
        return { content: [{ type: 'text', text: `No draft found with id ${draft_id}` }], isError: true };
      }
      if (draft.status === 'sent') {
        return { content: [{ type: 'text', text: `Draft ${draft_id} was already sent at ${new Date(draft.sentAt).toISOString()}` }] };
      }
      try {
        await wa.sendText(draft.to, draft.text);
        store.markDraftSent(draft_id);
        return { content: [{ type: 'text', text: `Sent draft ${draft_id} to ${draft.to}.` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send draft ${draft_id}: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

function buildHttpApp(wa, store) {
  const app = express();
  app.use(express.json());

  const token = process.env.WA_MCP_TOKEN;
  if (!token) {
    throw new Error('WA_MCP_TOKEN env var is required (used as the bearer token remote clients must send)');
  }

  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (provided !== token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, waStatus: wa.status });
  });

  // One MCP server + transport per request, stateless-ish (new transport per
  // session id via the SDK's own session handling). Simple single-endpoint
  // setup, no SSE fallback needed since this is a personal, single-client
  // deployment.
  app.post('/mcp', async (req, res) => {
    try {
      const server = buildMcpServer(wa, store);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  });

  return app;
}

module.exports = { buildMcpServer, buildHttpApp };
