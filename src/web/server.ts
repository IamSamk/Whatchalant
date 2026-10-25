import http from 'node:http';
import QRCode from 'qrcode';
import { config, jidUser, state } from '../config.js';
import { recentChats } from '../core/assistant.js';
import { drafts } from '../core/drafts.js';
import { errMsg, log } from '../core/log.js';
import { explain } from '../core/hints.js';
import { dispatcher } from '../core/queue.js';
import { listJobs } from '../services/scheduler.js';
import { runCommandSafe } from '../ui/commands.js';
import { runDoctor } from '../core/doctor.js';
import { hintFor } from '../core/hints.js';
import { fetchAvailableModels } from '../services/llm.js';
import { PAGE } from './page.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function snapshot() {
  return {
    connection: state.connection,
    me: state.me ? { name: state.me.name, number: jidUser(state.me.id) } : null,
    // Low error correction = fewer, bigger squares; 4-module white border; drawn pixel-exact as a PNG.
    qrPng: state.qr ? await QRCode.toDataURL(state.qr, { errorCorrectionLevel: 'L', margin: 4, scale: 10 }) : null,
    pairingCode: state.pairingCode,
    myNumber: config.MY_PHONE_NUMBER,
    toggles: { voice: state.voiceAlerts, ai: state.aiAutoReply, draft: state.draftMode, selftest: state.selfChatTest },
    llm: { provider: state.provider, model: state.model, baseUrl: state.provider === 'custom' ? state.customBaseUrl : null },
    queue: dispatcher.pending,
    drafts: drafts.list().map(({ id, label, incoming, text, source, createdAt }) => ({ id, label, incoming, text, source, createdAt })),
    jobs: listJobs(),
    chats: recentChats().slice(0, 15),
    whitelist: [...state.whitelist],
    logs: log.recent(80).map((l) => ({ ...l, msg: stripAnsi(l.msg) })),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
      if (body.length > 64_000) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Local-only dashboard for every feature. Binds to 127.0.0.1 only. */
export function startDashboard() {
  const server = http.createServer(async (req, res) => {
    // Reject requests that don't target localhost (DNS-rebinding protection).
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') {
      res.writeHead(403).end();
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(PAGE);
        return;
      }
      if (req.method === 'GET' && req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await snapshot()));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/models') {
        let body: unknown;
        try {
          const models = await fetchAvailableModels();
          body = {
            models,
            hint: models.length ? undefined : state.provider === 'ollama' ? 'Ollama has no models. Run "ollama pull llama3.2:3b", or connect your own below.' : 'No models found. Connect a URL, .gguf file or folder below.',
          };
        } catch (e) {
          body = { models: [], error: hintFor('llm', e) ?? errMsg(e) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/doctor') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await runDoctor()));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/command') {
        // A custom header can't be sent cross-origin without a preflight we never approve → blocks CSRF.
        if (req.headers['x-whatchalant'] !== '1') {
          res.writeHead(403).end();
          return;
        }
        const { command } = JSON.parse(await readBody(req)) as { command?: string };
        const output = stripAnsi(await runCommandSafe(String(command ?? '')));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output }));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(errMsg(e));
    }
  });
  server.on('error', (e) => log.error(explain('dashboard', e, '[web] dashboard failed: ')));
  server.listen(config.DASHBOARD_PORT, '127.0.0.1', () =>
    log.info(`[web] dashboard on http://localhost:${config.DASHBOARD_PORT}`),
  );
  return server;
}
