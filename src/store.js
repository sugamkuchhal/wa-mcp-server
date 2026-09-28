'use strict';
/**
 * Lightweight in-memory store for chats, contacts, recent messages, and
 * pending drafts. Periodically flushed to disk (data/store.json) so chat
 * metadata and message history survive a restart. This is NOT meant to be
 * a full database — it caps message history per chat to keep memory usage
 * low on a 1GB VM.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_MESSAGES_PER_CHAT = 100;
const SAVE_INTERVAL_MS = 15000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

class Store {
  constructor() {
    ensureDataDir();
    this.chats = new Map();       // jid -> { jid, name, isGroup, lastMessageAt }
    this.contacts = new Map();    // jid -> { jid, name, notify }
    this.messages = new Map();    // jid -> array of { id, fromMe, sender, text, timestamp }
    this.drafts = new Map();      // draftId -> { id, to, text, createdAt, status }
    this._draftSeq = 1;
    this._dirty = false;
    this._load();
    setInterval(() => this._saveIfDirty(), SAVE_INTERVAL_MS).unref();
  }

  _load() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        this.chats = new Map(raw.chats || []);
        this.contacts = new Map(raw.contacts || []);
        this.messages = new Map(raw.messages || []);
        this.drafts = new Map(raw.drafts || []);
        this._draftSeq = raw._draftSeq || 1;
      }
    } catch (err) {
      console.error('[store] failed to load persisted store, starting fresh:', err.message);
    }
  }

  _saveIfDirty() {
    if (!this._dirty) return;
    this._save();
  }

  _save() {
    try {
      ensureDataDir();
      const raw = {
        chats: [...this.chats.entries()],
        contacts: [...this.contacts.entries()],
        messages: [...this.messages.entries()],
        drafts: [...this.drafts.entries()],
        _draftSeq: this._draftSeq,
      };
      fs.writeFileSync(STORE_FILE, JSON.stringify(raw));
      this._dirty = false;
    } catch (err) {
      console.error('[store] failed to save store:', err.message);
    }
  }

  markDirty() {
    this._dirty = true;
  }

  upsertChat(jid, patch) {
    const existing = this.chats.get(jid) || { jid };
    this.chats.set(jid, { ...existing, ...patch });
    this.markDirty();
  }

  upsertContact(jid, patch) {
    const existing = this.contacts.get(jid) || { jid };
    this.contacts.set(jid, { ...existing, ...patch });
    this.markDirty();
  }

  addMessage(jid, message) {
    if (!this.messages.has(jid)) this.messages.set(jid, []);
    const arr = this.messages.get(jid);
    arr.push(message);
    if (arr.length > MAX_MESSAGES_PER_CHAT) arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);
    this.upsertChat(jid, { lastMessageAt: message.timestamp });
    this.markDirty();
  }

  getMessages(jid, limit = 20) {
    const arr = this.messages.get(jid) || [];
    return arr.slice(-limit);
  }

  listChats(limit = 50) {
    return [...this.chats.values()]
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
      .slice(0, limit);
  }

  searchContacts(query, limit = 20) {
    const q = query.trim().toLowerCase();
    const results = [];
    for (const c of this.contacts.values()) {
      const name = (c.name || c.notify || '').toLowerCase();
      if (name.includes(q) || c.jid.toLowerCase().includes(q)) results.push(c);
      if (results.length >= limit) break;
    }
    return results;
  }

  createDraft(to, text) {
    const id = `d${this._draftSeq++}`;
    const draft = { id, to, text, createdAt: Date.now(), status: 'pending' };
    this.drafts.set(id, draft);
    this.markDirty();
    this._save();
    return draft;
  }

  getDraft(id) {
    return this.drafts.get(id);
  }

  markDraftSent(id) {
    const d = this.drafts.get(id);
    if (d) {
      d.status = 'sent';
      d.sentAt = Date.now();
      this.markDirty();
      this._save();
    }
    return d;
  }

  listDrafts(status = 'pending') {
    return [...this.drafts.values()]
      .filter((d) => !status || d.status === status)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = { Store };
