---
title: "Whatchalant: a lazy, local WhatsApp sidekick that reads my chats so I don't have to 🦥"
published: false
tags: devchallenge, hf26challenge, gemma, opensource
ai_disclosure_level: some_ai
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 3: Slow and Steady](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)*

## What I Built

**Whatchalant** is a personal WhatsApp assistant that runs entirely on my laptop. It links to my account as a normal WhatsApp linked device. After that, it does the WhatsApp chores I keep putting off:

- **🦥 Catch me up.** Messages pile up in my group chats while I'm away. One click, and a local model gives me one line per chat, with the chats that need me first. It can also send that digest to my own "Message yourself" chat every morning.
- **🔔 Voice alerts when I'm @mentioned.** If someone tags me in a group while I'm heads-down, my laptop says it out loud. That uses ElevenLabs, or the built-in system voice offline.
- **💬 Replies drafted by my own model, sent only when I approve them.** For chats I allow (or @mentions), the local model drafts a reply in my tone. It waits on a dashboard until I click Send.
- **🎙 Dictation.** I speak a message; local Whisper turns it into a draft.
- **⏰ Scheduler.** "Good morning" every weekday at 9, or a one-off reminder for tonight.

Everything runs from a localhost dashboard, so you don't need to learn any commands.

**Who gets to be lazier:** anyone in too many group chats. That means students, family admins, and people who mute everything and then miss the one message that mattered.

## Demo

<!-- Upload a short video or GIF here (YouTube/Loom embed or an uploaded GIF), showing:
     1. A message arrives → a draft appears on the dashboard → click Send → "typing…" shows on the phone → the reply lands
     2. Click "Catch me up" → three-line summary
     Before recording: blur your phone number in the dashboard header and any real names or messages. -->

A sample "Catch me up" result, from three busy chats:

> **College Friends**: Trek on Saturday, need headcount by tonight → needs you
> **Mom**: Aunty's function date is Nov 2nd, call me when free → needs you
> **Project Team**: Demo moved to Monday 11am

## Code

{% github IamSamk/Whatchalant %}

## How I Built It

- **WhatsApp:** [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source TypeScript implementation of the WhatsApp Web multi-device protocol.
- **Models:** any local model. Ollama, LM Studio, any OpenAI-compatible endpoint (I use my own harnesses), or just a folder of `.gguf` files. For a `.gguf` file, the app starts `llama-server` from llama.cpp itself. I run **Gemma 4 E4B (Q4_K_M)** on my laptop GPU: it loads in about 8 seconds, drafts a reply in about 0.5 seconds, and summarises a batch of chats in about 1 second.
- **Speech-to-text:** OpenAI's open-source Whisper, running locally, for voice notes and dictation.
- **Not getting banned:** WhatsApp flags bots that answer instantly or in bulk, so every outgoing message goes through a single queue, one at a time. Before sending, it does three things:
  - It "reads" for 1.5 s + 20 ms per character + 1–3 s of random jitter.
  - It shows *typing…* for 2–6 s, depending on reply length.
  - After sending, it cools down for 1.5–3 s.
  
  On top of that:
  - It only replies to chats I allow, or to @mentions.
  - It stops after 4 replies per chat in 10 minutes, or 20 per hour in total.
  - It goes quiet in any chat where I typed myself recently.
- **Self-diagnosing:** a health check tests the model server, Whisper, ffmpeg and WhatsApp at startup, and every error says how to fix it.

**Something I hit along the way:** WhatsApp now addresses chats by anonymous "LID" IDs (`…@lid`), not phone numbers. On Baileys 6.7, every message in my own self-chat arrived as undecryptable ("No session record"). Upgrading to Baileys 7, which handles LID sessions, fixed it without re-linking.

**AI disclosure:** I built this with an AI coding assistant (Claude Code). It wrote much of the code from my spec, and I tested and directed it. The finished app itself uses only open models running locally.

## Why Does Open Innovation Matter?

My WhatsApp messages are the most private data I have: family, friends, work. A closed "AI inbox" API would mean uploading all of it to someone else's server. With open-weight models, **not a single message leaves my laptop**:
- The summaries, the drafted replies and the voice transcription all run locally.
- The AI parts need no internet at all; only WhatsApp itself does.
- It costs nothing per message, so it can summarise every chat every morning without a token bill.

Open weights also let me swap models freely. The same app runs a small model on a weak laptop or a 9B model on my GPU, and I can point it at my own fine-tuned harness with one URL. Changing the model, the prompt or the reply rules is a config change, not a feature request to a vendor.

## My Agent Session

<!-- Optional: save this build session with DevRelay and embed it with the agent_session tag (see the challenge page), or link to it. Remove this section if you skip it. -->

## The Lazy Payoff

<!-- Make this yours, with real numbers from your week. For example:
     - "My groups had ~N unread messages last night; Catch me up gave me 3 lines in about a second."
     - "Morning digest at 8:00 means I don't open WhatsApp until something actually needs me."
     - "Drafted replies mean answering a whitelisted chat is one click instead of typing."
     Remove this section if you don't have numbers yet. -->

## Prize Categories

- **Best Use of Gemma:** the whole assistant runs on Gemma 4 E4B, locally through llama.cpp.

<!-- Only add "Best Use of ElevenLabs" if you actually test the voice alerts with an ElevenLabs API key and show it in the demo. -->
