import PQueue from 'p-queue';
import { generateMessageID, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { log, errMsg } from './log.js';
import { explain } from './hints.js';

/** Ids of messages this app sent, so its own messages are never mistaken for the user's (or answered). */
export const botSentIds = new Set<string>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Upper bound on the "reading" pause so a very long incoming message doesn't stall the queue forever. */
const MAX_READ_DELAY_MS = 20_000;

export interface PacingPlan {
  readDelayMs: number;
  typingMs: number;
  cooldownMs: number;
}

/**
 * Humanised timing:
 *  - reading delay = 1500ms + (incoming length * 20ms) + random(1000-3000ms)
 *  - typing time   = proportional to reply length, clamped to 2000-6000ms
 *  - cooldown      = random(1500-3000ms) after sending
 */
export function planPacing(incomingLength: number, replyLength: number): PacingPlan {
  return {
    readDelayMs: Math.min(MAX_READ_DELAY_MS, 1500 + incomingLength * 20 + rand(1000, 3000)),
    typingMs: clamp(Math.round(replyLength * 55) + rand(0, 600), 2000, 6000),
    cooldownMs: rand(1500, 3000),
  };
}

export interface EnqueueOptions {
  /** Message being answered: quoted in groups, marked read before typing. */
  replyTo?: WAMessage;
  /** Quote the replyTo message in the outgoing text (default: true when replyTo is set). */
  quote?: boolean;
  /** Length of the text we are "reading" before replying (defaults to replyTo text length or 0). */
  incomingLength?: number;
  /** Label for logs. */
  label?: string;
  /** Called with the sent message so callers can track ids (e.g. to avoid reply loops). */
  onSent?: (sent: WAMessage | undefined) => void;
}

class AntiBanDispatcher {
  // concurrency 1: replies across all chats are strictly serialised.
  private queue = new PQueue({ concurrency: 1 });

  get pending() {
    return this.queue.size + this.queue.pending;
  }

  enqueue(sock: WASocket, jid: string, text: string, opts: EnqueueOptions = {}): Promise<WAMessage | undefined> {
    const label = opts.label ?? jid;
    log.info(`[queue] queued reply to ${label} (${this.pending} ahead)`);
    return this.queue.add(async () => {
      const plan = planPacing(opts.incomingLength ?? 0, text.length);
      try {
        // 1. Read the message like a human would.
        if (opts.replyTo?.key) await sock.readMessages([opts.replyTo.key]).catch(() => undefined);
        await sleep(plan.readDelayMs);

        // 2-3. Show "typing..." for a time proportional to the reply length.
        await sock.presenceSubscribe(jid).catch(() => undefined);
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(plan.typingMs);

        // 4. Send.
        const messageId = generateMessageID();
        botSentIds.add(messageId);
        if (botSentIds.size > 2000) botSentIds.delete(botSentIds.values().next().value as string);
        const quoted = opts.replyTo && opts.quote !== false ? opts.replyTo : undefined;
        const sent = await sock.sendMessage(jid, { text }, { quoted, messageId });
        log.event(
          `[queue] sent to ${label} (read ${(plan.readDelayMs / 1000).toFixed(1)}s, typed ${(plan.typingMs / 1000).toFixed(1)}s)`,
        );
        opts.onSent?.(sent);
        return sent;
      } catch (e) {
        log.error(explain('whatsapp', e, `[queue] failed to send to ${label}: `));
        throw e;
      } finally {
        // 5. Stop typing and cool down before the next dispatch.
        await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
        await sleep(plan.cooldownMs);
      }
    });
  }
}

export const dispatcher = new AntiBanDispatcher();

/** Spec-shaped helper. */
export function enqueueMessage(
  sock: WASocket,
  jid: string,
  text: string,
  replyTo?: WAMessage,
  opts: Omit<EnqueueOptions, 'replyTo'> = {},
) {
  return dispatcher.enqueue(sock, jid, text, { ...opts, replyTo });
}
