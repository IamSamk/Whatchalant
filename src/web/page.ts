// The dashboard page. String.raw keeps backslashes as-is; the client script below uses no backticks or "${".
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whatchalant</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181d; --mute:#667085; --line:#e4e7ec; --soft:#f2f4f7; --ok:#12b76a; --warn:#f79009; --bad:#f04438; --acc:#25d366; --accInk:#05391b; --link:#2e90fa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --card:#161b22; --ink:#e6edf3; --mute:#8b949e; --line:#262c36; --soft:#1c222b; --accInk:#04210f; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { max-width:1180px; margin:0 auto; padding:18px 16px 4px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { font-size:20px; margin:0; letter-spacing:-.01em; }
  h1 small { font-weight:500; color:var(--mute); font-size:13px; margin-left:6px; }
  main { max-width:1180px; margin:0 auto; padding:12px 16px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.07em; color:var(--mute); margin:0 0 10px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; min-width:0; }
  .wide { grid-column:1/-1; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:99px; border:1px solid var(--line); font-size:13px; background:var(--card); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--warn); }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--bad); }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .row.nowrap { flex-wrap:nowrap; }
  .stack > * + * { margin-top:8px; }
  label { font-size:12px; color:var(--mute); display:block; margin-bottom:3px; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; white-space:nowrap; }
  button:hover { border-color:var(--mute); }
  button:disabled { opacity:.5; cursor:wait; }
  button.primary { background:var(--acc); color:var(--accInk); border-color:transparent; font-weight:600; }
  button.danger { color:var(--bad); }
  button.mini { padding:2px 8px; font-size:12px; }
  input, select, textarea { font:inherit; width:100%; padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); min-width:0; }
  textarea { min-height:56px; resize:vertical; }
  .muted { color:var(--mute); } .small { font-size:12px; }
  .mono, pre { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; }
  .out { margin-top:10px; padding:10px; border-radius:8px; background:var(--soft); white-space:pre-wrap; word-break:break-word; font-size:13px; }
  .out.err { color:var(--bad); }
  .out:empty { display:none; }
  .toggle { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--line); }
  .toggle:first-of-type { border-top:0; }
  .switch { position:relative; width:42px; height:24px; flex:none; border-radius:99px; background:var(--line); border:0; padding:0; }
  .switch::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:left .15s; }
  .switch.on { background:var(--acc); } .switch.on::after { left:21px; }
  #qrImg { width:min(100%, 380px); height:auto; image-rendering:pixelated; background:#fff; border-radius:6px; display:block; margin:0 auto; }
  .code { font:600 32px/1.2 ui-monospace,Consolas,monospace; letter-spacing:.12em; padding:8px 14px; border:1px dashed var(--line); border-radius:10px; display:inline-block; }
  .draft { border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:8px; }
  .list { list-style:none; margin:0; padding:0; }
  .list li { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-top:1px solid var(--line); }
  .list li:first-child { border-top:0; }
  .list .grow { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .check { display:flex; gap:8px; padding:6px 0; border-top:1px solid var(--line); }
  .check:first-child { border-top:0; }
  .fix { color:var(--mute); font-size:12px; }
  #logs { max-height:300px; overflow:auto; }
  .lg-warn { color:var(--warn); } .lg-error { color:var(--bad); } .lg-event { color:var(--link); } .lg-draft { color:#9e77ed; }
  .tabs { display:flex; gap:6px; margin-bottom:8px; }
  .tabs button.active { background:var(--soft); border-color:var(--mute); font-weight:600; }
  details summary { cursor:pointer; color:var(--mute); font-size:12px; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <h1>Whatchalant <small>local WhatsApp assistant</small></h1>
  <span class="pill"><span id="dot" class="dot"></span><span id="conn">Starting</span></span>
  <span id="me" class="muted"></span>
  <span id="llmPill" class="pill"></span>
</header>
<main>

  <section class="card wide" id="linkCard">
    <h2>Link your WhatsApp</h2>
    <div class="row" style="align-items:flex-start; gap:24px">
      <div style="flex:1 1 300px" id="qrBox"><p class="muted">Waiting for WhatsApp…</p></div>
      <div style="flex:1 1 280px" class="stack">
        <p style="margin:0">On your phone: <b>WhatsApp → Settings → Linked devices → Link a device</b>, then scan the code. It refreshes every ~20s.</p>
        <p class="muted" style="margin:0">Camera won't read it? Link with a code instead:</p>
        <form id="pairForm" class="row nowrap"><input id="pairNum" placeholder="Your number with country code, e.g. 919876543210" inputmode="numeric"><button class="primary">Get code</button></form>
        <div id="pairCode"></div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Switches</h2>
    <div id="toggles"></div>
  </section>

  <section class="card">
    <h2>Model <button class="mini" id="refreshModels" type="button">List models</button></h2>
    <div class="stack">
      <div><label for="provider">Provider</label>
        <select id="provider"><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option><option value="custom">Custom (your endpoint or .gguf)</option></select></div>
      <div><label for="modelSel">Model</label>
        <div class="row nowrap"><select id="modelSel"><option value="">Click "List models"</option></select><button id="useModel" type="button" class="primary">Use</button></div></div>
      <div><label for="connectIn">Or connect your own: URL, .gguf file, or a folder of models</label>
        <form id="connectForm" class="row nowrap"><input id="connectIn" placeholder="http://127.0.0.1:9000/v1   or   D:\models"><button>Connect</button></form></div>
    </div>
    <div id="modelOut" class="out"></div>
  </section>

  <section class="card">
    <h2>Catch me up 🦥</h2>
    <p class="muted small" style="margin-top:0">Your local model summarises everything people sent while you were away. Nothing leaves this computer.</p>
    <div class="row"><button id="catchBtn" class="primary" type="button">Catch me up now</button><button id="catchSendBtn" type="button">…and send it to my WhatsApp</button></div>
    <div id="catchOut" class="out"></div>
    <form id="digestForm" class="row nowrap" style="margin-top:12px"><label style="margin:0; white-space:nowrap">Daily digest at</label><input id="digestTime" type="time" value="08:00" style="width:auto"><button>Schedule</button></form>
  </section>

  <section class="card">
    <h2>Drafts awaiting approval <span id="draftCount" class="muted"></span></h2>
    <div id="drafts"><p class="muted">None. With AI auto-reply and Draft mode on, replies appear here first.</p></div>
  </section>

  <section class="card">
    <h2>Send a message</h2>
    <form id="sendForm" class="stack">
      <div><label for="sendTo">To (number with country code, or pick a recent chat)</label><input id="sendTo" list="chatList" placeholder="919876543210" autocomplete="off"></div>
      <div><label for="sendText">Message</label><textarea id="sendText" placeholder="Typed messages go through the anti-ban queue (reading pause + typing…)"></textarea></div>
      <div class="row"><button class="primary">Send</button>
        <span class="muted small">or</span>
        <button type="button" id="dictateBtn">🎙 Dictate</button>
        <select id="dictateSecs" style="width:auto"><option value="5">5s</option><option value="8" selected>8s</option><option value="15">15s</option><option value="30">30s</option></select></div>
    </form>
    <div id="sendOut" class="out"></div>
  </section>

  <section class="card">
    <h2>Schedule</h2>
    <div class="tabs"><button type="button" class="active" data-mode="once">Once</button><button type="button" data-mode="repeat">Repeating</button></div>
    <form id="schedForm" class="stack">
      <div><label for="schedTo">To</label><input id="schedTo" list="chatList" placeholder="919876543210 or recent chat" autocomplete="off"></div>
      <div id="onceBox"><label for="schedAt">When</label><input id="schedAt" type="datetime-local"></div>
      <div id="repeatBox" class="hidden">
        <label for="schedPreset">Repeat</label>
        <div class="row nowrap"><select id="schedPreset"><option value="daily">Every day at</option><option value="weekdays">Weekdays at</option><option value="weekly">Every Monday at</option><option value="custom">Custom cron…</option></select><input id="schedTime" type="time" value="09:00" style="width:auto"></div>
        <input id="schedCron" class="hidden mono" placeholder="min hour day month weekday, e.g. 0 9 * * 1-5" style="margin-top:6px">
      </div>
      <div><label for="schedText">Message</label><textarea id="schedText"></textarea></div>
      <button class="primary">Schedule</button>
    </form>
    <div id="schedOut" class="out"></div>
    <ul id="jobs" class="list" style="margin-top:10px"></ul>
  </section>

  <section class="card">
    <h2>Who may get AI replies</h2>
    <p class="muted small" style="margin-top:0">Direct chats need to be on this list. In groups the AI only answers when you're @mentioned (and, if this list isn't empty, the group or sender is on it).</p>
    <ul id="whitelist" class="list"></ul>
    <form id="wlForm" class="row nowrap" style="margin-top:8px"><input id="wlIn" list="chatList" placeholder="Number or chat to allow"><button>Allow</button></form>
    <h2 style="margin-top:16px">Recent chats</h2>
    <ul id="chats" class="list"></ul>
  </section>

  <section class="card">
    <h2>Health check <button class="mini" id="doctorBtn" type="button">Run again</button></h2>
    <div id="doctor"><p class="muted">Checking…</p></div>
  </section>

  <section class="card wide">
    <h2>Activity</h2>
    <pre id="logs"></pre>
    <details style="margin-top:10px"><summary>Advanced: type a command (:help lists them all)</summary>
      <form id="cmdForm" class="row nowrap" style="margin-top:8px"><input id="cmd" class="mono" placeholder=":help" autocomplete="off"><button>Run</button></form>
      <div id="out" class="out mono"></div>
    </details>
  </section>
</main>
<datalist id="chatList"></datalist>

<script>
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); };
var state = null, lastQr = null, editing = new Set(), numFilled = false, lastDrafts = [];

