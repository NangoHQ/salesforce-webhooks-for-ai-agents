/**
 * The demo UI: a chat interface with the CRM agent. Salesforce events stream
 * into the conversation as notices, the agent's event-driven runs appear as
 * assistant messages, and you can talk to the same agent (it can query
 * Salesforce and create tasks through the same tools).
 *
 * Single self-contained page: SSE + vanilla JS, no build step, no deps.
 */
export const DEMO_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Agent - Salesforce Webhooks demo</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { background: #f6f7f9; color: #1a2233; font: 14.5px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
  a { color: #4f46e5; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { background: #fff; border-bottom: 1px solid #e6e8ee; padding: 13px 22px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 15px; }
  header h1 { font-size: 15.5px; font-weight: 650; }
  header .sub { color: #68718a; font-size: 12px; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 7px; color: #68718a; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  .dot.off { background: #d1d5db; }

  #scroll { flex: 1; overflow-y: auto; }
  #feed { width: 100%; padding: 22px 24px 12px; display: flex; flex-direction: column; gap: 12px; }

  .notice { align-self: center; display: flex; gap: 7px; align-items: center; background: #eef1f6; border: 1px solid #e2e6ef; color: #5b6478; font-size: 12.5px; border-radius: 999px; padding: 4px 14px; max-width: 92%; }
  .notice.sf { background: #eaf3fb; border-color: #d5e7f7; color: #21618f; }
  .notice .zap { font-size: 12px; }

  .msg { max-width: 82%; border-radius: 14px; padding: 10px 14px; position: relative; }
  .msg.user { align-self: flex-end; background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
  .msg.agent { align-self: flex-start; background: #fff; border: 1px solid #e6e8ee; border-bottom-left-radius: 4px; }
  .msg .who { font-size: 11px; font-weight: 650; color: #8a93a8; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 3px; }
  .msg.agent .body { color: #26304a; white-space: pre-wrap; }
  .msg .eventline { font-size: 12.5px; color: #68718a; margin-bottom: 5px; }
  .msg .eventline b { color: #1a2233; }
  .msg .task { margin-top: 9px; background: #f8fafc; border: 1px solid #eef0f4; border-radius: 9px; padding: 9px 12px; }
  .msg .task .subject { font-weight: 590; font-size: 13.5px; }
  .msg .task .meta { color: #8a93a8; font-size: 12px; margin-top: 2px; }
  .msg .when { display: block; font-size: 11px; color: #a2aabb; margin-top: 6px; }
  .working { display: flex; gap: 8px; align-items: center; color: #8a93a8; font-size: 13px; }
  .spinner { width: 12px; height: 12px; border: 2px solid #c7cbe0; border-top-color: #4f46e5; border-radius: 50%; animation: spin .9s linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }

  footer { flex-shrink: 0; background: linear-gradient(to top, #f6f7f9 70%, transparent); padding: 10px 18px 18px; }
  .inputrow { display: flex; gap: 10px; background: #fff; border: 1px solid #dfe3ec; border-radius: 14px; padding: 8px 8px 8px 16px; box-shadow: 0 2px 10px rgba(20, 30, 60, .06); }
  .inputrow:focus-within { border-color: #b5b9f5; }
  #box { flex: 1; border: 0; outline: 0; font: inherit; background: transparent; color: #1a2233; }
  #send { background: #4f46e5; color: #fff; border: 0; border-radius: 9px; padding: 8px 16px; font: inherit; font-weight: 570; cursor: pointer; }
  #send:hover { background: #4338ca; }
  #send:disabled { opacity: .5; cursor: wait; }
  .hint { margin: 6px 0 0; color: #a2aabb; font-size: 11.5px; text-align: center; }
</style>
</head>
<body>
<header>
  <div class="logo">A</div>
  <div>
    <h1>AI Agent — Salesforce Webhooks demo</h1>
    <div class="sub">Connected to your Salesforce org · reacts to changes in real time</div>
  </div>
  <div class="status"><span class="dot" id="dot"></span><span id="statustext">connecting…</span></div>
</header>

<div id="scroll"><div id="feed">
  <div class="msg agent">
    <div class="who">AI Agent</div>
    <div class="body">I'm watching your Salesforce org. When a contact, lead, account, or opportunity changes, I'll pick it up here within seconds and act on it. You can also just talk to me — try "how many open opportunities do we have?" or edit a record in Salesforce and watch.</div>
  </div>
</div></div>

<footer>
  <div class="inputrow">
    <input id="box" placeholder="Message the agent…" autocomplete="off" />
    <button id="send" onclick="send()">Send</button>
  </div>
  <div class="hint">Events from Salesforce and your conversation share this feed — that's the point.</div>
</footer>

<script>
  const feed = document.getElementById('feed');
  const scroller = document.getElementById('scroll');
  const box = document.getElementById('box');
  const sendBtn = document.getElementById('send');
  let pendingEvent = {};   // contactId -> element (event-driven runs)
  let pendingChat = null;  // element (chat turn in flight)

  const esc = (t) => (t ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  // Minimal markdown for agent replies: **bold** and \`code\` only.
  const md = (t) => esc(t).replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  const stamp = (iso) => new Date(iso).toLocaleTimeString();
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };

  function add(el) { feed.appendChild(el); scrollDown(); return el; }
  function div(cls, html) { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; return el; }

  function taskCard(task) {
    if (!task) return '';
    return '<div class="task"><div class="subject">📋 ' + esc(task.subject) + '</div>' +
      '<div class="meta">' + esc(task.priority) + ' priority · Task created in Salesforce' +
      (task.url ? ' · <a href="' + esc(task.url) + '" target="_blank">Open ↗</a>' : '') + '</div></div>';
  }

  function onEvent(e) {
    switch (e.kind) {
      case 'change-detected': {
        const what = e.count === 1 ? ('A ' + e.object) : (e.count + ' ' + e.object + 's');
        add(div('notice sf', '<span class="zap">⚡</span> ' + esc(what) + ' changed in Salesforce · ' + stamp(e.at)));
        return;
      }
      case 'info':
        add(div('notice', esc(e.text)));
        return;
      case 'agent-start':
        pendingEvent[e.contactId] = add(div('msg agent',
          '<div class="who">AI Agent</div>' +
          '<div class="eventline">' + esc(e.object) + ' <b>' + esc(e.contact) + '</b> was ' + (e.action === 'ADDED' ? 'created' : 'updated') + '</div>' +
          '<div class="working"><span class="spinner"></span> Looking at the change…</div>'));
        return;
      case 'agent-activity': {
        const html =
          '<div class="who">AI Agent</div>' +
          '<div class="eventline">' + esc(e.object || 'Record') + ' <b>' + esc(e.contact) + '</b> was ' + (e.action === 'ADDED' ? 'created' : 'updated') + '</div>' +
          '<div class="body">' + md(e.summary) + '</div>' +
          taskCard(e.task) +
          '<span class="when">' + stamp(e.at) + '</span>';
        const el = pendingEvent[e.contactId];
        delete pendingEvent[e.contactId];
        if (el) { el.innerHTML = html; scrollDown(); } else { add(div('msg agent', html)); }
        return;
      }
      case 'chat-user':
        add(div('msg user', esc(e.text)));
        pendingChat = add(div('msg agent',
          '<div class="who">AI Agent</div><div class="working"><span class="spinner"></span> <span class="wtext">Thinking…</span></div>'));
        return;
      case 'chat-tool': {
        const label = { query_salesforce: 'Querying Salesforce…', get_salesforce_record: 'Fetching the record…', create_salesforce_task: 'Creating a task in Salesforce…' }[e.tool] || 'Working…';
        pendingChat?.querySelector('.wtext') && (pendingChat.querySelector('.wtext').textContent = label);
        return;
      }
      case 'chat-assistant': {
        const html = '<div class="who">AI Agent</div><div class="body">' + md(e.text) + '</div>' + taskCard(e.task) +
          '<span class="when">' + stamp(e.at) + '</span>';
        if (pendingChat) { pendingChat.innerHTML = html; pendingChat = null; scrollDown(); }
        else { add(div('msg agent', html)); }
        return;
      }
    }
  }

  const es = new EventSource('/events');
  es.onopen = () => { document.getElementById('dot').classList.remove('off'); document.getElementById('statustext').textContent = 'Live'; };
  es.onerror = () => { document.getElementById('dot').classList.add('off'); document.getElementById('statustext').textContent = 'reconnecting…'; };
  es.onmessage = (m) => onEvent(JSON.parse(m.data));

  async function send() {
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    sendBtn.disabled = true;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        add(div('notice', esc(err.error || 'Something went wrong — try again.')));
      }
    } finally {
      sendBtn.disabled = false;
      box.focus();
    }
  }
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !sendBtn.disabled) send(); });
</script>
</body>
</html>`;
