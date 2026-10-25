import type { WASocket } from '@whiskeysockets/baileys';
import { jidUser, state } from '../config.js';

let current: WASocket | null = null;

export function setSocket(sock: WASocket | null) {
  current = sock;
}

/** The live socket, or an error if WhatsApp isn't connected right now. */
export function getSocket(): WASocket {
  if (!current || state.connection !== 'Connected') throw new Error(`WhatsApp is not connected (${state.connection})`);
  return current;
}

export function isConnected() {
  return current !== null && state.connection === 'Connected';
}

/** Turn "919876543210", "+91 98765 43210", "me" or a full JID into a JID. */
export function toJid(input: string): string {
  const s = input.trim();
  if (/^(me|self)$/i.test(s)) {
    if (!state.me) throw new Error('not paired yet');
    return `${jidUser(state.me.id)}@s.whatsapp.net`;
  }
  if (s.includes('@')) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) throw new Error(`not a phone number or JID: ${input}`);
  return `${digits}@s.whatsapp.net`;
}