function show(id, text) { var el = $(id); el.textContent = text || ''; el.classList.toggle('err', /^error:/.test(text || '')); }

async function command(c, outId, btn) {
  if (btn) btn.disabled = true;
  try {
    var r = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Whatchalant': '1' }, body: JSON.stringify({ command: c }) });
    var j = await r.json();
    show(outId || 'out', j.output);
    refresh();
    return j.output;
  } catch (e) {
    show(outId || 'out', 'error: the app is not running (start it with npm run dev)');
  } finally { if (btn) btn.disabled = false; }
}
function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

// ── Linking ──
$('pairForm').onsubmit = function (e) { e.preventDefault(); command(':pair ' + $('pairNum').value.replace(/\D/g, ''), 'out', e.submitter); };

// ── Model ──
async function loadModels() {
  $('modelSel').innerHTML = '<option>Loading…</option>';
  try {
    var r = await (await fetch('/api/models')).json();
    if (r.error) { $('modelSel').innerHTML = '<option value="">No models</option>'; show('modelOut', 'error: ' + r.error); return; }
    $('modelSel').innerHTML = r.models.length ? r.models.map(function (m) {
      var name = m.id.split(/[\\/]/).pop();
      return '<option value="' + esc(m.id) + '"' + (state && (m.id === state.llm.model || name.replace(/\.gguf$/i, '') === state.llm.model) ? ' selected' : '') + '>' + esc(name) + (m.detail ? '  (' + esc(m.detail) + ')' : '') + '</option>';
    }).join('') : '<option value="">No models found</option>';
    show('modelOut', r.models.length ? '' : (r.hint || 'No models found for this provider.'));
  } catch (e) { show('modelOut', 'error: could not list models'); }
}
$('refreshModels').onclick = loadModels;
$('provider').onchange = async function () { await command(':provider ' + $('provider').value, 'modelOut'); loadModels(); };
$('useModel').onclick = function (e) {
  var v = $('modelSel').value; if (!v) return;
  if (/\.gguf$/i.test(v)) show('modelOut', 'Loading the model with llama-server… this can take up to a minute.');
  command(':model ' + v, 'modelOut', e.target);
};
$('connectForm').onsubmit = async function (e) {
  e.preventDefault(); var v = $('connectIn').value.trim(); if (!v) return;
  if (/\.gguf$/i.test(v)) show('modelOut', 'Loading the model with llama-server… this can take up to a minute.');
  var out = await command(':connect ' + v, 'modelOut', e.submitter);
  if (/found \d+ \.gguf/.test(out || '')) {
    var lines = out.split('\n').slice(1);
    $('modelSel').innerHTML = lines.map(function (l) { var m = l.match(/^\s*\d+\.\s+(.*?)\s+\((gguf[^)]*)\)\s*$/); return m ? '<option value="' + esc(m[1]) + '">' + esc(m[1].split(/[\\/]/).pop()) + '  (' + esc(m[2]) + ')</option>' : ''; }).join('');
    show('modelOut', 'Found ' + lines.length + ' model file(s). Pick one above and click Use.');
  }
};

