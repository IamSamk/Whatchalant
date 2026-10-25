import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { config, PROVIDERS, state, type Provider } from '../config.js';
import { errMsg, log } from '../core/log.js';

export interface ModelInfo {
  /** What you pass to :model / :connect. */
  id: string;
  provider: Provider;
  /** Extra detail: size, "gguf file", etc. */
  detail?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

const SYSTEM_PROMPT = [
  'You are texting on WhatsApp on behalf of the phone owner. Reply exactly as they would: short, casual, friendly, natural.',
  'Rules: one or two short sentences at most. No greetings unless they greeted. No "As an AI", no preamble, no quotes around the reply,',
  'no hashtags, no sign-off. Mirror their language, slang and emoji level (use few emojis). If you are unsure about plans, facts or',
  'commitments, stay vague and say you will check and get back. Never invent appointments, money matters or personal details.',
  'Output only the message text.',
].join(' ');

// ── Model discovery ────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'envs', '.cache', 'blobs', 'xet', 'datasets', 'modules', '__pycache__']);

/** Recursively find .gguf model files (skipping vision projectors) below a folder. */
export async function scanGguf(root: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('datasets--')) await walk(full, depth + 1);
      } else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out.sort();
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function baseUrlFor(provider: Provider) {
  if (provider === 'ollama') return config.OLLAMA_BASE_URL;
  if (provider === 'lmstudio') return config.LMSTUDIO_BASE_URL;
  return state.customBaseUrl;
}

function authHeaders(provider: Provider): Record<string, string> {
  return provider === 'custom' && config.CUSTOM_API_KEY ? { Authorization: `Bearer ${config.CUSTOM_API_KEY}` } : {};
}

async function ggufInfos(files: string[]): Promise<ModelInfo[]> {
  return Promise.all(
    files.map(async (f) => {
      const size = await stat(f)
        .then((s) => s.size)
        .catch(() => 0);
      return { id: f, provider: 'custom' as const, detail: `gguf ${gb(size)}` };
    }),
  );
}

export async function fetchAvailableModels(provider: Provider = state.provider): Promise<ModelInfo[]> {
  if (provider === 'ollama') {
    const { data } = await axios.get<{ models: { name: string; size: number }[] }>(`${config.OLLAMA_BASE_URL}/api/tags`, {
      timeout: 5000,
    });
    return data.models.map((m) => ({ id: m.name, provider, detail: gb(m.size) }));
  }

  const models: ModelInfo[] = [];
  try {
    const { data } = await axios.get<{ data: { id: string }[] }>(`${baseUrlFor(provider)}/models`, {
      timeout: 5000,
      headers: authHeaders(provider),
    });
    models.push(...data.data.map((m) => ({ id: m.id, provider, detail: 'served' })));
  } catch (e) {
    if (provider === 'lmstudio') throw e;
  }

  // Custom: also offer the .gguf files from CUSTOM_MODEL_PATH so they can be launched with llama-server.
  if (provider === 'custom' && config.CUSTOM_MODEL_PATH) {
    const target = config.CUSTOM_MODEL_PATH;
    const files = /\.gguf$/i.test(target) ? [target] : await scanGguf(target);
    models.push(...(await ggufInfos(files)));
  }
  return models;
}

// ── llama-server lifecycle for raw .gguf files ─────────────────────────

let llamaProc: ChildProcess | null = null;
let llamaModel: string | null = null;

/** Find llama-server: LLAMA_SERVER_PATH, else a llama.cpp build folder near the model, else PATH. */
async function findLlamaServer(modelPath: string): Promise<string> {
  if (config.LLAMA_SERVER_PATH) return config.LLAMA_SERVER_PATH;
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  let dir = path.dirname(modelPath);
  for (let i = 0; i < 4; i++) {
    if (existsSync(path.join(dir, exe))) return path.join(dir, exe);
    const lc = path.join(dir, 'llama.cpp');
    if (existsSync(path.join(lc, exe))) return path.join(lc, exe);
    if (existsSync(lc)) {
      // e.g. D:\models\llama.cpp\b11695\llama-server.exe
      for (const e of await readdir(lc, { withFileTypes: true })) {
        const p = path.join(lc, e.name, exe);
        if (e.isDirectory() && existsSync(p)) return p;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return exe;
}

export function stopLlamaServer() {
  if (llamaProc && !llamaProc.killed) {
    llamaProc.kill();
    log.info('[llm] stopped llama-server');
  }
  llamaProc = null;
  llamaModel = null;
}

async function startLlamaServer(modelPath: string) {
  if (llamaModel === modelPath && llamaProc && !llamaProc.killed) return;
  stopLlamaServer();
  const bin = await findLlamaServer(modelPath);
  const port = config.LLAMA_SERVER_PORT;
  const extra = config.LLAMA_SERVER_ARGS.split(/\s+/).filter(Boolean);
  const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), ...extra];
  log.info(`[llm] launching ${bin} with ${path.basename(modelPath)} on :${port} (loading can take a minute)...`);

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  llamaProc = proc;
  llamaModel = modelPath;
  let lastErr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim().split('\n').pop();
    if (line) lastErr = line;
  });
  proc.on('exit', (code) => {
    if (llamaProc === proc) {
      log.warn(`[llm] llama-server exited (${code}). ${lastErr}`);
      llamaProc = null;
      llamaModel = null;
    }
  });
  const spawnError = new Promise<never>((_, reject) => proc.on('error', reject));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5 * 60_000;
  const ready = (async () => {
    while (Date.now() < deadline) {
      if (llamaProc !== proc) throw new Error(`llama-server stopped while loading: ${lastErr}`);
      const ok = await axios
        .get(`${base}/health`, { timeout: 2000 })
        .then((r) => r.status === 200)
        .catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('llama-server did not become ready within 5 minutes');
  })();
  await Promise.race([ready, spawnError]);
  state.customBaseUrl = `${base}/v1`;
  log.event(`[llm] llama-server ready at ${state.customBaseUrl}`);
}

