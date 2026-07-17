/**
 * The demo UI: a mini "CRM copilot" app — the shape a real product built on
 * this pipeline would take. Left: contacts served from Nango's records cache,
 * updating live. Right: what the AI assistant did about each change.
 *
 * Single self-contained page: SSE + vanilla JS, no build step, no deps.
 */
export const DEMO_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Contact Copilot</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #f6f7f9; color: #1a2233; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  a { color: #4f46e5; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { background: #fff; border-bottom: 1px solid #e6e8ee; padding: 14px 28px; display: flex; align-items: center; gap: 14px; }
  .logo { width: 30px; height: 30px; border-radius: 8px; background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 15px; }
  header h1 { font-size: 16px; font-weight: 650; }
  header .sub { color: #68718a; font-size: 12.5px; }
  .status { margin-left: auto; display: flex; align-items: center; gap: 8px; color: #68718a; font-size: 12.5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
  .dot.off { background: #d1d5db; }
  button.primary { background: #4f46e5; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font: inherit; font-weight: 550; cursor: pointer; }
  button.primary:hover { background: #4338ca; }
  button.primary:disabled { opacity: .55; cursor: wait; }

  main { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr); gap: 20px; padding: 20px 28px; max-width: 1280px; margin: 0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1px solid #e6e8ee; border-radius: 12px; overflow: hidden; }
  .card > h2 { font-size: 13px; font-weight: 650; color: #68718a; text-transform: uppercase; letter-spacing: .4px; padding: 14px 18px 10px; }
  .card > .desc { color: #8a93a8; font-size: 12.5px; padding: 0 18px 12px; border-bottom: 1px solid #eef0f4; }

  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11.5px; color: #8a93a8; text-transform: uppercase; letter-spacing: .4px; padding: 10px 18px; border-bottom: 1px solid #eef0f4; }
  td { padding: 11px 18px; border-bottom: 1px solid #f2f4f7; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .cname { font-weight: 570; }
  .cmail { color: #68718a; font-size: 12.5px; }
  .when { color: #8a93a8; font-size: 12px; white-space: nowrap; }
  tr.flash > td { animation: flash 2.4s ease-out; }
  @keyframes flash { 0% { background: #eef2ff; } 100% { background: transparent; } }

  #activity { display: flex; flex-direction: column; }
  #cards { padding: 8px 14px 16px; display: flex; flex-direction: column; gap: 10px; max-height: 70vh; overflow-y: auto; }
  .act { border: 1px solid #e6e8ee; border-radius: 10px; padding: 12px 14px; }
  .act .head { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: #68718a; }
  .act .head b { color: #1a2233; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #eef2ff; color: #4f46e5; font-weight: 600; }
  .badge.working { background: #fef3c7; color: #b45309; }
  .badge.info { background: #f1f5f9; color: #64748b; }
  .act .task { margin-top: 8px; background: #f8fafc; border: 1px solid #eef0f4; border-radius: 8px; padding: 9px 12px; }
  .act .task .subject { font-weight: 570; font-size: 13.5px; }
  .act .task .meta { color: #8a93a8; font-size: 12px; margin-top: 2px; }
  .act .why { margin-top: 8px; color: #3f4a63; font-size: 13px; }
  .act .when { display: block; margin-top: 8px; }
  .spinner { width: 12px; height: 12px; border: 2px solid #f59e0b44; border-top-color: #b45309; border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: #8a93a8; text-align: center; padding: 28px 16px; font-size: 13px; }
</style>
</head>
<body>
<header>
  <div class="logo">C</div>
  <div>
    <h1>Contact Copilot</h1>
    <div class="sub">Your AI assistant, watching Salesforce so you don't have to</div>
  </div>
  <div class="status"><span class="dot" id="dot"></span><span id="statustext">connecting…</span></div>
  <button class="primary" id="simulate" onclick="simulate()">Simulate a change in Salesforce</button>
</header>

<main>
  <section class="card">
    <h2>Contacts</h2>
    <div class="desc">Live from your Salesforce org — rows update seconds after a record changes.</div>
    <table>
      <thead><tr><th>Contact</th><th>Title</th><th>Phone</th><th>Updated</th></tr></thead>
      <tbody id="rows"><tr><td colspan="4" class="empty">Loading contacts…</td></tr></tbody>
    </table>
  </section>

  <section class="card" id="activity">
    <h2>Assistant activity</h2>
    <div class="desc">What the AI did about each change, with links to the work.</div>
    <div id="cards"><div class="empty">No activity yet. Change a contact in Salesforce or press the button above.</div></div>
  </section>
</main>

<script>
  const rows = document.getElementById('rows');
  const cards = document.getElementById('cards');
  let lastSeen = {};   // contactId -> updatedAt, to flash changed rows
  let pending = {};    // contactId -> placeholder card element

  const rel = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  };
  const esc = (t) => (t ?? '').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function loadContacts(flash) {
    const res = await fetch('/api/contacts');
    const { contacts } = await res.json();
    rows.innerHTML = contacts.map(c => {
      const changed = flash && lastSeen[c.id] && lastSeen[c.id] !== c.updatedAt;
      lastSeen[c.id] = c.updatedAt;
      return '<tr class="' + (changed ? 'flash' : '') + '">' +
        '<td><div class="cname">' + esc(c.name) + '</div><div class="cmail">' + esc(c.email || '') + '</div></td>' +
        '<td>' + esc(c.title || '—') + '</td>' +
        '<td>' + esc(c.phone || '—') + '</td>' +
        '<td class="when">' + rel(c.updatedAt) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">No contacts synced yet.</td></tr>';
  }

  function addCard(html) {
    cards.querySelector('.empty')?.remove();
    const el = document.createElement('div');
    el.className = 'act';
    el.innerHTML = html;
    cards.prepend(el);
    return el;
  }

  function onEvent(e) {
    if (e.kind === 'contacts-updated') { loadContacts(true); return; }
    if (e.kind === 'info') {
      addCard('<div class="head"><span class="badge info">Salesforce</span> ' + esc(e.text) + '</div>');
      return;
    }
    if (e.kind === 'change-detected') {
      addCard('<div class="head"><span class="badge">Change detected</span> ' +
        e.count + ' record' + (e.count > 1 ? 's' : '') + ' changed in Salesforce</div>');
      return;
    }
    if (e.kind === 'agent-start') {
      pending[e.contactId] = addCard(
        '<div class="head"><span class="spinner"></span><span class="badge working">Working</span> ' +
        'Assistant is looking at <b>' + esc(e.contact) + '</b>…</div>');
      return;
    }
    if (e.kind === 'agent-activity') {
      const card = pending[e.contactId];
      delete pending[e.contactId];
      const html =
        '<div class="head"><span class="badge">Done</span> <b>' + esc(e.contact) + '</b> was ' + (e.action === 'ADDED' ? 'created' : 'updated') + '</div>' +
        (e.task
          ? '<div class="task"><div class="subject">📋 ' + esc(e.task.subject) + '</div>' +
            '<div class="meta">' + esc(e.task.priority) + ' priority · Task in Salesforce' +
            (e.task.url ? ' · <a href="' + esc(e.task.url) + '" target="_blank">Open ↗</a>' : '') + '</div></div>'
          : '') +
        '<div class="why">' + esc(e.summary) + '</div>' +
        '<span class="when">' + new Date(e.at).toLocaleTimeString() + '</span>';
      if (card) { card.innerHTML = html; } else { addCard(html); }
      return;
    }
  }

  const es = new EventSource('/events');
  es.onopen = () => { document.getElementById('dot').classList.remove('off'); document.getElementById('statustext').textContent = 'Connected to Salesforce · live'; };
  es.onerror = () => { document.getElementById('dot').classList.add('off'); document.getElementById('statustext').textContent = 'reconnecting…'; };
  es.onmessage = (m) => onEvent(JSON.parse(m.data));

  async function simulate() {
    const btn = document.getElementById('simulate');
    btn.disabled = true;
    btn.textContent = 'Changing a contact…';
    try { await fetch('/demo/simulate', { method: 'POST' }); }
    finally { setTimeout(() => { btn.disabled = false; btn.textContent = 'Simulate a change in Salesforce'; }, 5000); }
  }

  loadContacts(false);
  setInterval(() => loadContacts(false), 60000);   // keep "updated Xm ago" fresh
</script>
</body>
</html>`;
