import { config, jidUser, state } from '../config.js';
import { recentChats } from '../core/assistant.js';
import { drafts } from '../core/drafts.js';
import { dispatcher } from '../core/queue.js';
import { getSocket, toJid } from '../core/socket.js';
import { requestPairingCode } from '../core/whatsapp.js';
import { connectCustom, fetchAvailableModels, selectModel, setProvider, type ModelInfo } from '../services/llm.js';
import { cancelJob, listJobs, parseWhen, scheduleMessage, scheduleOnce } from '../services/scheduler.js';
import { dictate } from '../services/stt.js';

const on = (b: boolean) => (b ? '\x1b[32mON\x1b[0m' : '\x1b[31mOFF\x1b[0m');
let lastModelList: ModelInfo[] = [];

export const HELP = `
Commands
  :status                          dashboard
  :pair [number]                   link with an 8-character code instead of the QR
  :models                          list models for the current provider (numbered)
  :model <n|name|path.gguf>        pick a model (number from :models works)
  :provider ollama|lmstudio|custom switch provider
  :connect <url | file.gguf | dir> use your own endpoint, launch a .gguf, or list a folder's .gguf files
  :toggle ai|voice|draft|selftest  flip a switch
  :drafts                          pending drafts       y / n  approve / reject the latest
  :approve <id>  :reject <id>  :edit <id> <text>
  :send <jid|number> <text>        send through the anti-ban queue
  :dictate <jid|number> [secs]     record your voice, transcribe, then approve and send
  :schedule <jid> "<cron>" <msg>   recurring, e.g. :schedule 9198xxxx "0 9 * * 1-5" Good morning!
  :at <jid> <+10m|18:30|ISO> <msg> one-off future message
  :jobs   :cancel <id>             list / cancel scheduled jobs
  :whitelist [add|remove <jid>]    who may get AI replies
  :chats                           recent chats with their JIDs
  :quit
`.trim();

export function statusText(): string {
  const conn =
    state.connection === 'Connected'
      ? `\x1b[32m${state.connection}\x1b[0m as ${state.me?.name ?? ''} (${state.me ? jidUser(state.me.id) : ''})`
      : `\x1b[33m${state.connection}\x1b[0m`;
  return [
    '┌─ WhatsApp Assistant ─────────────────────────────',
    `│ Connection     ${conn}`,
    `│ Voice alerts   [${on(state.voiceAlerts)}]   AI auto-reply [${on(state.aiAutoReply)}]   Draft mode [${on(state.draftMode)}]`,
    `│ Self-chat test [${on(state.selfChatTest)}]   Whitelist: ${state.whitelist.size || 'none (mentions anywhere)'}`,
    `│ LLM            ${state.provider} / ${state.model}${state.provider === 'custom' ? `  @ ${state.customBaseUrl}` : ''}`,
    `│ Queue          ${dispatcher.pending} pending   Drafts: ${drafts.list().length}   Jobs: ${listJobs().length}`,
    '└──────────────────────────────────────────────────',
  ].join('\n');
}

/** Split respecting "double quotes". */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

/** Take a cron expression: quoted token, or the next 5 (or 6) fields. Returns [expr, rest]. */
function takeCron(rest: string): [string, string] {
  const q = rest.match(/^"([^"]+)"\s*([\s\S]*)$/);
  if (q) return [q[1]!.trim(), q[2]!.trim()];
  const parts = rest.split(/\s+/);
  const isField = (p?: string) => !!p && /^[\d*,\-/?LW#A-Za-z]+$/.test(p) && /[\d*]/.test(p);
  const six = parts.slice(0, 6);
  const n = six.length === 6 && six.every(isField) ? 6 : 5;
  return [parts.slice(0, n).join(' '), parts.slice(n).join(' ')];
}

const fmtTime = (ts: number) => new Date(ts).toLocaleString();

