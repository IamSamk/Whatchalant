import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { errMsg, log } from '../core/log.js';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

/** whisper.cpp server: POST multipart to /inference. Returns null when the server isn't reachable. */
async function transcribeViaEndpoint(file: string): Promise<string | null> {
  if (!config.WHISPER_ENDPOINT) return null;
  try {
    const form = new FormData();
    form.append('file', new Blob([await readFile(file)]), path.basename(file));
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    const { data } = await axios.post<{ text?: string }>(config.WHISPER_ENDPOINT, form, { timeout: 120_000 });
    return (data.text ?? '').trim();
  } catch (e) {
    if (axios.isAxiosError(e) && !e.response) return null; // not running → fall back to CLI
    throw e;
  }
}

/** openai-whisper CLI fallback (`pip install openai-whisper`). */
async function transcribeViaCli(file: string): Promise<string> {
  const outDir = path.join(config.paths.temp, `whisper-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  try {
    const args = [file, '--model', config.WHISPER_MODEL, '--output_format', 'txt', '--output_dir', outDir, '--fp16', 'False', '--verbose', 'False'];
    // UTF-8 so non-Latin transcripts don't crash the CLI on a Windows console.
    const { code, out } = await run(config.WHISPER_CLI, args, { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    if (code !== 0) throw new Error(`whisper exited ${code}: ${out.trim().split('\n').slice(-2).join(' ')}`);
    const txt = path.join(outDir, `${path.basename(file, path.extname(file))}.txt`);
    return (await readFile(txt, 'utf8')).trim();
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function transcribeFile(file: string): Promise<string> {
  const viaServer = await transcribeViaEndpoint(file);
  if (viaServer !== null) return viaServer;
  return transcribeViaCli(file);
}

/** Download and transcribe an incoming WhatsApp voice note. */
export async function transcribeVoiceNote(msg: WAMessage): Promise<string> {
  await mkdir(config.paths.temp, { recursive: true });
  const buf = await downloadMediaMessage(msg, 'buffer', {});
  const file = path.join(config.paths.temp, `voice-${msg.key.id ?? Date.now()}.ogg`);
  await writeFile(file, buf);
  try {
    return await transcribeFile(file);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

// ── Microphone dictation ────────────────────────────────────────────────

async function defaultMic(): Promise<string> {
  if (config.MIC_DEVICE) return config.MIC_DEVICE;
  const { out } = await run('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const m = out.match(/"([^"]+)"\s+\(audio\)/);
  if (!m?.[1]) throw new Error('no microphone found (set MIC_DEVICE in .env)');
  return m[1];
}

/** Record `seconds` of microphone audio to a 16 kHz mono wav using ffmpeg. */
export async function recordMic(seconds: number): Promise<string> {
  await mkdir(config.paths.temp, { recursive: true });
  const file = path.join(config.paths.temp, `dictation-${Date.now()}.wav`);
  let input: string[];
  if (process.platform === 'win32') input = ['-f', 'dshow', '-i', `audio=${await defaultMic()}`];
  else if (process.platform === 'darwin') input = ['-f', 'avfoundation', '-i', `:${config.MIC_DEVICE || '0'}`];
  else input = ['-f', 'pulse', '-i', config.MIC_DEVICE || 'default'];
  const { code, out } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-t', String(seconds), '-ac', '1', '-ar', '16000', file]);
  if (code !== 0) throw new Error(`recording failed: ${out.trim()}`);
  return file;
}

/** Record from the mic and return the transcript. */
export async function dictate(seconds: number): Promise<string> {
  log.event(`[stt] 🎙  recording for ${seconds}s, speak now...`);
  const file = await recordMic(seconds);
  log.info('[stt] transcribing...');
  try {
    return await transcribeFile(file);
  } catch (e) {
    throw new Error(`transcription failed: ${errMsg(e)}`);
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}
