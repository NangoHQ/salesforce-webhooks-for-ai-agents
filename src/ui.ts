/**
 * The demo UI: a single self-contained page showing the pipeline reacting in
 * real time. No build step, no dependencies — just SSE + vanilla JS.
 */
export const DEMO_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Salesforce → Nango → AI agent · live feed</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #d6dae3; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 20px 24px 12px; border-bottom: 1px solid #1e2430; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; }
  h1 .dim { color: #6b7385; font-weight: 400; }
  .hint { color: #6b7385; font-size: 12.5px; }
  button { background: #1c2a45; color: #9db8e8; border: 1px solid #2c3e63; border-radius: 6px; padding: 7px 14px; font: inherit; cursor: pointer; }
  button:hover { background: #23345a; }
  button:disabled { opacity: .5; cursor: wait; }
  #feed { padding: 16px 24px 60px; max-width: 980px; }
  .ev { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px dashed #161b26; align-items: baseline; }
  .t { color: #545c6e; flex: 0 0 62px; font-size: 12px; }
  .chip { flex: 0 0 118px; text-align: center; border-radius: 5px; font-size: 11.5px; padding: 2px 0; }
  .sync-webhook   .chip { background: #14263a; color: #6fb3ff; }
  .forward-webhook.chip-row .chip, .forward-webhook .chip { background: #1c2133; color: #8f9bd4; }
  .records-fetched .chip { background: #14263a; color: #6fb3ff; }
  .agent-start    .chip { background: #2a1d3a; color: #c79bff; }
  .tool-call      .chip { background: #322611; color: #ffc266; }
  .tool-result    .chip { background: #322611; color: #d9a751; }
  .agent-done     .chip { background: #2a1d3a; color: #c79bff; }
  .task-created   .chip { background: #11321c; color: #5fd68a; }
  .info           .chip { background: #1e2430; color: #8a93a6; }
  .msg { flex: 1; word-break: break-word; }
  .msg a { color: #5fd68a; }
  .msg .sub { color: #6b7385; }
  .task-created .msg { color: #b9ecc9; }
  .agent-done .msg { color: #dcc9f5; font-style: italic; }
  #empty { color: #545c6e; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Salesforce → Nango → AI agent <span class="dim">· live feed</span></h1>
    <div class="hint">Edit a contact in Salesforce (name, email, title, or phone) — or press the button — and watch the pipeline react.</div>
  </div>
  <button id="simulate" onclick="simulate()">⚡ Simulate a contact change</button>
</header>
<div id="feed"><div id="empty">Waiting for events…</div></div>
<script>
  const feed = document.getElementById('feed');
  const fmt = {
    'sync-webhook':   e => 'sync webhook · +' + e.added + ' ~' + e.updated + ' -' + e.deleted,
    'forward-webhook':e => 'raw Salesforce event forwarded (' + (e.eventType || 'unknown') + ')',
    'records-fetched':e => e.count + ' changed record(s) fetched by cursor',
    'agent-start':    e => 'agent waking up: ' + e.contact + ' was ' + e.action,
    'tool-call':      e => e.tool + '(' + (e.summary || '') + ')',
    'tool-result':    e => (e.ok ? 'ok' : 'error') + ' · ' + (e.summary || ''),
    'agent-done':     e => '“' + e.text + '”',
    'task-created':   e => 'Task created in Salesforce' + (e.subject ? ': ' + e.subject : ''),
    'info':           e => e.text || ''
  };
  const chips = {
    'sync-webhook': 'NANGO', 'forward-webhook': 'FORWARD', 'records-fetched': 'RECORDS',
    'agent-start': 'AGENT', 'tool-call': 'TOOL CALL', 'tool-result': 'RESULT',
    'agent-done': 'AGENT', 'task-created': 'TASK ✓', 'info': 'INFO'
  };
  new EventSource('/events').onmessage = (m) => {
    const e = JSON.parse(m.data);
    document.getElementById('empty')?.remove();
    const row = document.createElement('div');
    row.className = 'ev ' + e.kind;
    const link = e.url ? ' <a href="' + e.url + '" target="_blank">open in Salesforce ↗</a>' : '';
    row.innerHTML =
      '<span class="t">' + new Date(e.at).toLocaleTimeString() + '</span>' +
      '<span class="chip">' + (chips[e.kind] || e.kind) + '</span>' +
      '<span class="msg">' + (fmt[e.kind] ? fmt[e.kind](e) : JSON.stringify(e)) + link + '</span>';
    feed.appendChild(row);
    window.scrollTo(0, document.body.scrollHeight);
  };
  async function simulate() {
    const btn = document.getElementById('simulate');
    btn.disabled = true;
    try { await fetch('/demo/simulate', { method: 'POST' }); }
    finally { setTimeout(() => { btn.disabled = false; }, 4000); }
  }
</script>
</body>
</html>`;
