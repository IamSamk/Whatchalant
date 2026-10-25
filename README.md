# Whatchalant

A local-first personal WhatsApp assistant that runs on your own computer as a linked device. It uses Baileys for WhatsApp, local LLMs to draft replies, and Whisper for speech-to-text.

- **Mention alerts:** when someone @tags you in a group, the alert is read aloud. It uses ElevenLabs if you set an API key, otherwise your computer's built-in voice.
- **AI replies with anti-ban pacing:** replies come from Ollama, LM Studio, or your own model (any OpenAI-compatible URL, or a `.gguf` file that the app launches with `llama-server`). Messages are sent one at a time, with a reading pause, "typing…", and a cooldown.
- **Draft & Approve:** replies wait for your OK in the terminal, on the localhost dashboard, or in your "Message yourself" chat.
- **Voice:** incoming voice notes are transcribed, and `:dictate` turns your mic recording into a draft. Both use local Whisper.
- **Scheduler:** recurring messages on a cron schedule, plus one-off messages at a set time (`:at`). Jobs survive restarts.

## Setup

```bash
npm install
cp .env.example .env   # then edit it
npm run dev
```

Open http://localhost:3000 and link the device. On your phone, go to WhatsApp → Settings → Linked devices → Link a device and scan the QR. If the camera won't scan it, click **Get code** on the page and use "Link with phone number instead". Your login is saved in `auth_info_baileys/`.

Requires Node 20+. Dictation needs `ffmpeg`. Transcription needs either a whisper.cpp server (`WHISPER_ENDPOINT`) or the `whisper` CLI (`pip install openai-whisper`).

## Using your own models

| `.env` / command | Effect |
|---|---|
| `AI_PROVIDER="ollama"` + `:models` | Pick from `ollama list` |
| `AI_PROVIDER="lmstudio"` | Use LM Studio's server on :1234 |
| `:connect http://127.0.0.1:9000/v1` | Use any OpenAI-compatible endpoint (your own harness, vLLM, llama.cpp) |
| `:connect D:\models` | List every `.gguf` in a folder, then `:model <n>` to launch one |
| `CUSTOM_MODEL_PATH=…/model.gguf` | Launch that model with `llama-server` at startup (`LLAMA_SERVER_PATH`, `LLAMA_SERVER_ARGS`) |

## Who gets AI replies

AI replies are off unless `AI_AUTOREPLY_ENABLED=true` or you run `:toggle ai`. When they're on:

- **Direct messages:** only contacts listed in `WHITELISTED_JIDS` (or added with `:whitelist add <number>`).
- **Groups:** only messages that @mention you. If the whitelist is set, the group or the sender must also be on it.
- **Never:** status updates, broadcast lists, channels, or messages older than 90 seconds (backlog delivered after being offline).
- **Circuit breakers:**
  - at most 4 replies per chat every 10 minutes;
  - at most 20 per hour in total (hitting this switches auto-reply off);
  - silence in any chat where you typed yourself in the last 10 minutes.

**Testing with one phone:** set `SELF_CHAT_TEST=true`. Messages you send in "Message yourself" are then treated as incoming, and replies come back there starting with 🤖. Lines starting with `:` in that chat run commands (`:status`, `:toggle draft` …).

## Commands

Type these in the terminal, the dashboard's command box, or your self-chat:

```
:status  :models  :model <n|name|path>  :provider <name>  :connect <url|gguf|folder>
:toggle ai|voice|draft|selftest   :drafts  y / n  :approve <id>  :reject <id>  :edit <id> <text>
:send <number> <text>   :dictate <number> [secs]   :pair [number]
:schedule <number> "<cron>" <message>   :at <number> <+10m|18:30|ISO> <message>   :jobs  :cancel <id>
:whitelist [add|remove <number>]   :chats   :quit
```

## ElevenLabs

To use ElevenLabs, set `ELEVENLABS_API_KEY`. You can also set `ELEVENLABS_VOICE_ID` (default: Rachel) and `ELEVENLABS_MODEL_ID`. The app calls `POST /v1/text-to-speech/{voice_id}`, saves the audio to `temp/`, plays it, and then deletes the file. Without a key, `VOICE_SYSTEM_FALLBACK=true` uses the operating system's own voice instead.

## Notes

- This app uses Baileys 7 (pre-release) because WhatsApp now addresses chats with LID IDs, and Baileys 6.7 can't decrypt those messages.
- Automating a personal account is against WhatsApp's terms. Keep volumes low and the whitelist small.
