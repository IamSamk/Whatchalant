import { rm } from 'node:fs/promises';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessageContent,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config, state } from '../config.js';
import { handleIncoming } from './assistant.js';
import { hintFor } from './hints.js';
import { errMsg, log } from './log.js';
import { getRawSocket, setSocket } from './socket.js';

// Baileys is chatty; keep its own logs quiet unless debugging.
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

/** Recently sent message bodies, so Baileys can re-send them if the recipient asks for a retry. */
const sentStore = new Map<string, WAMessageContent>();
function rememberSent(key: WAMessageKey, content: WAMessageContent | null | undefined) {
  if (!key.id || !content) return;
  sentStore.set(key.id, content);
  if (sentStore.size > 500) sentStore.delete(sentStore.keys().next().value as string);
}

let attempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

export async function startWhatsApp(): Promise<WASocket> {
  const { state: auth, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined, isLatest: false }));
  if (version) log.info(`[wa] using WhatsApp Web v${version.join('.')}${isLatest ? '' : ' (fallback)'}`);

  state.connection = attempt === 0 ? 'Connecting' : 'Reconnecting';
  state.changed();

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.windows('Desktop'),
    // Stay "offline" so your phone keeps getting notifications while this runs.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => (key.id ? sentStore.get(key.id) : undefined),
  });

  sock.ev.on('creds.update', saveCreds);
  setSocket(sock);

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      state.qr = u.qr;
      if (state.connection !== 'QR Required') state.pairingCode = null;
      state.connection = 'QR Required';
      state.changed();
      log.event(`[wa] scan the QR code to link this device → http://localhost:${config.DASHBOARD_PORT}`);
      qrcode.generate(u.qr, { small: true });
    }

    if (u.connection === 'open') {
      attempt = 0;
      state.qr = null;
      state.pairingCode = null;
      state.connection = 'Connected';
      state.me = sock.user ? { id: sock.user.id, lid: sock.user.lid, name: sock.user.name ?? sock.user.notify } : null;
      setSocket(sock);
      state.changed();
      log.event(`[wa] connected as ${state.me?.name ?? ''} (${state.me?.id.split(':')[0]})`);
    }

    if (u.connection === 'close') {
      if (getRawSocket() === sock) setSocket(null);
      const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const reason = u.lastDisconnect?.error ? errMsg(u.lastDisconnect.error) : 'unknown';

      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: wipe the dead session and show a fresh QR.
        state.connection = 'Logged Out';
        state.me = null;
        state.changed();
        log.warn('[wa] logged out from the phone, clearing session; a new QR will follow');
        await rm(config.paths.auth, { recursive: true, force: true }).catch(() => undefined);
        attempt = 0;
        scheduleReconnect(1000);
        return;
      }
      // 515 = restart after pairing; 408 = QR codes ran out unscanned → just show fresh ones.
      const quick = code === DisconnectReason.restartRequired || code === DisconnectReason.timedOut;
      const delay = quick ? 1000 : Math.min(30_000, 2000 * 2 ** attempt);
      if (!quick) attempt++;
      state.connection = 'Reconnecting';
      state.changed();
      const hint = hintFor('whatsapp', u.lastDisconnect?.error);
      log.warn(`[wa] connection closed (${code ?? '?'}: ${reason}), reconnecting in ${Math.round(delay / 1000)}s${hint ? `
   → ${hint}` : ''}`);
      scheduleReconnect(delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) rememberSent(msg.key, msg.message);
      if (process.env.WA_DEBUG && process.env.WA_DEBUG !== "false") {
        const kind = msg.message ? Object.keys(msg.message).join(',') : `no content (stub ${msg.messageStubType ?? '-'} ${msg.messageStubParameters?.join(' ') ?? ''})`;
        log.info(`[debug] upsert ${type} chat=${msg.key.remoteJid} fromMe=${msg.key.fromMe} → ${kind}`);
      }
      // 'notify' = new live messages; 'append' = history sync, which we never answer.
      if (type !== 'notify') continue;
      try {
        await handleIncoming(sock, msg);
      } catch (e) {
        log.error(`[wa] failed handling message: ${errMsg(e)}`);
      }
    }
  });

  return sock;
}

/**
 * Alternative to the QR: WhatsApp → Linked devices → Link a device → "Link with phone number instead",
 * then type the 8-character code this returns.
 */
export async function requestPairingCode(phone: string): Promise<string> {
  const sock = getRawSocket();
  const digits = phone.replace(/\D/g, '');
  if (!sock) throw new Error('WhatsApp socket not started yet, try again in a few seconds');
  if (state.connection === 'Connected') throw new Error('already linked');
  if (digits.length < 8) throw new Error('give the full number with country code, e.g. 919876543210');
  const raw = await sock.requestPairingCode(digits);
  const code = raw.match(/.{1,4}/g)?.join('-') ?? raw;
  state.pairingCode = code;
  state.changed();
  log.event(`[wa] pairing code for +${digits}: ${code}  (WhatsApp → Linked devices → Link with phone number instead)`);
  return code;
}

function scheduleReconnect(ms: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((e) => {
      log.error(`[wa] reconnect failed: ${errMsg(e)}`);
      scheduleReconnect(Math.min(30_000, 2000 * 2 ** attempt++));
    });
  }, ms);
}
