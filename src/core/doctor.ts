import { spawn } from 'node:child_process';
import axios from 'axios';
import { config, state } from '../config.js';
import { fetchAvailableModels } from '../services/llm.js';
import { hintFor } from './hints.js';
import { log } from './log.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** How to fix it (only when not ok). */
  fix?: string;
  /** Not required for the core features. */
  optional?: boolean;
}

function canRun(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const t = setTimeout(() => {
      p.kill();
      resolve(true); // still running = it exists
    }, 8000);
    p.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    p.on('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** Check every dependency and say how to fix whatever is missing. */
export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push({
    name: 'WhatsApp',
    ok: state.connection === 'Connected',
    detail: state.connection,
    fix: state.connection === 'Connected' ? undefined : 'Open the dashboard and scan the QR, or use "Get code" to link with your number.',
  });

  try {
    const models = await fetchAvailableModels();
    const has = state.provider === 'custom' ? models.length > 0 || state.model !== '' : models.some((m) => m.id === state.model);
    checks.push({
      name: `LLM (${state.provider})`,
      ok: has,
      detail: has ? `${state.model} ready` : `"${state.model}" not found (${models.length} available)`,
      fix: has
        ? undefined
        : models.length
          ? 'Pick one of the available models in the Model panel.'
          : state.provider === 'ollama'
            ? 'No models installed. Run "ollama pull llama3.2:3b", or connect your own .gguf / endpoint in the Model panel.'
            : 'Load a model in your server, or pick a .gguf file in the Model panel.',
    });
  } catch (e) {
    checks.push({ name: `LLM (${state.provider})`, ok: false, detail: 'unreachable', fix: hintFor('llm', e) ?? String(e) });
  }

  const ffmpeg = await canRun('ffmpeg', ['-version']);
  checks.push({
    name: 'ffmpeg',
    ok: ffmpeg,
    detail: ffmpeg ? 'installed' : 'missing',
    fix: ffmpeg ? undefined : 'Install ffmpeg (winget install ffmpeg) and add it to PATH. Needed for voice notes and dictation.',
    optional: true,
  });

  let whisperOk = false;
  let whisperDetail = '';
  if (config.WHISPER_ENDPOINT) {
    whisperOk = await axios
      .get(config.WHISPER_ENDPOINT.replace(/\/inference$/, '/'), { timeout: 2000 })
      .then(() => true)
      .catch((e) => axios.isAxiosError(e) && Boolean(e.response));
    whisperDetail = whisperOk ? `server at ${config.WHISPER_ENDPOINT}` : '';
  }
  if (!whisperOk) {
    whisperOk = await canRun(config.WHISPER_CLI, ['--help']);
    whisperDetail = whisperOk ? `CLI "${config.WHISPER_CLI}" (model ${config.WHISPER_MODEL})` : 'not found';
  }
  checks.push({
    name: 'Whisper (speech-to-text)',
    ok: whisperOk,
    detail: whisperDetail,
    fix: whisperOk ? undefined : 'Run "pip install openai-whisper", or start a whisper.cpp server and set WHISPER_ENDPOINT.',
    optional: true,
  });

  checks.push({
    name: 'Voice alerts',
    ok: Boolean(config.ELEVENLABS_API_KEY) || config.VOICE_SYSTEM_FALLBACK,
    detail: config.ELEVENLABS_API_KEY ? 'ElevenLabs' : config.VOICE_SYSTEM_FALLBACK ? 'system voice (no ElevenLabs key)' : 'off: no key, no fallback',
    fix: config.ELEVENLABS_API_KEY || config.VOICE_SYSTEM_FALLBACK ? undefined : 'Set ELEVENLABS_API_KEY or VOICE_SYSTEM_FALLBACK=true in .env.',
    optional: true,
  });

  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${c.ok ? '✅' : c.optional ? '⚠️ ' : '❌'} ${c.name}: ${c.detail}${c.fix ? `\n   → ${c.fix}` : ''}`)
    .join('\n');
}

/** Log any problems once at startup so setup mistakes are obvious. */
export async function startupDoctor() {
  const checks = await runDoctor();
  for (const c of checks) {
    if (c.ok || c.name === 'WhatsApp') continue;
    (c.optional ? log.warn : log.error)(`[setup] ${c.name}: ${c.detail}\n   → ${c.fix}`);
  }
}
