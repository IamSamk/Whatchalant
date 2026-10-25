import 'dotenv/config';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));

const str = (def = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) ? n : def;
    });

export const PROVIDERS = ['ollama', 'lmstudio', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

const EnvSchema = z.object({
  MY_PHONE_NUMBER: str(),
  WHITELISTED_JIDS: str(),
  SELF_CHAT_TEST: bool(false),

  ELEVENLABS_API_KEY: str(),
  ELEVENLABS_VOICE_ID: str('21m00Tcm4TlvDq8ikWAM'),
  ELEVENLABS_MODEL_ID: str('eleven_flash_v2_5'),
  VOICE_ALERTS_ENABLED: bool(true),
  VOICE_SYSTEM_FALLBACK: bool(true),

  AI_PROVIDER: str('ollama').pipe(z.enum(PROVIDERS)),
  OLLAMA_BASE_URL: str('http://127.0.0.1:11434'),
  LMSTUDIO_BASE_URL: str('http://127.0.0.1:1234/v1'),
  AI_MODEL_NAME: str('llama3:latest'),
  AI_AUTOREPLY_ENABLED: bool(false),
  AI_DRAFT_MODE: bool(true),
  AI_PERSONA: str(),

  CUSTOM_BASE_URL: str('http://127.0.0.1:8089/v1'),
  CUSTOM_API_KEY: str(),
  CUSTOM_MODEL_PATH: str(),
  LLAMA_SERVER_PATH: str(),
  LLAMA_SERVER_PORT: int(8089),
  LLAMA_SERVER_ARGS: str('-c 4096 -ngl 99'),

  WHISPER_ENDPOINT: str(),
  WHISPER_CLI: str('whisper'),
  WHISPER_MODEL: str('base'),
  MIC_DEVICE: str(),

  DASHBOARD_PORT: int(3000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid .env configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

/** Strip the endpoint-style "[http://x](http://x)" markdown that sometimes sneaks into copied .env files. */
const cleanUrl = (u: string) => u.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1').replace(/\/+$/, '');

const env = parsed.data;

export const config = {
  ...env,
  OLLAMA_BASE_URL: cleanUrl(env.OLLAMA_BASE_URL),
  LMSTUDIO_BASE_URL: cleanUrl(env.LMSTUDIO_BASE_URL),
  CUSTOM_BASE_URL: cleanUrl(env.CUSTOM_BASE_URL),
  WHISPER_ENDPOINT: cleanUrl(env.WHISPER_ENDPOINT),
  MY_PHONE_NUMBER: env.MY_PHONE_NUMBER.replace(/\D/g, ''),
  paths: {
    root: process.cwd(),
    auth: path.resolve('auth_info_baileys'),
    temp: path.resolve('temp'),
    data: path.resolve('data'),
  },
} as const;

/** Digits / user part of a JID or phone number ("91987...@s.whatsapp.net:3" -> "91987..."). */
export function jidUser(jidOrNumber: string): string {
  const at = jidOrNumber.split('@')[0] ?? '';
  return (at.split(':')[0] ?? '').trim();
}

export type ConnectionStatus = 'Starting' | 'QR Required' | 'Connecting' | 'Connected' | 'Reconnecting' | 'Logged Out';

/** Mutable runtime state shared by the CLI, the web dashboard and the services. */
class RuntimeState extends EventEmitter {
  connection: ConnectionStatus = 'Starting';
  qr: string | null = null;
  me: { id: string; lid?: string; name?: string } | null = null;

  voiceAlerts = config.VOICE_ALERTS_ENABLED;
  aiAutoReply = config.AI_AUTOREPLY_ENABLED;
  draftMode = config.AI_DRAFT_MODE;
  selfChatTest = config.SELF_CHAT_TEST;

  provider: Provider = config.AI_PROVIDER;
  model = config.AI_MODEL_NAME;
  customBaseUrl = config.CUSTOM_BASE_URL;

  /** Normalised user parts (digits or lid ids) of whitelisted chats/contacts. */
  whitelist = new Set(
    config.WHITELISTED_JIDS.split(',')
      .map((s) => jidUser(s))
      .filter(Boolean),
  );

  changed() {
    this.emit('change');
  }
}

export const state = new RuntimeState();
