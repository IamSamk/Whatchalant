import {
  generateMessageID,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { config, jidUser, state } from '../config.js';
import { generateReply, summarizeChats, type ChatTurn } from '../services/llm.js';
import { transcribeVoiceNote } from '../services/stt.js';
import { speakTagAlert } from '../services/tts.js';
import { drafts } from './drafts.js';
import { explain } from './hints.js';
import { errMsg, log } from './log.js';
import { botSentIds, dispatcher } from './queue.js';

// ── Tunables ───────────────────────────────────────────────────────────
const DEBOUNCE_MS = 3500; // gather bursts of messages into one reply
const MAX_AGE_MS = 90_000; // never answer backlog delivered after being offline
const HISTORY_LEN = 12; // turns of context given to the model
const ARCHIVE_LEN = 200; // messages kept per chat for "Catch me up"
const CATCHUP_MAX_CHARS = 9000; // keep the summary prompt inside a 4k-token context
const MANUAL_TAKEOVER_MS = 10 * 60_000; // you typed in this chat recently → stay quiet
const PER_CHAT_LIMIT = { max: 4, windowMs: 10 * 60_000 };
const GLOBAL_LIMIT = { max: 20, windowMs: 60 * 60_000 };
const SELF_PREFIX = '🤖 ';

// ── Chat memory ───────────────────────────────────────────────────────
interface HistoryItem {
  fromMe: boolean;
  name: string;
  text: string;
  ts: number;
  mentionedMe?: boolean;
}
export interface ChatSummary {
  jid: string;
  name: string;
  isGroup: boolean;
  lastText: string;
  lastTs: number;
}

const history = new Map<string, HistoryItem[]>();
const archive = new Map<string, HistoryItem[]>();
const lastCaughtUpAt = new Map<string, number>();
const startedAt = Date.now();
const chats = new Map<string, ChatSummary>();
const groupNames = new Map<string, string>();
const lastManualAt = new Map<string, number>();
const replyLog = new Map<string, number[]>(); // jid → timestamps of auto replies
const globalReplyLog: number[] = [];

export function recentChats(): ChatSummary[] {
  return [...chats.values()].sort((a, b) => b.lastTs - a.lastTs);
}

function remember(jid: string, item: HistoryItem, isGroup: boolean, chatName: string) {
  const h = history.get(jid) ?? [];
  h.push(item);
  if (h.length > HISTORY_LEN) h.shift();
  history.set(jid, h);
  const a = archive.get(jid) ?? [];
  a.push(item);
  if (a.length > ARCHIVE_LEN) a.shift();
  archive.set(jid, a);
  const prev = chats.get(jid);
  chats.set(jid, {
    jid,
    name: isGroup ? chatName : item.fromMe ? (prev?.name ?? chatName) : chatName,
    isGroup,
    lastText: item.text.slice(0, 80),
    lastTs: item.ts,
  });
}

// ── Identity helpers ──────────────────────────────────────────────────
function myIds(): Set<string> {
  const ids = new Set<string>();
  if (state.me?.id) ids.add(jidUser(state.me.id));
  if (state.me?.lid) ids.add(jidUser(state.me.lid));
  if (config.MY_PHONE_NUMBER) ids.add(config.MY_PHONE_NUMBER);
  return ids;
}

/** Your own "Message yourself" chat (phone JID or LID form). */
export function isSelfChat(jid: string) {
  return !isJidGroup(jid) && myIds().has(jidUser(jid));
}

/** Every identifier the sender might be known by (phone number and/or LID). */
function senderIds(msg: WAMessage): string[] {
  const k = msg.key;
  // Baileys 7: *Alt holds the other address form (phone number ↔ LID) of the same person.
  return [k.remoteJid, k.remoteJidAlt, k.participant, k.participantAlt]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .map(jidUser);
}

function isWhitelisted(msg: WAMessage): boolean {
  return senderIds(msg).some((id) => state.whitelist.has(id));
}

async function groupName(sock: WASocket, jid: string): Promise<string> {
  const cached = groupNames.get(jid);
  if (cached) return cached;
  try {
    const meta = await sock.groupMetadata(jid);
    groupNames.set(jid, meta.subject);
    return meta.subject;
  } catch {
    return 'a group';
  }
}

// ── Message parsing ───────────────────────────────────────────────────
interface Parsed {
  text: string;
  mentioned: string[];
  isVoice: boolean;
}

function parse(msg: WAMessage): Parsed | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || type === 'protocolMessage' || type === 'reactionMessage' || type === 'senderKeyDistributionMessage') return null;

  const c = content as Record<string, unknown>;
  const inner = c[type] as { text?: string; caption?: string; contextInfo?: { mentionedJid?: string[] | null } } | string;
  const text =
    typeof inner === 'string'
      ? inner // conversation
      : (inner?.text ?? inner?.caption ?? '');
  const mentioned = typeof inner === 'object' ? (inner?.contextInfo?.mentionedJid ?? []) : [];
  const isVoice = type === 'audioMessage' && Boolean(content.audioMessage?.ptt);
  return { text: text.trim(), mentioned, isVoice };
}

