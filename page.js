// The single phone approval page. All dynamic values are inserted with textContent.

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>DSH 审批</title>
<style>
  :root { --bg:#f5f5f7; --card:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --code:#f2f2f7;
          --allow:#0a7cff; --reject:#e5484d; --ok:#2f9e44; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#000; --card:#1c1c1e; --fg:#f5f5f7; --muted:#98989d; --line:#2c2c2e; --code:#2c2c2e;
            --allow:#3b8eff; --reject:#ff5c61; --ok:#40c057; }
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
  button { width:100%; border:0; border-radius:12px; padding:15px; font-size:17px; font-weight:600;
           margin-bottom:10px; cursor:pointer; }
  button:disabled { opacity:.5; }
  #allow, #enroll { background:var(--allow); color:#fff; }
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
  <h1>🔐 DSH 审批请求</h1>
  <div class="card" id="details" hidden>
    <div class="label">会话</div><div class="value" id="session"></div>
    <div class="label">工具</div><div class="value" id="tool"></div>
    <div id="reasonBox"><div class="label">原因</div><div class="value" id="reason"></div></div>
    <div id="commandBox"><div class="label">将要执行</div><pre id="command"></pre></div>
  </div>
  <div id="actions" hidden>
    <button id="enroll" hidden>首次使用：注册 Face ID</button>
    <button id="allow" hidden>用 Face ID 批准</button>
    <button id="reject">拒绝</button>
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

  const STATUS_TEXT = {
    allowed: ['✅ 已批准', 'ok'],
    rejected: ['已拒绝', 'bad'],
    expired: ['链接已过期，请在电脑上处理', 'bad'],
    cancelled: ['请求已被取消', 'bad'],
    elsewhere: ['已在电脑上处理', 'ok'],
    gone: ['链接无效或已失效', 'bad'],
  };

  function render() {
    if (!state) return;
    if (state.status !== 'pending') {
      $('actions').hidden = true;
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
    $('tool').textContent = state.tool || '';
    $('reason').textContent = state.reason || '';
    $('reasonBox').hidden = !state.reason;
    $('command').textContent = state.command || '';
    $('commandBox').hidden = !state.command;
    $('enroll').hidden = state.enrolled;
    $('allow').hidden = !state.enrolled;
  }

  function tickExpiry() {
    if (!state || state.status !== 'pending') return;
    const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    $('expiry').textContent = '手机审批链接 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ' 后失效；电脑上随时可处理';
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
    for (const id of ['enroll', 'allow', 'reject']) $(id).disabled = on;
  }

  function showError(e) {
    const msg = e && e.name === 'NotAllowedError' ? '已取消 Face ID 验证' : (e && e.message) || String(e);
    $('error').textContent = msg;
  }

  $('enroll').onclick = async () => {
    if (busy || !state || !state.enroll) return;
    lock(true); $('error').textContent = '';
    try {
      // navigator.credentials must run directly in the tap handler (Safari user-activation rule).
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
      $('error').textContent = '';
    } catch (e) { showError(e); }
    lock(false); render();
  };

  $('allow').onclick = async () => {
    if (busy || !state || !state.challenge) return;
    lock(true); $('error').textContent = '';
    try {
      const cred = await navigator.credentials.get({ publicKey: {
        challenge: unb64u(state.challenge),
        rpId: state.rpId,
        allowCredentials: [{ type: 'public-key', id: unb64u(state.credentialId) }],
        userVerification: 'required',
        timeout: 120000,
      } });
      await post('/decide', {
        decision: 'allow',
        assertion: {
          id: cred.id,
          clientDataJSON: b64u(cred.response.clientDataJSON),
          authenticatorData: b64u(cred.response.authenticatorData),
          signature: b64u(cred.response.signature),
        },
      });
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