process.on('exit', () => llamaProc?.kill());

// ── Switching provider / model ─────────────────────────────────────────

export function setProvider(p: string): Provider {
  if (!(PROVIDERS as readonly string[]).includes(p)) throw new Error(`provider must be one of: ${PROVIDERS.join(', ')}`);
  if (p !== 'custom') stopLlamaServer();
  state.provider = p as Provider;
  state.changed();
  return state.provider;
}

export async function selectModel(id: string) {
  if (/\.gguf$/i.test(id)) {
    await connectCustom(id);
    return;
  }
  state.model = id;
  state.changed();
}

/**
 * Point the assistant at your own model:
 *  - an http(s) URL → any OpenAI-compatible endpoint (your harness, llama.cpp, vLLM, LM Studio...)
 *  - a .gguf file   → launched with llama-server, then used
 *  - a folder       → scanned for .gguf files (returned so you can pick one)
 */
export async function connectCustom(target: string): Promise<ModelInfo[]> {
  const t = target.trim().replace(/^"(.*)"$/, '$1');
  if (/^https?:\/\//i.test(t)) {
    stopLlamaServer();
    state.provider = 'custom';
    state.customBaseUrl = t.replace(/\/+$/, '');
    const models = await fetchAvailableModels('custom').catch(() => [] as ModelInfo[]);
    const first = models.find((m) => m.detail === 'served');
    if (first) state.model = first.id;
    state.changed();
    log.event(`[llm] using custom endpoint ${state.customBaseUrl} (model: ${state.model})`);
    return models;
  }
  if (!existsSync(t)) throw new Error(`not found: ${t}`);
  if ((await stat(t)).isDirectory()) return ggufInfos(await scanGguf(t));
  if (!/\.gguf$/i.test(t)) throw new Error('expected an http(s) URL, a .gguf file, or a folder of .gguf files');
  await startLlamaServer(t);
  state.provider = 'custom';
  state.model = path.basename(t, path.extname(t));
  state.changed();
  return [{ id: t, provider: 'custom', detail: 'running' }];
}

// ── Generation ────────────────────────────────────────────────────────

/** Remove reasoning blocks, role prefixes and wrapping quotes some models add. */
export function cleanReply(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  s = s.replace(/^\s*(assistant|me|reply|response)\s*:\s*/i, '').trim();
  if (/^["“].*["”]$/s.test(s)) s = s.slice(1, -1).trim();
  return s.trim();
}

function buildMessages(senderText: string, chatHistorySummary?: string, history: ChatTurn[] = []) {
  let system = SYSTEM_PROMPT;
  if (config.AI_PERSONA) system += `\nAbout the phone owner: ${config.AI_PERSONA}`;
  if (chatHistorySummary) system += `\nConversation context: ${chatHistorySummary}`;
  return [
    { role: 'system' as const, content: system },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user' as const, content: senderText },
  ];
}

export async function generateReply(
  senderText: string,
  chatHistorySummary?: string,
  history: ChatTurn[] = [],
): Promise<string> {
  const messages = buildMessages(senderText, chatHistorySummary, history);
  const provider = state.provider;
  let raw: string;
  try {
    if (provider === 'ollama') {
      const { data } = await axios.post<{ message: { content: string } }>(
        `${config.OLLAMA_BASE_URL}/api/chat`,
        { model: state.model, messages, stream: false, options: { temperature: 0.7, num_predict: 160 } },
        { timeout: 120_000 },
      );
      raw = data.message.content;
    } else {
      const { data } = await axios.post<{ choices: { message: { content: string } }[] }>(
        `${baseUrlFor(provider)}/chat/completions`,
        {
          model: state.model,
          messages,
          temperature: 0.7,
          max_tokens: 160,
          stream: false,
          // llama.cpp: turn off "thinking" for hybrid reasoning models (servers that don't know it ignore it).
          ...(provider === 'custom' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        },
        { timeout: 120_000, headers: authHeaders(provider) },
      );
      raw = data.choices[0]?.message.content ?? '';
    }
  } catch (e) {
    const detail = axios.isAxiosError(e) ? JSON.stringify(e.response?.data ?? e.code ?? e.message) : errMsg(e);
    throw new Error(`${provider} request failed: ${detail}`);
  }
  const reply = cleanReply(raw);
  if (!reply) throw new Error('model returned an empty reply');
  return reply;
}