function mentionsMe(mentioned: string[]) {
  const mine = myIds();
  return mentioned.some((j) => mine.has(jidUser(j)));
}

// ── Circuit breakers ──────────────────────────────────────────────────
function prune(arr: number[], windowMs: number) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && (arr[0] ?? 0) < cutoff) arr.shift();
}

function breakerAllows(jid: string): string | null {
  prune(globalReplyLog, GLOBAL_LIMIT.windowMs);
  if (globalReplyLog.length >= GLOBAL_LIMIT.max) {
    state.aiAutoReply = false;
    state.changed();
    return `global limit of ${GLOBAL_LIMIT.max} auto-replies/hour hit, AI auto-reply switched OFF`;
  }
  const arr = replyLog.get(jid) ?? [];
  prune(arr, PER_CHAT_LIMIT.windowMs);
  replyLog.set(jid, arr);
  if (arr.length >= PER_CHAT_LIMIT.max) return `chat limit of ${PER_CHAT_LIMIT.max} replies per 10 min reached`;
  if (!isSelfChat(jid) && Date.now() - (lastManualAt.get(jid) ?? 0) < MANUAL_TAKEOVER_MS)
    return 'you replied here yourself in the last 10 minutes';
  return null;
}

function recordReply(jid: string) {
  const now = Date.now();
  globalReplyLog.push(now);
  (replyLog.get(jid) ?? replyLog.set(jid, []).get(jid)!).push(now);
}

// ── Debounced reply pipeline ──────────────────────────────────────────
interface Pending {
  timer: NodeJS.Timeout;
  texts: string[];
  last: WAMessage;
  label: string;
  isGroup: boolean;
  senderName: string;
}
const pending = new Map<string, Pending>();

function scheduleReply(sock: WASocket, jid: string, msg: WAMessage, text: string, label: string, isGroup: boolean, senderName: string) {
  const p = pending.get(jid);
  if (p) {
    clearTimeout(p.timer);
    p.texts.push(text);
    p.last = msg;
  }
  const entry: Pending = p ?? { timer: undefined as unknown as NodeJS.Timeout, texts: [text], last: msg, label, isGroup, senderName };
  entry.timer = setTimeout(() => {
    pending.delete(jid);
    void respond(sock, jid, entry).catch((e) => log.error(explain('llm', e, `[ai] no reply for ${label}: `)));
  }, DEBOUNCE_MS);
  pending.set(jid, entry);
}

async function respond(sock: WASocket, jid: string, p: Pending) {
  if (!state.aiAutoReply) return;
  const blocked = breakerAllows(jid);
  if (blocked) {
    log.warn(`[ai] not replying to ${p.label}: ${blocked}`);
    return;
  }
  const incoming = p.texts.join('\n');
  // Turn earlier chat lines into model turns; the batch we are answering is the last ones.
  const past = (history.get(jid) ?? []).slice(0, -p.texts.length);
  const turns: ChatTurn[] = past.map((h) => ({
    role: h.fromMe ? 'assistant' : 'user',
    text: p.isGroup && !h.fromMe ? `${h.name}: ${h.text}` : h.text,
  }));
  const context = p.isGroup ? `Group chat "${p.label}". You were @mentioned by ${p.senderName}.` : `Direct chat with ${p.senderName}.`;

  log.info(`[ai] generating reply for ${p.label} with ${state.provider}/${state.model}...`);
  const reply = await generateReply(p.isGroup ? `${p.senderName}: ${incoming}` : incoming, context, turns);
  recordReply(jid);

  const self = isSelfChat(jid);
  const prefix = self ? SELF_PREFIX : '';
  if (state.draftMode) {
    drafts.add({ jid, label: p.label, incoming, text: reply, source: 'ai', replyTo: p.last, quote: p.isGroup, prefix });
    return;
  }
  await dispatcher.enqueue(sock, jid, `${prefix}${reply}`, {
    replyTo: p.last,
    quote: p.isGroup,
    incomingLength: incoming.length,
    label: p.label,
  });
}

// ── Self-chat commands (":toggle ai" typed in "Message yourself") ─────
type CommandRunner = (line: string) => Promise<string>;
let runCommand: CommandRunner | null = null;
export function setSelfCommandRunner(fn: CommandRunner) {
  runCommand = fn;
}