// ── Catch me up ──
$('catchBtn').onclick = function (e) { show('catchOut', 'Reading your chats…'); command(':catchup', 'catchOut', e.target); };
$('catchSendBtn').onclick = function (e) { show('catchOut', 'Reading your chats…'); command(':catchup send', 'catchOut', e.target); };
$('digestForm').onsubmit = function (e) { e.preventDefault(); command(':digest ' + $('digestTime').value, 'catchOut', e.submitter); };

// ── Send / dictate ──
$('sendForm').onsubmit = async function (e) {
  e.preventDefault(); var to = $('sendTo').value.trim(), text = oneLine($('sendText').value);
  if (!to || !text) return show('sendOut', 'error: fill in who to send to and the message');
  var out = await command(':send ' + to + ' ' + text, 'sendOut', e.submitter);
  if (/^queued/.test(out || '')) $('sendText').value = '';
};
$('dictateBtn').onclick = function (e) {
  var to = $('sendTo').value.trim(); if (!to) return show('sendOut', 'error: fill in who the message is for first');
  show('sendOut', '🎙 Recording for ' + $('dictateSecs').value + 's, speak now… then transcribing (can take ~30s).');
  command(':dictate ' + to + ' ' + $('dictateSecs').value, 'sendOut', e.target);
};

