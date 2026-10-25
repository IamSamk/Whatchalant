import { spawn } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import PQueue from 'p-queue';
import sound from 'sound-play';
import { config, state } from '../config.js';
import { errMsg, log } from '../core/log.js';
import { explain } from '../core/hints.js';

const MAX_TEXT = 120;
// Alerts are spoken one at a time so overlapping mentions don't talk over each other.
const speechQueue = new PQueue({ concurrency: 1 });

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Make chat text speakable: drop raw @1234567 mention ids, URLs and extra whitespace. */
function speakable(text: string) {
  return text
    .replace(/@\d{5,}/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
}

async function elevenLabsSpeak(phrase: string) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.ELEVENLABS_VOICE_ID)}`;
  const res = await axios.post<ArrayBuffer>(
    url,
    { text: phrase, model_id: config.ELEVENLABS_MODEL_ID },
    {
      params: { output_format: 'mp3_44100_128' },
      headers: { 'xi-api-key': config.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      responseType: 'arraybuffer',
      timeout: 20_000,
    },
  );
  await mkdir(config.paths.temp, { recursive: true });
  // Unique name so a queued alert never overwrites one that is still playing.
  const file = path.join(config.paths.temp, `alert-${Date.now()}.mp3`);
  await writeFile(file, Buffer.from(res.data));
  try {
    await sound.play(file);
  } finally {
    await unlink(file).catch(() => undefined);
  }
}

/** Offline fallback: the operating system's own voice. Text goes through an env var, never the command line. */
function systemSpeak(phrase: string): Promise<void> {
  const env = { ...process.env, ALERT_TEXT: phrase };
  let cmd: string;
  let args: string[];
  if (process.platform === 'win32') {
    cmd = 'powershell.exe';
    args = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:ALERT_TEXT)',
    ];
  } else if (process.platform === 'darwin') {
    cmd = 'sh';
    args = ['-c', 'say "$ALERT_TEXT"'];
  } else {
    cmd = 'sh';
    args = ['-c', 'espeak "$ALERT_TEXT" 2>/dev/null || spd-say "$ALERT_TEXT"'];
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`system TTS exited with ${code}`))));
  });
}

/**
 * Speak a short "you were tagged" alert. Fire-and-forget: never throws, never blocks message handling.
 */
export function speakTagAlert(senderName: string, text: string, groupName?: string): void {
  if (!state.voiceAlerts) return;
  const body = truncate(speakable(text), MAX_TEXT);
  const where = groupName ? ` in ${groupName}` : '';
  const phrase = body ? `${senderName} mentioned you${where}: ${body}` : `${senderName} mentioned you${where}.`;

  void speechQueue.add(async () => {
    try {
      if (config.ELEVENLABS_API_KEY) {
        await elevenLabsSpeak(phrase);
        log.info('[tts] ElevenLabs alert played');
        return;
      }
      if (config.VOICE_SYSTEM_FALLBACK) {
        await systemSpeak(phrase);
        log.info('[tts] alert spoken with system voice (no ElevenLabs key set)');
      } else {
        log.warn('[tts] voice alert skipped: ELEVENLABS_API_KEY not set');
      }
    } catch (e) {
      log.error(explain('tts', e, '[tts] voice alert failed: '));
      if (config.ELEVENLABS_API_KEY && config.VOICE_SYSTEM_FALLBACK) await systemSpeak(phrase).catch(() => undefined);
    }
  });
}