// ── Entry point for messages.upsert ───────────────────────────────────
export async function handleIncoming(sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || !msg.message) return;
  // Never touch status updates, broadcast lists or channels.
  if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return;

  const parsed = parse(msg);
  if (!parsed) return;
  const isGroup = Boolean(isJidGroup(jid));
  const self = isSelfChat(jid);
  const ts = Number(msg.messageTimestamp ?? 0) * 1000 || Date.now();
  const fresh = Date.now() - ts < MAX_AGE_MS;
  const ownBotMessage = Boolean(msg.key.id && botSentIds.has(msg.key.id));
  const senderName = msg.key.fromMe ? 'Me' : msg.pushName || jidUser(msg.key.participant ?? jid);
  const chatName = isGroup ? await groupName(sock, jid) : self ? 'Message yourself' : senderName;
  const label = isGroup ? `${senderName} in ${chatName}` : self ? 'Message yourself' : `${senderName} (DM)`;

  // Outbound messages: remember them for context, never answer them...
  if (msg.key.fromMe) {
    // In "Message yourself" test mode your typed messages play the other person; the bot's replies are "you".
    const asMe = !self || ownBotMessage;
    if (parsed.text && !parsed.text.startsWith(':'))
      remember(jid, { fromMe: asMe, name: asMe ? 'Me' : 'You', text: parsed.text.replace(SELF_PREFIX, ''), ts }, isGroup, chatName);
    if (ownBotMessage) return;
    if (!self) {
      lastManualAt.set(jid, Date.now()); // you're active in this chat; the AI backs off
      return;
    }
    // ...except in "Message yourself" with SELF_CHAT_TEST on: there your messages act as test input.
    if (!state.selfChatTest || !fresh) return;
    if (parsed.text.startsWith(':') && runCommand) {
      const out = await runCommand(parsed.text).catch((e) => `error: ${errMsg(e)}`);
      await sock.sendMessage(jid, { text: `${SELF_PREFIX}${out.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 3500)}` }, { messageId: trackId() });
      return;
    }
  } else if (parsed.text) {
    const mentionedMe = isGroup && mentionsMe(parsed.mentioned);
    remember(jid, { fromMe: false, name: senderName, text: parsed.text, ts, mentionedMe }, isGroup, chatName);
  }

  if (!fresh) return;

  // 1. Voice alert when someone @mentions you in a group.
  const mentioned = isGroup && mentionsMe(parsed.mentioned);
  if (mentioned) {
    log.event(`[mention] ${label}: ${parsed.text}`);
    speakTagAlert(senderName, parsed.text, chatName);
  }

  // 2. Decide whether this message may get an AI reply at all.
  const eligible = self
    ? state.selfChatTest
    : isGroup
      ? mentioned && (state.whitelist.size === 0 || isWhitelisted(msg))
      : isWhitelisted(msg);
  if (!eligible || !state.aiAutoReply) return;

  let text = parsed.text;
  if (parsed.isVoice) {
    try {
      log.info(`[stt] transcribing voice note from ${label}...`);
      text = await transcribeVoiceNote(msg);
      log.event(`[stt] ${label} said: "${text}"`);
      remember(jid, { fromMe: !self && Boolean(msg.key.fromMe), name: senderName, text, ts }, isGroup, chatName);
    } catch (e) {
      log.error(explain('stt', e, '[stt] could not transcribe voice note: '));
      return;
    }
  }
  if (!text) return;
  scheduleReply(sock, jid, msg, text, label, isGroup, senderName);
}

function trackId() {
  const id = generateMessageID();
  botSentIds.add(id);
  return id;
}

// ── "Catch me up": summarise what you missed ───────────────────────────
export interface CatchUpResult {
  summary: string;
  chatCount: number;
  messageCount: number;
}

/**
 * Summarise messages from other people that arrived since you last wrote in each chat
 * (or since the last catch-up), using the local model. Only covers messages received while the app runs.
 */
const NL = '\n';

export async function catchUp(opts: { markRead?: boolean } = {}): Promise<CatchUpResult> {
  const blocks: { name: string; lines: string[]; last: number }[] = [];
  let messageCount = 0;
  for (const [jid, items] of archive) {
    if (isSelfChat(jid)) continue;
    const since = Math.max(lastManualAt.get(jid) ?? 0, lastCaughtUpAt.get(jid) ?? 0, startedAt - 24 * 3600_000);
    const fresh = items.filter((i) => !i.fromMe && i.ts > since);
    if (!fresh.length) continue;
    const chat = chats.get(jid);
    const name = chat?.name ?? jid;
    messageCount += fresh.length;
    blocks.push({
      name: chat?.isGroup ? `${name} (group)` : `${name} (direct)`,
      lines: fresh.map((i) => `${chat?.isGroup ? `${i.name}: ` : ''}${i.text}${i.mentionedMe ? '  [mentions me]' : ''}`),
      last: fresh.at(-1)?.ts ?? 0,
    });
  }
  if (!blocks.length) return { summary: 'Nothing new since you last checked. 🦥', chatCount: 0, messageCount: 0 };

  // Most recent chats first; trim old lines so the prompt fits a small local model.
  blocks.sort((a, b) => b.last - a.last);
  let budget = CATCHUP_MAX_CHARS;
  const parts: string[] = [];
  for (const b of blocks) {
    if (budget <= 200) break;
    const body = b.lines.join(NL);
    const clipped = body.length > budget - b.name.length ? body.slice(-(budget - b.name.length - 20)) : body;
    parts.push(`### ${b.name}${NL}${clipped}`);
    budget -= clipped.length + b.name.length + 10;
  }
  log.info(`[catchup] summarising ${messageCount} message(s) from ${blocks.length} chat(s) with ${state.provider}/${state.model}...`);
  const summary = await summarizeChats(parts.join(NL + NL));
  if (opts.markRead !== false) {
    const now = Date.now();
    for (const jid of archive.keys()) lastCaughtUpAt.set(jid, now);
  }
  return { summary, chatCount: blocks.length, messageCount };
}
