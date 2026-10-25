import { config, state } from '../config.js';

/** Where a failure happened, so the hint can be specific. */
export type FailureArea = 'llm' | 'tts' | 'stt' | 'mic' | 'whatsapp' | 'dashboard' | 'scheduler' | 'general';

interface ErrLike {
  message?: string;
  code?: string;
  response?: { status?: number; data?: unknown };
  output?: { statusCode?: number };
}

const asErr = (e: unknown): ErrLike => (typeof e === 'object' && e !== null ? (e as ErrLike) : { message: String(e) });

function llmEndpoint() {
  if (state.provider === 'ollama') return config.OLLAMA_BASE_URL;
  if (state.provider === 'lmstudio') return config.LMSTUDIO_BASE_URL;
  return state.customBaseUrl;
}

/**
 * Turn a raw error into "what went wrong → how to fix it".
 * Returns null when there's no better advice than the message itself.
 */
export function hintFor(area: FailureArea, e: unknown): string | null {
  const err = asErr(e);
  const msg = `${err.message ?? ''} ${typeof err.response?.data === 'string' ? err.response.data : JSON.stringify(err.response?.data ?? '')}`;
  const code = err.code ?? (/\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|ENOENT|EADDRINUSE|EACCES)\b/.exec(msg)?.[1] ?? '');
  const status = err.response?.status ?? Number(/HTTP (\d{3})/.exec(msg)?.[1] ?? 0);

  switch (area) {
    case 'llm':
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET')
        return state.provider === 'ollama'
          ? `Ollama isn't running at ${llmEndpoint()}. Start it (open the Ollama app or run "ollama serve"), or switch provider in the dashboard.`
          : state.provider === 'lmstudio'
            ? `LM Studio's server isn't running at ${llmEndpoint()}. In LM Studio open Developer → Start Server and load a model.`
            : `Nothing is listening at ${llmEndpoint()}. Start your server, or pick a .gguf in the dashboard's Model panel so the app launches llama-server for you.`;
      if (code === 'ETIMEDOUT' || /timeout/i.test(msg))
        return 'The model took too long (over 2 min). Try a smaller model, or lower LLAMA_SERVER_ARGS context (-c) / offload more layers to the GPU (-ngl).';
      if (status === 404 || /model .*not found|not found, try pulling/i.test(msg))
        return state.provider === 'ollama'
          ? `Ollama doesn't have "${state.model}". Run "ollama pull ${state.model}" or pick an installed model in the dashboard.`
          : `The server doesn't know model "${state.model}". Click "List models" in the dashboard and pick one it serves.`;
      if (/llama-server/.test(msg) && code === 'ENOENT')
        return 'llama-server.exe was not found. Set LLAMA_SERVER_PATH in .env to its full path (from a llama.cpp release).';
      if (/out of memory|CUDA error|failed to load model/i.test(msg))
        return 'The model failed to load (usually not enough GPU/RAM). Try a smaller quantisation, or reduce -ngl / -c in LLAMA_SERVER_ARGS.';
      if (/empty reply/.test(msg)) return 'The model answered with nothing. Reasoning models sometimes do this; try again or use an instruct model.';
      return null;

    case 'tts':
      if (status === 401) return 'ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in .env (Profile → API keys on elevenlabs.io).';
      if (status === 402 || /quota|credits/i.test(msg)) return 'ElevenLabs quota is used up. Alerts will use the system voice if VOICE_SYSTEM_FALLBACK=true.';
      if (status === 404) return `ElevenLabs voice "${config.ELEVENLABS_VOICE_ID}" doesn't exist. Set ELEVENLABS_VOICE_ID to a voice from your Voices page.`;
      if (status === 422) return `ElevenLabs refused the request. Check ELEVENLABS_MODEL_ID ("${config.ELEVENLABS_MODEL_ID}") is a valid model.`;
      if (status === 429) return 'ElevenLabs is rate-limiting you. Alerts will resume shortly.';
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') return 'Could not reach ElevenLabs (no internet?). The system voice is used as a fallback.';
      if (/powershell|SpeechSynthesizer|espeak|say/i.test(msg))
        return 'The built-in system voice failed. On Linux install espeak; on Windows make sure PowerShell is available.';
      return null;

    case 'stt':
      if (code === 'ENOENT' || /not recognized|not found/i.test(msg))
        return `The Whisper CLI ("${config.WHISPER_CLI}") isn't installed or not on PATH. Run "pip install openai-whisper", or run a whisper.cpp server and set WHISPER_ENDPOINT.`;
      if (/ffmpeg/i.test(msg)) return 'Whisper needs ffmpeg to read audio. Install ffmpeg and add it to PATH.';
      if (/Failed to decrypt|download|403|410/i.test(msg)) return 'The voice note could not be downloaded from WhatsApp (it may have expired). Ask them to resend it.';
      if (status >= 400) return `The Whisper server at ${config.WHISPER_ENDPOINT} returned HTTP ${status}. Check it is a whisper.cpp server exposing /inference.`;
      return null;

    case 'mic':
      if (code === 'ENOENT') return 'ffmpeg is not installed or not on PATH. Install ffmpeg to use dictation.';
      if (/no microphone/i.test(msg)) return 'No microphone was found. Plug one in, or set MIC_DEVICE in .env (list devices: ffmpeg -list_devices true -f dshow -i dummy).';
      if (/Could not|I\/O error|Permission/i.test(msg))
        return 'The microphone could not be opened. On Windows allow desktop apps to use the mic (Settings → Privacy → Microphone) and check MIC_DEVICE.';
      return null;

    case 'whatsapp': {
      const sc = err.output?.statusCode ?? status;
      if (/not connected/i.test(msg)) return 'WhatsApp is not linked yet. Open the dashboard and scan the QR (or use "Get code").';
      if (sc === 401) return 'This device was unlinked from your phone. A new QR is being generated; scan it again.';
      if (sc === 403) return 'WhatsApp refused the connection (account restricted). Stop automation, open WhatsApp on your phone and check for warnings.';
      if (sc === 405) return 'WhatsApp rejected this client version. Update Baileys: npm install @whiskeysockets/baileys@latest.';
      if (sc === 408) return 'The QR codes expired before being scanned. Fresh ones are on the dashboard.';
      if (sc === 428 || sc === 503) return 'The connection dropped (network or WhatsApp hiccup). Reconnecting automatically.';
      if (sc === 440) return 'Another session took over this login (the app is running twice?). Close the other instance.';
      if (sc === 500) return 'The saved session is corrupt. Stop the app, delete the auth_info_baileys folder, start again and re-scan.';
      if (sc === 515) return null; // normal restart after pairing
      if (code === 'ENOTFOUND' || code === 'ETIMEDOUT') return 'No internet connection to WhatsApp. It will keep retrying.';
      return null;
    }

    case 'dashboard':
      if (code === 'EADDRINUSE')
        return `Port ${config.DASHBOARD_PORT} is already in use (is the app already running?). Close it, or set DASHBOARD_PORT in .env to another port.`;
      if (code === 'EACCES') return `Not allowed to use port ${config.DASHBOARD_PORT}. Pick a port above 1024 with DASHBOARD_PORT.`;
      return null;

    case 'scheduler':
      if (/invalid cron/i.test(msg)) return 'Cron format is "minute hour day month weekday", e.g. "0 9 * * 1-5" = 9:00 on weekdays. Try crontab.guru.';
      if (/past/i.test(msg)) return 'Pick a time in the future, e.g. +10m, 18:30, or 2026-12-31T09:00.';
      return null;

    default:
      return null;
  }
}

/** "message" plus "→ fix" when we know one. */
export function explain(area: FailureArea, e: unknown, prefix = ''): string {
  const err = asErr(e);
  const base = `${prefix}${err.message ?? String(e)}`;
  const hint = hintFor(area, e);
  return hint ? `${base}\n   → ${hint}` : base;
}
