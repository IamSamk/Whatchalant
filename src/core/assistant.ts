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
import { generateReply, type ChatTurn } from '../services/llm.js';
import { transcribeVoiceNote } from '../services/stt.js';
import { speakTagAlert } from '../services/tts.js';
import { drafts } from './drafts.js';
import { errMsg, log } from './log.js';
import { botSentIds, dispatcher } from './queue.js';

// ── Tunables ───────────────────────────────────────────────────────────
const DEBOUNCE_MS = 3500; // gather bursts of messages into one reply
const MAX_AGE_MS = 90_000; // never answer backlog delivered after being offline
const HISTORY_LEN = 12;
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
}
export interface ChatSummary {
  jid: string;
  name: string;
  isGroup: boolean;
  lastText: string;
  lastTs: number;
}

const history = new Map<string, HistoryItem[]>();
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
  return [k.remoteJid, k.participant, k.participantPn, k.senderPn, k.senderLid, k.participantLid]
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
    void respond(sock, jid, entry).catch((e) => log.error(`[ai] ${label}: ${errMsg(e)}`));
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
    remember(jid, { fromMe: false, name: senderName, text: parsed.text, ts }, isGroup, chatName);
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
      log.error(`[stt] could not transcribe voice note: ${errMsg(e)}`);
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
