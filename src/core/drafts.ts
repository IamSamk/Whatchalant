import { EventEmitter } from 'node:events';
import type { WAMessage } from '@whiskeysockets/baileys';
import { log } from './log.js';
import { dispatcher } from './queue.js';
import { getSocket } from './socket.js';

export interface Draft {
  id: number;
  jid: string;
  /** Human label: "Alice (DM)" / "Alice in Weekend Plans". */
  label: string;
  /** What we are answering (shown next to the draft). */
  incoming: string;
  text: string;
  source: 'ai' | 'dictation';
  createdAt: number;
  replyTo?: WAMessage;
  quote: boolean;
  /** Prefix added at send time (used in the self-chat test channel). */
  prefix?: string;
}

const DRAFT_TTL_MS = 30 * 60_000;

class DraftBox extends EventEmitter {
  private nextId = 1;
  private drafts = new Map<number, Draft>();

  add(d: Omit<Draft, 'id' | 'createdAt'>): Draft {
    this.expire();
    const draft: Draft = { ...d, id: this.nextId++, createdAt: Date.now() };
    this.drafts.set(draft.id, draft);
    log.draft(`[draft #${draft.id}] → ${draft.label}`);
    if (draft.incoming) log.draft(`   they said: "${draft.incoming}"`);
    log.draft(`   draft:     "${draft.text}"`);
    log.draft(`   approve with  y  (or :approve ${draft.id}),  n  to reject,  :edit ${draft.id} <new text>`);
    this.emit('change');
    return draft;
  }

  list(): Draft[] {
    this.expire();
    return [...this.drafts.values()];
  }

  latest(): Draft | undefined {
    return this.list().at(-1);
  }

  private take(id: number): Draft {
    const d = this.drafts.get(id);
    if (!d) throw new Error(`no pending draft #${id}`);
    this.drafts.delete(id);
    this.emit('change');
    return d;
  }

  /** Approve (optionally with edited text) and hand it to the anti-ban queue. */
  approve(id: number, editedText?: string): Draft {
    const sock = getSocket();
    const d = this.take(id);
    const text = (editedText ?? d.text).trim();
    if (!text) throw new Error('empty message');
    void dispatcher
      .enqueue(sock, d.jid, `${d.prefix ?? ''}${text}`, {
        replyTo: d.replyTo,
        quote: d.quote,
        incomingLength: d.incoming.length,
        label: d.label,
      })
      .catch(() => undefined);
    log.info(`[draft #${id}] approved${editedText ? ' (edited)' : ''}`);
    return d;
  }

  reject(id: number): Draft {
    const d = this.take(id);
    log.info(`[draft #${id}] rejected`);
    return d;
  }

  private expire() {
    const now = Date.now();
    for (const [id, d] of this.drafts) {
      if (now - d.createdAt > DRAFT_TTL_MS) {
        this.drafts.delete(id);
        log.warn(`[draft #${id}] expired without approval`);
      }
    }
  }
}

export const drafts = new DraftBox();
