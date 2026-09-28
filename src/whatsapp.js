'use strict';
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info');

/**
 * Wraps a Baileys socket connection, wires up event handlers that populate
 * the shared Store, and exposes a small API the MCP tools call into.
 * Reconnects automatically unless logged out (in which case the auth
 * folder must be deleted and the QR re-scanned).
 */
class WhatsAppClient {
  constructor(store) {
    this.store = store;
    this.sock = null;
    this.status = 'starting'; // starting | qr_pending | connected | disconnected
    this.qr = null;
    this.connectedAt = null;
    this.selfJid = null;
    this._logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: this._logger,
      printQRInTerminal: false,
      browser: ['wa-mcp-server', 'Chrome', '1.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.status = 'qr_pending';
        console.log('\n=== Scan this QR code with WhatsApp (Linked Devices) ===\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.connectedAt = Date.now();
        this.selfJid = this.sock.user?.id || null;
        this.qr = null;
        console.log(`[whatsapp] connected as ${this.selfJid}`);
      }

      if (connection === 'close') {
        this.status = 'disconnected';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log(`[whatsapp] connection closed (statusCode=${statusCode}), loggedOut=${loggedOut}`);
        if (!loggedOut) {
          setTimeout(() => this.start().catch((e) => console.error('[whatsapp] restart failed:', e)), 3000);
        } else {
          console.error('[whatsapp] logged out — delete auth_info/ and restart to re-pair via QR');
        }
      }
    });

    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        this.store.upsertContact(c.id, { name: c.name || c.verifiedName, notify: c.notify });
      }
    });

    this.sock.ev.on('contacts.update', (updates) => {
      for (const c of updates) {
        if (c.id) this.store.upsertContact(c.id, { name: c.name, notify: c.notify });
      }
    });

    this.sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        this.store.upsertChat(c.id, {
          name: c.name,
          isGroup: c.id.endsWith('@g.us'),
        });
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid) continue;
        const text = extractText(m.message);
        this.store.addMessage(jid, {
          id: m.key.id,
          fromMe: !!m.key.fromMe,
          sender: m.key.participant || (m.key.fromMe ? this.selfJid : jid),
          text,
          timestamp: (typeof m.messageTimestamp === 'number' ? m.messageTimestamp : Date.now() / 1000) * 1000,
        });
        this.store.upsertChat(jid, { isGroup: jid.endsWith('@g.us') });
      }
    });
  }

  isConnected() {
    return this.status === 'connected';
  }

  async sendText(jid, text) {
    if (!this.isConnected()) throw new Error('WhatsApp is not connected (status: ' + this.status + ')');
    const normalizedJid = normalizeJid(jid);
    return this.sock.sendMessage(normalizedJid, { text });
  }
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    (message.documentMessage ? `[document: ${message.documentMessage.fileName || ''}]` : null) ||
    (message.audioMessage ? '[audio message]' : null) ||
    (message.stickerMessage ? '[sticker]' : null) ||
    ''
  );
}

// Accepts a raw phone number (digits, optionally with +) or an already
// well-formed jid (individual @s.whatsapp.net or group @g.us) and returns
// a jid Baileys can send to.
function normalizeJid(input) {
  if (input.includes('@')) return input;
  const digits = input.replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

module.exports = { WhatsAppClient, normalizeJid };