export async function runCommand(input: string): Promise<string> {
  const line = input.trim();
  if (!line) return '';

  // Quick draft answers.
  if (/^(y|yes)$/i.test(line) || /^(n|no)$/i.test(line)) {
    const d = drafts.latest();
    if (!d) return 'no pending drafts';
    return /^y/i.test(line) ? `approved #${drafts.approve(d.id).id} → queued` : `rejected #${drafts.reject(d.id).id}`;
  }
  if (!line.startsWith(':')) return `unknown input. Commands start with ":" (try :help)`;

  const [rawCmd = '', ...restParts] = line.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const rest = line.slice(1 + rawCmd.length).trim();
  const args = tokenize(rest);

  switch (cmd) {
    case 'help':
    case 'h':
      return HELP;
    case 'status':
    case 's':
      return statusText();

    case 'pair': {
      const num = args[0] ?? config.MY_PHONE_NUMBER;
      if (!num) return 'usage: :pair <your number with country code>';
      const code = await requestPairingCode(num);
      return `pairing code: ${code}
On your phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead" → enter the code.`;
    }
    case 'models': {
      lastModelList = await fetchAvailableModels();
      if (!lastModelList.length)
        return `no models found for ${state.provider}. ${state.provider === 'ollama' ? 'Try `ollama pull <model>` or ' : ''}:connect <url|file.gguf|folder>`;
      return lastModelList
        .map((m, i) => `${String(i + 1).padStart(2)}. ${m.id === state.model ? '*' : ' '} ${m.id}  ${m.detail ? `(${m.detail})` : ''}`)
        .join('\n');
    }
    case 'model': {
      if (!rest) return `current model: ${state.model}`;
      const n = Number(rest);
      const pick = Number.isInteger(n) && lastModelList[n - 1] ? lastModelList[n - 1]!.id : rest.replace(/^"(.*)"$/, '$1');
      await selectModel(pick);
      return `model → ${state.provider} / ${state.model}`;
    }
    case 'provider':
      if (!args[0]) return `current provider: ${state.provider}`;
      return `provider → ${setProvider(args[0].toLowerCase())} (model: ${state.model}; run :models to pick one)`;
    case 'connect': {
      if (!rest) return 'usage: :connect <http://host:port/v1 | D:\\models\\file.gguf | D:\\models>';
      const list = await connectCustom(rest);
      if (list.length && list.every((m) => m.detail?.startsWith('gguf'))) {
        lastModelList = list;
        return `found ${list.length} .gguf model(s); launch one with :model <n>\n${list.map((m, i) => `${String(i + 1).padStart(2)}. ${m.id}  (${m.detail})`).join('\n')}`;
      }
      return `connected → ${state.provider} / ${state.model} @ ${state.customBaseUrl}`;
    }

    case 'toggle': {
      const what = (args[0] ?? '').toLowerCase();
      if (what === 'ai') state.aiAutoReply = !state.aiAutoReply;
      else if (what === 'voice') state.voiceAlerts = !state.voiceAlerts;
      else if (what === 'draft') state.draftMode = !state.draftMode;
      else if (what === 'selftest' || what === 'self') state.selfChatTest = !state.selfChatTest;
      else return 'usage: :toggle ai|voice|draft|selftest';
      state.changed();
      return statusText();
    }

    case 'drafts': {
      const list = drafts.list();
      if (!list.length) return 'no pending drafts';
      return list.map((d) => `#${d.id} → ${d.label}\n   they said: "${d.incoming}"\n   draft:     "${d.text}"`).join('\n');
    }
    case 'approve':
      return `approved #${drafts.approve(Number(args[0])).id} → queued`;
    case 'reject':
      return `rejected #${drafts.reject(Number(args[0])).id}`;
    case 'edit': {
      const id = Number(args[0]);
      const text = rest.slice((args[0] ?? '').length).trim();
      if (!text) return 'usage: :edit <id> <new text>';
      drafts.approve(id, text);
      return `edited & approved #${id} → queued`;
    }

    case 'send': {
      const [target, ...msg] = restParts;
      const text = msg.join(' ').trim();
      if (!target || !text) return 'usage: :send <jid|number> <text>';
      const jid = toJid(target);
      void dispatcher.enqueue(getSocket(), jid, text, { label: jid }).catch(() => undefined);
      return `queued for ${jid}`;
    }
    case 'dictate': {
      const [target, secs] = restParts;
      if (!target) return 'usage: :dictate <jid|number> [seconds]';
      const jid = toJid(target);
      getSocket();
      const seconds = Math.min(60, Math.max(2, Number(secs) || 8));
      const text = await dictate(seconds);
      if (!text) return 'heard nothing';
      const d = drafts.add({ jid, label: jid, incoming: '', text, source: 'dictation', quote: false });
      return `dictated draft #${d.id}: "${text}" (y to send, n to discard, :edit ${d.id} <text>)`;
    }

    case 'schedule': {
      const [target = '', ...after] = restParts;
      if (!target || !after.length) return 'usage: :schedule <jid|number> "<cron>" <message>';
      const jid = toJid(target);
      const [expr, message] = takeCron(rest.slice(target.length).trim());
      const job = scheduleMessage(null, jid, message, expr);
      return `job #${job.id}: "${message}" → ${jid} on "${expr}"`;
    }
    case 'at': {
      const [target, when, ...msg] = restParts;
      if (!target || !when || !msg.length) return 'usage: :at <jid|number> <+10m|18:30|2026-12-31T09:00> <message>';
      const job = scheduleOnce(toJid(target), msg.join(' '), parseWhen(when));
      return `job #${job.id}: "${job.message}" → ${job.jid} at ${new Date(job.when).toLocaleString()}`;
    }
    case 'jobs': {
      const list = listJobs();
      if (!list.length) return 'no scheduled jobs';
      return list
        .map(
          (j) =>
            `#${j.id} [${j.kind}] ${j.kind === 'cron' ? `"${j.when}"` : new Date(j.when).toLocaleString()} → ${j.jid}: "${j.message}"${j.lastRunAt ? `  (last ran ${fmtTime(j.lastRunAt)})` : ''}`,
        )
        .join('\n');
    }
    case 'cancel':
      return cancelJob(Number(args[0])) ? `cancelled job #${args[0]}` : `no job #${args[0]}`;

    case 'whitelist':
    case 'wl': {
      const [action, target] = args;
      if (action === 'add' && target) state.whitelist.add(jidUser(toJid(target)));
      else if ((action === 'remove' || action === 'rm') && target) state.whitelist.delete(jidUser(toJid(target)));
      else if (action) return 'usage: :whitelist [add|remove <jid|number>]';
      state.changed();
      return state.whitelist.size ? `whitelist: ${[...state.whitelist].join(', ')}` : 'whitelist is empty (AI replies only to @mentions in groups)';
    }
    case 'chats': {
      const list = recentChats().slice(0, 20);
      if (!list.length) return 'no chats seen yet in this session';
      return list.map((c) => `${c.isGroup ? '👥' : '👤'} ${c.name}  ${c.jid}\n     ${fmtTime(c.lastTs)}: ${c.lastText}`).join('\n');
    }

    case 'quit':
    case 'exit':
      setTimeout(() => process.exit(0), 100);
      return 'bye';
    default:
      return `unknown command :${cmd} (try :help)`;
  }
}