// ── Schedule ──
var schedMode = 'once';
document.querySelectorAll('.tabs button').forEach(function (b) {
  b.onclick = function () {
    schedMode = b.dataset.mode;
    document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('active', x === b); });
    $('onceBox').classList.toggle('hidden', schedMode !== 'once');
    $('repeatBox').classList.toggle('hidden', schedMode !== 'repeat');
  };
});
$('schedPreset').onchange = function () { var c = $('schedPreset').value === 'custom'; $('schedCron').classList.toggle('hidden', !c); $('schedTime').classList.toggle('hidden', c); };
(function () { var d = new Date(Date.now() + 15 * 60000); d.setSeconds(0, 0); $('schedAt').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); })();
$('schedForm').onsubmit = function (e) {
  e.preventDefault(); var to = $('schedTo').value.trim(), text = oneLine($('schedText').value);
  if (!to || !text) return show('schedOut', 'error: fill in who to send to and the message');
  if (schedMode === 'once') {
    if (!$('schedAt').value) return show('schedOut', 'error: pick a date and time');
    return command(':at ' + to + ' ' + $('schedAt').value + ' ' + text, 'schedOut', e.submitter);
  }
  var p = $('schedPreset').value, t = ($('schedTime').value || '09:00').split(':'), mm = Number(t[1]), hh = Number(t[0]);
  var expr = p === 'custom' ? $('schedCron').value.trim() : p === 'daily' ? mm + ' ' + hh + ' * * *' : p === 'weekdays' ? mm + ' ' + hh + ' * * 1-5' : mm + ' ' + hh + ' * * 1';
  command(':schedule ' + to + ' "' + expr + '" ' + text, 'schedOut', e.submitter);
};

// ── Whitelist ──
$('wlForm').onsubmit = function (e) { e.preventDefault(); var v = $('wlIn').value.trim(); if (v) { command(':whitelist add ' + v, 'out'); $('wlIn').value = ''; } };

