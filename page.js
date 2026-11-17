// The single phone page for approvals and questions. All dynamic values are inserted
// with textContent. This file is a template literal: the inline script avoids backticks
// and template placeholders, and regex backslashes are doubled.

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>DSH</title>
<style>
  :root { --bg:#f5f5f7; --card:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --code:#f2f2f7;
          --allow:#0a7cff; --reject:#e5484d; --ok:#2f9e44; --sel:#e8f1ff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#000; --card:#1c1c1e; --fg:#f5f5f7; --muted:#98989d; --line:#2c2c2e; --code:#2c2c2e;
            --allow:#3b8eff; --reject:#ff5c61; --ok:#40c057; --sel:#13253f; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
         padding:max(20px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); }
  main { max-width:560px; margin:0 auto; }
  h1 { font-size:22px; margin:8px 0 16px; }
  .card { background:var(--card); border-radius:14px; padding:16px; margin-bottom:14px; }
  .label { color:var(--muted); font-size:13px; margin-bottom:2px; }
  .value { margin-bottom:12px; word-break:break-word; }
  .value:last-child { margin-bottom:0; }
  pre { background:var(--code); border-radius:10px; padding:10px 12px; margin:0; font-size:13px;
        white-space:pre-wrap; word-break:break-all; max-height:45vh; overflow:auto;
        font-family: ui-monospace, Menlo, monospace; }
  .q-head { color:var(--muted); font-size:13px; font-weight:600; margin-bottom:4px; }
  .q-text { white-space:pre-wrap; word-break:break-word; margin-bottom:12px; }
  .q-detail { margin-bottom:12px; }
  .opt { display:flex; gap:10px; align-items:flex-start; padding:12px; border:1.5px solid var(--line);
         border-radius:12px; margin-bottom:8px; cursor:pointer; }
  .opt.checked { border-color:var(--allow); background:var(--sel); }
  .opt input { margin:3px 0 0; width:18px; height:18px; flex:none; accent-color:var(--allow); }
  .opt-label { font-weight:600; }
  .opt-desc { color:var(--muted); font-size:14px; margin-top:2px; white-space:pre-wrap; }
  textarea { width:100%; min-height:72px; border-radius:12px; border:1.5px solid var(--line); background:transparent;
             color:var(--fg); font:inherit; padding:10px 12px; resize:vertical; }
  .custom-label { color:var(--muted); font-size:13px; margin:6px 0 4px; }
  button { width:100%; border:0; border-radius:12px; padding:15px; font-size:17px; font-weight:600;
           margin-bottom:10px; cursor:pointer; }
  button:disabled { opacity:.5; }
  #allow, #enroll, #submit { background:var(--allow); color:#fff; }
  #reject { background:transparent; color:var(--reject); border:1.5px solid var(--reject); }
  .status { text-align:center; font-size:18px; font-weight:600; padding:24px 8px; }
  .status.ok { color:var(--ok); } .status.bad { color:var(--reject); }
  .hint { color:var(--muted); font-size:13px; text-align:center; margin-top:6px; }
  .error { color:var(--reject); font-size:14px; text-align:center; min-height:1.5em; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1 id="title">DSH</h1>
  <div class="card" id="details" hidden>
    <div class="label">会话</div><div class="value" id="session"></div>
    <div id="approvalBox">
      <div class="label">工具</div><div class="value" id="tool"></div>
      <div id="reasonBox"><div class="label">原因</div><div class="value" id="reason"></div></div>
      <div id="commandBox"><div class="label">将要执行</div><pre id="command"></pre></div>
    </div>
  </div>
  <div id="questions"></div>
  <div id="actions" hidden>
    <button id="enroll" hidden>首次使用：注册 Face ID</button>
    <button id="allow" hidden>用 Face ID 批准</button>
    <button id="submit" hidden>用 Face ID 提交回答</button>
    <button id="reject" hidden>拒绝</button>
    <div class="error" id="error"></div>
    <div class="hint" id="expiry"></div>
  </div>
  <div class="status" id="status">加载中…</div>
</main>
<script>
(() => {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const api = '/api/a/' + encodeURIComponent(token);
  const $ = id => document.getElementById(id);
  let state = null;
  let busy = false;
  let formBuilt = false;

  const b64u = buf => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const unb64u = str => {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const STATUS_TEXT = {
    allowed: ['✅ 已批准', 'ok'],
    answered: ['✅ 已提交回答', 'ok'],
    rejected: ['已拒绝', 'bad'],
    expired: ['手机链接已过期，请在电脑上处理', 'bad'],
    cancelled: ['请求已被取消', 'bad'],
    elsewhere: ['已在电脑上处理', 'ok'],
    gone: ['链接无效或已失效', 'bad'],
  };

  const isQuestion = () => state && state.kind === 'question';

  function buildForm() {
    const root = $('questions');
    root.textContent = '';
    (state.questions || []).forEach((q, qi) => {
      const card = el('div', 'card');
      card.dataset.id = q.id;
      if (q.header) card.appendChild(el('div', 'q-head', q.header));
      card.appendChild(el('div', 'q-text', q.question));
      if (q.detail) { const d = el('pre', 'q-detail'); d.textContent = q.detail; card.appendChild(d); }
      const type = q.multiSelect ? 'checkbox' : 'radio';
      (q.options || []).forEach((o, oi) => {
        const row = el('label', 'opt');
        const input = document.createElement('input');
        input.type = type; input.name = 'q' + qi; input.value = o.label; input.id = 'q' + qi + 'o' + oi;
        input.onchange = () => {
          card.querySelectorAll('.opt').forEach(r => r.classList.toggle('checked', r.querySelector('input').checked));
          if (!q.multiSelect && input.checked) card.querySelector('textarea').value = '';
        };
        const text = el('div');
        text.appendChild(el('div', 'opt-label', o.label));
        if (o.description) text.appendChild(el('div', 'opt-desc', o.description));
        row.appendChild(input); row.appendChild(text);
        card.appendChild(row);
      });
      card.appendChild(el('div', 'custom-label', (q.options && q.options.length) ? (q.multiSelect ? '补充说明（可选）' : '或者自己写') : '你的回答'));
      const area = document.createElement('textarea');
      area.oninput = () => {
        if (!q.multiSelect && area.value.trim()) {
          card.querySelectorAll('input').forEach(i => { i.checked = false; });
          card.querySelectorAll('.opt').forEach(r => r.classList.remove('checked'));
        }
      };
      card.appendChild(area);
      root.appendChild(card);
    });
    formBuilt = true;
  }

  function collectAnswers() {
    return (state.questions || []).map((q, qi) => {
      const card = $('questions').children[qi];
      const selected = Array.from(card.querySelectorAll('input:checked')).map(i => i.value);
      const custom = card.querySelector('textarea').value.trim();
      return custom ? { id: q.id, selected, custom } : { id: q.id, selected };
    });
  }

  function render() {
    if (!state) return;
    const question = isQuestion();
    $('title').textContent = question ? '❓ DSH 等你回答' : '🔐 DSH 审批请求';
    document.title = question ? 'DSH 提问' : 'DSH 审批';
    if (state.status !== 'pending') {
      $('actions').hidden = true;
      $('questions').hidden = true;
      const [text, cls] = STATUS_TEXT[state.status] || ['已结束', ''];
      $('status').textContent = text;
      $('status').className = 'status ' + cls;
      $('status').hidden = false;
      if (!state.session) $('details').hidden = true;
      return;
    }
    $('status').hidden = true;
    $('details').hidden = false;
    $('actions').hidden = false;
    $('session').textContent = state.session || '';
    $('approvalBox').hidden = question;
    if (question) {
      if (!formBuilt) buildForm();
      $('questions').hidden = false;
    } else {
      $('tool').textContent = state.tool || '';
      $('reason').textContent = state.reason || '';
      $('reasonBox').hidden = !state.reason;
      $('command').textContent = state.command || '';
      $('commandBox').hidden = !state.command;
    }
    $('enroll').hidden = state.enrolled;
    $('allow').hidden = question || !state.enrolled;
    $('submit').hidden = !question || !state.enrolled;
    $('reject').hidden = question;
  }

  function tickExpiry() {
    if (!state || state.status !== 'pending') return;
    const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    const h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
    const clock = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    $('expiry').textContent = '手机链接 ' + clock + ' 后失效；电脑上随时可处理';
    if (left === 0) { state.status = 'expired'; render(); }
  }

  async function load() {
    try {
      const res = await fetch(api, { cache: 'no-store' });
      if (res.status === 404) { state = { status: 'gone' }; render(); return; }
      const next = await res.json();
      if (!busy) { state = next; render(); }
    } catch (e) {
      $('status').textContent = '无法连接到电脑（Tailscale 已连接吗？）';
      $('status').className = 'status bad';
      $('status').hidden = false;
    }
  }

  async function post(path, body) {
    const res = await fetch(api + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.state) state = data.state;
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function lock(on) {
    busy = on;
    for (const id of ['enroll', 'allow', 'submit', 'reject']) $(id).disabled = on;
  }

  function showError(e) {
    const msg = e && e.name === 'NotAllowedError' ? '已取消 Face ID 验证' : (e && e.message) || String(e);
    $('error').textContent = msg;
  }

  async function faceId() {
    // navigator.credentials must run directly in the tap handler (Safari user-activation rule).
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: unb64u(state.challenge),
      rpId: state.rpId,
      allowCredentials: [{ type: 'public-key', id: unb64u(state.credentialId) }],
      userVerification: 'required',
      timeout: 120000,
    } });
    return {
      id: cred.id,
      clientDataJSON: b64u(cred.response.clientDataJSON),
      authenticatorData: b64u(cred.response.authenticatorData),
      signature: b64u(cred.response.signature),
    };
  }

  $('enroll').onclick = async () => {
    if (busy || !state || !state.enroll) return;
    lock(true); $('error').textContent = '';
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: unb64u(state.enroll.challenge),
        rp: { id: state.rpId, name: 'DSH 审批' },
        user: { id: unb64u(state.enroll.userId), name: 'dsh-approver', displayName: 'DSH 审批' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 120000,
      } });
      await post('/enroll', {
        id: cred.id,
        clientDataJSON: b64u(cred.response.clientDataJSON),
        attestationObject: b64u(cred.response.attestationObject),
      });
    } catch (e) { showError(e); }
    lock(false); render();
  };

  $('allow').onclick = async () => {
    if (busy || !state || !state.challenge) return;
    lock(true); $('error').textContent = '';
    try {
      await post('/decide', { decision: 'allow', assertion: await faceId() });
    } catch (e) { showError(e); }
    lock(false); render();
  };

  $('submit').onclick = async () => {
    if (busy || !state || !state.challenge) return;
    const answers = collectAnswers();
    const missing = answers.findIndex(a => a.selected.length === 0 && !a.custom);
    if (missing >= 0) {
      $('error').textContent = '还有问题没回答';
      $('questions').children[missing].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    lock(true); $('error').textContent = '';
    try {
      await post('/decide', { decision: 'answer', answers, assertion: await faceId() });
    } catch (e) { showError(e); }
    lock(false); render();
  };

  $('reject').onclick = async () => {
    if (busy) return;
    lock(true); $('error').textContent = '';
    try { await post('/decide', { decision: 'reject' }); } catch (e) { showError(e); }
    lock(false); render();
  };

  load();
  setInterval(() => { if (!busy && state && state.status === 'pending') load(); }, 3000);
  setInterval(tickExpiry, 1000);
})();
</script>
</body>
</html>
`
