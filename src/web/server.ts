import http from 'node:http';
import QRCode from 'qrcode';
import { config, jidUser, state } from '../config.js';
import { recentChats } from '../core/assistant.js';
import { drafts } from '../core/drafts.js';
import { errMsg, log } from '../core/log.js';
import { dispatcher } from '../core/queue.js';
import { listJobs } from '../services/scheduler.js';
import { runCommand } from '../ui/commands.js';

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

/** Tiny local-only dashboard: QR pairing, status, toggles, draft approval. Binds to 127.0.0.1 only. */
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
      if (req.method === 'POST' && req.url === '/api/command') {
        // A custom header can't be sent cross-origin without a preflight we never approve → blocks CSRF.
        if (req.headers['x-whatchalant'] !== '1') {
          res.writeHead(403).end();
          return;
        }
        const { command } = JSON.parse(await readBody(req)) as { command?: string };
        let output: string;
        try {
          output = stripAnsi(await runCommand(String(command ?? '')));
        } catch (e) {
          output = `error: ${errMsg(e)}`;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output }));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(errMsg(e));
    }
  });
  server.on('error', (e) => log.error(`[web] dashboard failed: ${errMsg(e)}`));
  server.listen(config.DASHBOARD_PORT, '127.0.0.1', () =>
    log.info(`[web] dashboard on http://localhost:${config.DASHBOARD_PORT}`),
  );
  return server;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whatchalant</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181d; --mute:#667085; --line:#e4e7ec; --ok:#12b76a; --warn:#f79009; --bad:#f04438; --acc:#25d366; --accInk:#05391b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --card:#161b22; --ink:#e6edf3; --mute:#8b949e; --line:#262c36; --accInk:#04210f; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:20px 16px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  header { max-width:1100px; margin:0 auto; padding:20px 16px 0; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:20px; margin:0; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--mute); margin:0 0 10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; min-width:0; }
  .wide { grid-column:1/-1; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:99px; border:1px solid var(--line); font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warn); }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--bad); }
  #qrImg { width:min(100%, 420px); height:auto; image-rendering:pixelated; background:#fff; border-radius:6px; display:block; margin:0 auto; }
  #qrCard { grid-column:1/-1; }
  .code { font:600 34px/1.2 ui-monospace,Consolas,monospace; letter-spacing:.12em; padding:10px 14px; border:1px dashed var(--line); border-radius:10px; display:inline-block; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; }
  button:hover { border-color:var(--mute); }
  button.on { background:var(--acc); color:var(--accInk); border-color:transparent; font-weight:600; }
  button.danger { color:var(--bad); }
  input { font:inherit; width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
  .draft { border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:8px; }
  .muted { color:var(--mute); }
  .mono, pre { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:340px; overflow:auto; }
  .lg-warn { color:var(--warn); } .lg-error { color:var(--bad); } .lg-event { color:#2e90fa; } .lg-draft { color:#9e77ed; }
  ul { margin:0; padding-left:18px; } li { margin:2px 0; word-break:break-word; }
  textarea { font:inherit; width:100%; min-height:54px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); }
</style>
</head>
<body>
<header>
  <h1>Whatchalant</h1>
  <span class="pill"><span id="dot" class="dot"></span><span id="conn">Starting</span></span>
  <span id="me" class="muted"></span>
</header>
<main>
  <section class="card" id="qrCard">
    <h2>Link device</h2>
    <div id="qrBox"><p class="muted">Waiting for WhatsApp…</p></div>
    <div id="pairBox" style="margin-top:14px; display:none">
      <p class="muted" style="margin:0 0 8px">QR won't scan? Link with a code instead:</p>
      <form id="pairForm" class="row" style="flex-wrap:nowrap"><input id="pairNum" placeholder="Your number with country code, e.g. 919876543210" inputmode="numeric"><button>Get code</button></form>
      <div id="pairCode" style="margin-top:10px"></div>
    </div>
  </section>
  <section class="card">
    <h2>Switches</h2>
    <div class="row" id="toggles"></div>
    <p class="muted" id="llm" style="margin:12px 0 0"></p>
    <p class="muted" id="queue" style="margin:4px 0 0"></p>
  </section>
  <section class="card">
    <h2>Drafts awaiting approval</h2>
    <div id="drafts"><p class="muted">None.</p></div>
  </section>
  <section class="card">
    <h2>Command</h2>
    <form id="cmdForm" class="row" style="flex-wrap:nowrap"><input id="cmd" placeholder=":help" autocomplete="off"><button>Run</button></form>
    <pre id="out" style="margin-top:10px"></pre>
  </section>
  <section class="card">
    <h2>Recent chats</h2>
    <ul id="chats" class="mono"></ul>
  </section>
  <section class="card">
    <h2>Scheduled</h2>
    <ul id="jobs" class="mono"></ul>
  </section>
  <section class="card wide">
    <h2>Activity</h2>
    <pre id="logs"></pre>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function command(c) {
  const r = await fetch('/api/command', { method:'POST', headers:{'Content-Type':'application/json','X-Whatchalant':'1'}, body: JSON.stringify({ command:c }) });
  const { output } = await r.json();
  $('out').textContent = output;
  refresh();
}
$('cmdForm').onsubmit = (e) => { e.preventDefault(); const c = $('cmd').value.trim(); if (c) command(c); $('cmd').value=''; };
let lastQr = null, editing = new Set(), numFilled = false, lastDrafts = [];
$('pairForm').onsubmit = (e) => { e.preventDefault(); const n = $('pairNum').value.replace(/\\D/g,''); command(':pair ' + n); };
async function refresh() {
  let s; try { s = await (await fetch('/api/state')).json(); } catch { $('conn').textContent = 'App not running'; $('dot').className='dot bad'; return; }
  $('conn').textContent = s.connection;
  $('dot').className = 'dot ' + (s.connection === 'Connected' ? 'ok' : s.connection === 'Logged Out' ? 'bad' : '');
  $('me').textContent = s.me ? (s.me.name || '') + ' · +' + s.me.number : '';
  if (s.qrPng && s.qrPng !== lastQr) {
    $('qrBox').innerHTML = '<img id="qrImg" alt="WhatsApp QR code" src="' + s.qrPng + '"><p class="muted" style="text-align:center">WhatsApp on your phone → Settings → Linked devices → Link a device. Refreshes every ~20s.</p>';
  } else if (!s.qrPng) {
    $('qrBox').innerHTML = s.connection === 'Connected' ? '<p>✅ Linked. You can close this tab; the assistant keeps running.</p>' : '<p class="muted">Waiting for WhatsApp… (' + esc(s.connection) + ')</p>';
  }
  lastQr = s.qrPng;
  const linking = s.connection !== 'Connected';
  $('pairBox').style.display = linking ? 'block' : 'none';
  if (!numFilled && s.myNumber) { $('pairNum').value = s.myNumber; numFilled = true; }
  $('pairCode').innerHTML = s.pairingCode && linking ? '<div class="code">' + esc(s.pairingCode) + '</div><p class="muted">Phone: Linked devices → Link a device → <b>Link with phone number instead</b> → type this code.</p>' : '';
  const t = s.toggles;
  $('toggles').innerHTML = [['ai','AI auto-reply'],['draft','Draft mode'],['voice','Voice alerts'],['selftest','Self-chat test']]
    .map(([k,l]) => '<button class="'+(t[k]?'on':'')+'" data-t="'+k+'">'+l+': '+(t[k]?'ON':'OFF')+'</button>').join('');
  $('toggles').querySelectorAll('button').forEach(b => b.onclick = () => command(':toggle ' + b.dataset.t));
  $('llm').textContent = 'LLM: ' + s.llm.provider + ' / ' + s.llm.model + (s.llm.baseUrl ? ' @ ' + s.llm.baseUrl : '');
  $('queue').textContent = 'Queue: ' + s.queue + ' pending · Whitelist: ' + (s.whitelist.length ? s.whitelist.length + ' entries' : 'none');
  lastDrafts = s.drafts;
  if (!editing.size) {
    $('drafts').innerHTML = s.drafts.length ? s.drafts.map(d =>
      '<div class="draft"><div class="muted">#'+d.id+' → '+esc(d.label)+'</div>' +
      (d.incoming ? '<div class="muted">“'+esc(d.incoming)+'”</div>' : '') +
      '<textarea data-id="'+d.id+'">'+esc(d.text)+'</textarea>' +
      '<div class="row" style="margin-top:6px"><button class="on" data-a="send" data-id="'+d.id+'">Send</button><button class="danger" data-a="reject" data-id="'+d.id+'">Discard</button></div></div>'
    ).join('') : '<p class="muted">None.</p>';
    $('drafts').querySelectorAll('textarea').forEach(ta => { ta.onfocus = () => editing.add(ta.dataset.id); ta.onblur = () => setTimeout(() => editing.delete(ta.dataset.id), 300); });
    $('drafts').querySelectorAll('button').forEach(b => b.onclick = () => {
      const id = b.dataset.id; editing.delete(id);
      if (b.dataset.a === 'reject') return command(':reject ' + id);
      const text = $('drafts').querySelector('textarea[data-id="'+id+'"]').value.replace(/\\s+/g,' ').trim();
      const orig = (lastDrafts.find(d => String(d.id) === id) || {}).text;
      command(text === orig ? ':approve ' + id : ':edit ' + id + ' ' + text);
    });
  }
  $('chats').innerHTML = s.chats.length ? s.chats.map(c => '<li>'+(c.isGroup?'👥 ':'👤 ')+esc(c.name)+' <span class="muted">'+esc(c.jid)+'</span></li>').join('') : '<li class="muted">No chats yet.</li>';
  $('jobs').innerHTML = s.jobs.length ? s.jobs.map(j => '<li>#'+j.id+' '+esc(j.kind === 'cron' ? j.when : new Date(j.when).toLocaleString())+' → '+esc(j.jid)+': '+esc(j.message)+'</li>').join('') : '<li class="muted">Nothing scheduled.</li>';
  const logs = $('logs'); const atBottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 30;
  logs.innerHTML = s.logs.map(l => '<span class="lg-'+l.level+'">'+new Date(l.ts).toLocaleTimeString()+'  '+esc(l.msg)+'</span>').join('\\n');
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;