// ── Health ──
async function doctor() {
  $('doctor').innerHTML = '<p class="muted">Checking…</p>';
  try {
    var r = await (await fetch('/api/doctor')).json();
    $('doctor').innerHTML = r.map(function (c) {
      return '<div class="check"><span>' + (c.ok ? '✅' : c.optional ? '⚠️' : '❌') + '</span><div><b>' + esc(c.name) + '</b> <span class="muted">' + esc(c.detail) + '</span>' + (c.fix ? '<div class="fix">→ ' + esc(c.fix) + '</div>' : '') + '</div></div>';
    }).join('');
  } catch (e) { $('doctor').innerHTML = '<p class="muted">The app is not running.</p>'; }
}
$('doctorBtn').onclick = doctor;

// ── Advanced ──
$('cmdForm').onsubmit = function (e) { e.preventDefault(); var c = $('cmd').value.trim(); if (c) command(c, 'out'); $('cmd').value = ''; };

var TOGGLES = [
  ['ai', 'AI auto-reply', 'Let your local model answer whitelisted chats and @mentions.'],
  ['draft', 'Draft mode', 'Ask before sending: replies wait in “Drafts” for your OK.'],
  ['voice', 'Voice alerts', 'Read @mentions aloud (ElevenLabs, or your computer’s voice).'],
  ['selftest', 'Self-chat test', 'Treat what you type in “Message yourself” as incoming, for testing with one phone.']
];

function render(s) {
  state = s;
  var connected = s.connection === 'Connected';
  $('conn').textContent = s.connection;
  $('dot').className = 'dot ' + (connected ? 'ok' : s.connection === 'Logged Out' ? 'bad' : '');
  $('me').textContent = s.me ? (s.me.name || '') + ' · +' + s.me.number : '';
  $('llmPill').textContent = '🧠 ' + s.llm.provider + ' / ' + s.llm.model;
  if ($('provider').value !== s.llm.provider && document.activeElement !== $('provider')) $('provider').value = s.llm.provider;

  $('linkCard').classList.toggle('hidden', connected);
  if (s.qrPng && s.qrPng !== lastQr) $('qrBox').innerHTML = '<img id="qrImg" alt="WhatsApp QR code" src="' + s.qrPng + '">';
  else if (!s.qrPng) $('qrBox').innerHTML = '<p class="muted">Waiting for a QR code… (' + esc(s.connection) + ')</p>';
  lastQr = s.qrPng;
  if (!numFilled && s.myNumber) { $('pairNum').value = s.myNumber; numFilled = true; }
  $('pairCode').innerHTML = s.pairingCode && !connected ? '<div class="code">' + esc(s.pairingCode) + '</div><p class="muted small">Linked devices → Link a device → <b>Link with phone number instead</b> → type this code.</p>' : '';

  $('toggles').innerHTML = TOGGLES.map(function (t) {
    return '<div class="toggle"><div><b>' + t[1] + '</b><div class="muted small">' + t[2] + '</div></div><button class="switch' + (s.toggles[t[0]] ? ' on' : '') + '" data-t="' + t[0] + '" aria-pressed="' + s.toggles[t[0]] + '" aria-label="' + t[1] + '"></button></div>';
  }).join('') + '<p class="muted small" style="margin:8px 0 0">Queue: ' + s.queue + ' waiting to send</p>';
  $('toggles').querySelectorAll('.switch').forEach(function (b) { b.onclick = function () { command(':toggle ' + b.dataset.t, 'out'); }; });

  lastDrafts = s.drafts;
  $('draftCount').textContent = s.drafts.length ? s.drafts.length + ' waiting' : '';
  if (!editing.size) {
    $('drafts').innerHTML = s.drafts.length ? s.drafts.map(function (d) {
      return '<div class="draft"><div class="muted small">#' + d.id + ' → ' + esc(d.label) + (d.source === 'dictation' ? ' · dictated' : '') + '</div>' +
        (d.incoming ? '<div class="small">“' + esc(d.incoming) + '”</div>' : '') +
        '<textarea data-id="' + d.id + '" style="margin-top:6px">' + esc(d.text) + '</textarea>' +
        '<div class="row" style="margin-top:6px"><button class="primary" data-a="send" data-id="' + d.id + '">Send</button><button class="danger" data-a="reject" data-id="' + d.id + '">Discard</button></div></div>';
    }).join('') : '<p class="muted">None. With AI auto-reply and Draft mode on, replies appear here first.</p>';
    $('drafts').querySelectorAll('textarea').forEach(function (ta) { ta.onfocus = function () { editing.add(ta.dataset.id); }; ta.onblur = function () { setTimeout(function () { editing.delete(ta.dataset.id); }, 300); }; });
    $('drafts').querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.id; editing.delete(id);
        if (b.dataset.a === 'reject') return command(':reject ' + id, 'out');
        var text = oneLine($('drafts').querySelector('textarea[data-id="' + id + '"]').value);
        var orig = (lastDrafts.find(function (d) { return String(d.id) === id; }) || {}).text;
        command(text === orig ? ':approve ' + id : ':edit ' + id + ' ' + text, 'out');
      };
    });
  }

  $('chatList').innerHTML = s.chats.map(function (c) { return '<option value="' + esc(c.jid) + '">' + esc(c.name) + '</option>'; }).join('');
  var wl = new Set(s.whitelist);
  $('chats').innerHTML = s.chats.length ? s.chats.map(function (c) {
    var allowed = wl.has(c.jid.split('@')[0].split(':')[0]);
    return '<li><span class="grow">' + (c.isGroup ? '👥 ' : '👤 ') + esc(c.name) + ' <span class="muted small mono">' + esc(c.jid) + '</span></span>' +
      (allowed ? '<span class="muted small">allowed</span>' : '<button class="mini" data-wl="' + esc(c.jid) + '">Allow AI</button>') + '</li>';
  }).join('') : '<li class="muted">Chats show up here as messages arrive.</li>';
  $('chats').querySelectorAll('button[data-wl]').forEach(function (b) { b.onclick = function () { command(':whitelist add ' + b.dataset.wl, 'out'); }; });
  $('whitelist').innerHTML = s.whitelist.length ? s.whitelist.map(function (w) {
    var c = s.chats.find(function (x) { return x.jid.split('@')[0].split(':')[0] === w; });
    return '<li><span class="grow">' + esc(c ? c.name + ' · ' : '') + '<span class="mono small">' + esc(w) + '</span></span><button class="mini danger" data-rm="' + esc(w) + '">Remove</button></li>';
  }).join('') : '<li class="muted">Nobody yet: AI only answers @mentions in groups.</li>';
  $('whitelist').querySelectorAll('button[data-rm]').forEach(function (b) { b.onclick = function () { command(':whitelist remove ' + b.dataset.rm, 'out'); }; });

  $('jobs').innerHTML = s.jobs.map(function (j) {
    var when = j.kind === 'once' ? new Date(j.when).toLocaleString() : j.when;
    var what = j.kind === 'digest' ? '🦥 Catch-up digest to you' : '→ ' + esc(j.jid) + ': ' + esc(j.message);
    return '<li><span class="grow small"><b>' + esc(when) + '</b> ' + what + '</span><button class="mini danger" data-cancel="' + j.id + '">Cancel</button></li>';
  }).join('');
  $('jobs').querySelectorAll('button[data-cancel]').forEach(function (b) { b.onclick = function () { command(':cancel ' + b.dataset.cancel, 'schedOut'); }; });

  var logs = $('logs'), atBottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 30;
  logs.innerHTML = s.logs.map(function (l) { return '<span class="lg-' + l.level + '">' + new Date(l.ts).toLocaleTimeString() + '  ' + esc(l.msg) + '</span>'; }).join('\n');
  if (atBottom) logs.scrollTop = logs.scrollHeight;
}

async function refresh() {
  try { render(await (await fetch('/api/state')).json()); }
  catch (e) { $('conn').textContent = 'App not running'; $('dot').className = 'dot bad'; }
}
refresh().then(function () { loadModels(); doctor(); });
setInterval(refresh, 2000);
</script>
</body>
</html>`;
