// Browser half: the plugin's own page, opened from its entry in the left sidebar.
// It talks to the Host half through the loopback admin API whose URL and bearer
// token the Host injects into owner pages as globalThis.__DSH_PHONE_APPROVAL_ADMIN__.

window.__ModuleLoader__.load({
  id: 'dsh-phone-approval',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'phoneApproval'
    const PANEL_ID = 'phone-approval'
    const ADMIN_GLOBAL = '__DSH_PHONE_APPROVAL_ADMIN__'

    const zh = {
      panel: '手机审批',
      pageTitle: '手机审批与通知',
      serverLabel: '服务器',
      serverOk: '可访问',
      serverBad: '连不上',
      encTitle: '加密推送',
      encHint: '开启后推送内容先在这台 Mac 上加密，Bark 服务器和苹果推送服务都只能看到密文，只有你的 iPhone 能解开。',
      encOff: '未开启',
      encPending: '待启用',
      encOn: '已启用',
      encGenerate: '生成密钥',
      encSteps: '在 iPhone 的 Bark App 首页 → 推送加密 → 加密设置，按下面填写并保存。可以在 Mac 上点「复制」，再到 iPhone 上粘贴（通用剪贴板）。',
      encAlgorithm: '算法',
      encMode: '模式',
      encPadding: 'Padding',
      encKey: 'Key',
      encIv: 'IV',
      encIvHint: '每次推送都会带新的 IV，这里只是 App 要求填写时用。',
      copy: '复制',
      copied: '已复制',
      encShow: '显示密钥',
      encHide: '隐藏',
      encTest: '发送加密测试推送',
      encTestSent: '已发送加密测试推送。手机上能看到正文就说明设置正确；显示 Decryption Failed 说明密钥没填对。',
      encEnable: '手机能看到，启用加密',
      encDisable: '停用加密',
      encRegenerate: '重新生成',
      encRegenerateConfirm: '重新生成密钥后，需要在手机上换成新密钥，否则推送会显示 Decryption Failed。继续吗？',
      encClear: '删除密钥',
      encClearConfirm: '删除密钥并改回明文推送？',
      msgTitle: '推送哪些消息',
      msgHint: '审批和提问需要你处理；完成和出错只是通知。关闭某类推送后，这类消息就不会发到手机。',
      presetAll: '全部',
      presetActionable: '只推需要我处理的',
      presetCustom: '自定义',
      evApprovalHint: '关闭后也就不能在手机上审批了。',
      evQuestionHint: '关闭后也就不能在手机上回答了。',
      humanOnly: '“已完成”只推我发起的对话',
      humanOnlyHint: '后台子 agent 交回结果、任务完成、目标轮次等自动触发的对话结束时不推送。',
      phoneOptionsTitle: '手机审批与服务器',
      barkServerHint: '自建 bark-server 时填它的地址，然后在上面重新保存 Bark key（每个服务器的 key 不同）。',

      pageSubtitle: '把审批、提问、完成和出错推送到 iPhone，并在手机上用 Face ID 处理审批。',
      refresh: '刷新',
      noAdmin: '无法连接插件后台。请完全退出并重新打开 DSH，让页面拿到新的连接信息。',
      loading: '正在读取状态…',
      loadFailed: '读取状态失败：',
      retry: '重试',
      barkTitle: 'Bark 推送',
      barkHint: '在 iPhone 上安装 Bark，复制 App 首页的推送链接或其中的 key 粘贴到这里。key 保存在 DSH 凭据存储中。',
      barkSet: '已设置',
      barkUnset: '未设置',
      barkPlaceholder: '粘贴 Bark key 或推送链接',
      save: '保存',
      clear: '清除',
      testPush: '发送测试推送',
      testSent: '已发送，请查看手机。',
      phoneTitle: '手机审批',
      phoneHint: '审批和提问的推送附带一次性链接：审批可直接拒绝，批准和提交回答需要 Face ID。手机和电脑谁先处理以谁为准。',
      ready: '已就绪',
      notReady: '未就绪',
      disabled: '已关闭',
      server: '本机审批服务',
      running: '运行中',
      stopped: '未运行',
      tailscale: 'Tailscale',
      tsMissing: '未安装（Mac 和 iPhone 都需要安装并登录同一个 tailnet）',
      tsStopped: '未连接，请在菜单栏打开 Tailscale',
      tsConnected: '已连接',
      serve: 'HTTPS 转发',
      serveOn: '已开启（仅 tailnet 内可访问）',
      serveOff: '未开启',
      enableServe: '开启',
      httpsOff: '（需要先在 Tailscale 后台启用 HTTPS 证书）',
      faceId: 'Face ID',
      faceIdOn: '已注册',
      faceIdOff: '未注册，第一次在手机上批准时按提示注册',
      faceIdOther: '已注册，但绑定的是另一个地址，下次批准时需要重新注册',
      resetFaceId: '重置',
      resetConfirm: '确定重置 Face ID？下次在手机上批准时需要重新注册。',
      url: '审批页地址',
      urlNone: '—',
      optionsTitle: '选项',
      evApproval: '推送审批请求',
      evQuestion: '推送 agent 提问',
      evCompleted: '推送任务完成',
      evError: '推送出错',
      includeDetails: '推送内容包含详情',
      includeDetailsHint: '审批原因、问题内容和回复预览会写进推送。关闭后不再发送这些内容，但会话标题和工具名仍会出现。要执行的命令只在手机审批页显示，不进入推送。',
      minTurn: '短于多少秒的任务不推送“已完成”',
      phoneEnabled: '启用手机审批',
      phoneQuestions: '在手机上回答 agent 提问',
      phoneQuestionsHint: '提问推送附带链接，包括发布确认这类问题。提交回答需要 Face ID。',
      publicUrl: '审批页地址',
      publicUrlHint: '留空则自动使用 Tailscale 地址。',
      ttl: '审批链接有效期（秒）',
      barkServer: 'Bark 服务器',
      saveOptions: '保存选项',
      saving: '保存中…',
      saved: '已保存，插件已按新选项重新加载。',
      readOnly: '当前配置不支持从页面保存。',
      working: '处理中…',
    }

    const en = {
      panel: 'Phone approval',
      pageTitle: 'Phone approval and notifications',
      serverLabel: 'Server',
      serverOk: 'Reachable',
      serverBad: 'Unreachable',
      encTitle: 'Encrypted notifications',
      encHint: 'Notifications are encrypted on this Mac; the Bark server and Apple only see ciphertext, and only your iPhone can read them.',
      encOff: 'Off',
      encPending: 'Not enabled yet',
      encOn: 'On',
      encGenerate: 'Generate key',
      encSteps: 'On the iPhone, open Bark → Push Encryption → Encryption Settings and enter the values below. Click Copy here and paste on the iPhone (Universal Clipboard).',
      encAlgorithm: 'Algorithm',
      encMode: 'Mode',
      encPadding: 'Padding',
      encKey: 'Key',
      encIv: 'IV',
      encIvHint: 'Every notification carries a fresh IV; this one only fills the field if the app requires it.',
      copy: 'Copy',
      copied: 'Copied',
      encShow: 'Show key',
      encHide: 'Hide',
      encTest: 'Send encrypted test',
      encTestSent: 'Sent. If the phone shows the text, the key is right; "Decryption Failed" means it was entered wrong.',
      encEnable: 'Phone shows it — enable',
      encDisable: 'Turn off encryption',
      encRegenerate: 'Regenerate',
      encRegenerateConfirm: 'After regenerating, the phone needs the new key or notifications show "Decryption Failed". Continue?',
      encClear: 'Delete key',
      encClearConfirm: 'Delete the key and go back to plain notifications?',
      msgTitle: 'Which notifications to send',
      msgHint: 'Approvals and questions need you; finished turns and errors are just updates. Turned-off kinds never reach the phone.',
      presetAll: 'All',
      presetActionable: 'Only what needs me',
      presetCustom: 'Custom',
      evApprovalHint: 'Turning this off also turns off phone approval.',
      evQuestionHint: 'Turning this off also turns off answering on the phone.',
      humanOnly: 'Only notify "finished" for turns I started',
      humanOnlyHint: 'Turns started automatically (background subagent results, job completions, goal rounds) finish silently.',
      phoneOptionsTitle: 'Phone approval and server',
      barkServerHint: 'For a self-hosted bark-server enter its address, then save the Bark key again above (each server issues its own key).',

      pageSubtitle: 'Push approvals, questions, finished turns and errors to your iPhone, and answer approvals there with Face ID.',
      refresh: 'Refresh',
      noAdmin: 'Cannot reach the plugin backend. Quit DSH completely and reopen it so this page receives the new connection details.',
      loading: 'Loading status…',
      loadFailed: 'Could not load status: ',
      retry: 'Retry',
      barkTitle: 'Bark notifications',
      barkHint: 'Install Bark on your iPhone, then paste the push URL from the app home screen, or just its key. The key is kept in the DSH credential store.',
      barkSet: 'Set',
      barkUnset: 'Not set',
      barkPlaceholder: 'Paste a Bark key or push URL',
      save: 'Save',
      clear: 'Clear',
      testPush: 'Send test notification',
      testSent: 'Sent. Check your phone.',
      phoneTitle: 'Phone approval',
      phoneHint: 'Approval and question notifications carry a one-time link: reject freely; allowing and answering need Face ID. Whichever of phone and desktop answers first wins.',
      ready: 'Ready',
      notReady: 'Not ready',
      disabled: 'Off',
      server: 'Local approval server',
      running: 'Running',
      stopped: 'Not running',
      tailscale: 'Tailscale',
      tsMissing: 'Not installed (install it on the Mac and the iPhone and sign in to the same tailnet)',
      tsStopped: 'Not connected. Open Tailscale from the menu bar.',
      tsConnected: 'Connected',
      serve: 'HTTPS forwarding',
      serveOn: 'On (tailnet only)',
      serveOff: 'Off',
      enableServe: 'Turn on',
      httpsOff: ' (enable HTTPS certificates in the Tailscale admin console first)',
      faceId: 'Face ID',
      faceIdOn: 'Enrolled',
      faceIdOff: 'Not enrolled. You will be asked to enroll on your first phone approval.',
      faceIdOther: 'Enrolled for a different address; you will enroll again on the next approval.',
      resetFaceId: 'Reset',
      resetConfirm: 'Reset Face ID? You will enroll again on the next phone approval.',
      url: 'Approval page',
      urlNone: '—',
      optionsTitle: 'Options',
      evApproval: 'Notify approval requests',
      evQuestion: 'Notify agent questions',
      evCompleted: 'Notify finished turns',
      evError: 'Notify errors',
      includeDetails: 'Include details in notifications',
      includeDetailsHint: 'Approval reasons, question text and answer previews are included in notifications. Turn off to leave them out; session titles and tool names still appear. Commands are shown only on the phone approval page, never in a notification.',
      minTurn: 'Skip "finished" for turns shorter than (seconds)',
      phoneEnabled: 'Enable phone approval',
      phoneQuestions: 'Answer agent questions on the phone',
      phoneQuestionsHint: 'Question notifications carry a link, including release confirmations. Submitting an answer needs Face ID.',
      publicUrl: 'Approval page URL',
      publicUrlHint: 'Leave empty to use the Tailscale address automatically.',
      ttl: 'Approval link lifetime (seconds)',
      barkServer: 'Bark server',
      saveOptions: 'Save options',
      saving: 'Saving…',
      saved: 'Saved. The plugin reloaded with the new options.',
      readOnly: 'This profile cannot save options from the page.',
      working: 'Working…',
    }

    const CSS = `
.dpa-page { display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; overflow:hidden; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dpa-scroll { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }
.dpa-content { max-width:960px; margin:0 auto; padding:0 clamp(24px, 4vw, 48px) 48px; }
@media (max-width: 767px) { .dpa-content { padding-inline:20px; } }
.dpa-heading { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:16px; padding-top:28px; margin-bottom:24px; }
[data-platform='darwin'] .dpa-heading { padding-top:calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dpa-heading-text { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dpa-page-title { font-size:20px; line-height:28px; font-weight:500; margin:0; }
.dpa-root { display:flex; flex-direction:column; gap:16px; color:var(--dsw-alias-label-primary); font-size:14px; line-height:1.5; }
.dpa-card { background:var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); border:1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius:var(--dsw-radius-lg, 12px); padding:16px; display:flex; flex-direction:column; gap:12px; }
.dpa-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.dpa-title { font-size:15px; font-weight:600; margin:0; }
.dpa-hint { color:var(--dsw-alias-label-secondary); font-size:13px; margin:0; }
.dpa-row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:32px; }
.dpa-row + .dpa-row { border-top:1px solid var(--dsw-alias-border-l3); padding-top:10px; }
.dpa-label { display:flex; flex-direction:column; gap:2px; min-width:0; }
.dpa-sub { color:var(--dsw-alias-label-tertiary); font-size:12px; word-break:break-all; }
.dpa-status { display:flex; align-items:center; gap:8px; min-width:0; }
.dpa-dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--dsw-alias-label-tertiary); }
.dpa-dot.ok { background:var(--dsw-alias-state-success-primary); }
.dpa-dot.warn { background:var(--dsw-alias-state-warn-primary); }
.dpa-dot.bad { background:var(--dsw-alias-state-error-primary); }
.dpa-badge { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dpa-badge.ok { color:var(--dsw-alias-state-success-primary); border-color:currentColor; }
.dpa-inline { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.dpa-input { flex:1; min-width:180px; height:32px; padding:0 10px; border-radius:var(--dsw-radius-md, 8px); border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1, transparent); color:var(--dsw-alias-label-primary); font:inherit; }
.dpa-input.num { flex:none; width:96px; min-width:0; }
.dpa-input:focus-visible, .dpa-btn:focus-visible, .dpa-switch:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.dpa-btn { height:32px; padding:0 12px; border-radius:var(--dsw-radius-md, 8px); border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; white-space:nowrap; }
.dpa-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dpa-btn:disabled { opacity:.5; cursor:default; }
.dpa-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:var(--dsw-alias-label-primary-foreground, #fff); }
.dpa-btn.primary:hover:not(:disabled) { filter:brightness(1.08); background:var(--dsw-alias-brand-primary); }
.dpa-btn.danger { color:var(--dsw-alias-state-error-primary); }
.dpa-btn.small { height:26px; padding:0 10px; font-size:13px; }
.dpa-switch { position:relative; flex:none; width:36px; height:20px; border-radius:999px; border:0; padding:0; cursor:pointer; background:var(--dsw-alias-border-l2); transition:background .15s; }
.dpa-switch[aria-checked="true"] { background:var(--dsw-alias-brand-primary); }
.dpa-switch::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:transform .15s; }
.dpa-switch[aria-checked="true"]::after { transform:translateX(16px); }
.dpa-switch:disabled { opacity:.5; cursor:default; }
.dpa-msg { font-size:13px; color:var(--dsw-alias-label-secondary); margin:0; }
.dpa-msg.ok { color:var(--dsw-alias-state-success-primary); }
.dpa-msg.bad { color:var(--dsw-alias-state-error-primary); }
.dpa-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md, 8px); overflow:hidden; }
.dpa-seg button { height:30px; padding:0 12px; border:0; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; cursor:pointer; }
.dpa-seg button + button { border-left:1px solid var(--dsw-alias-border-l2); }
.dpa-seg button[aria-pressed="true"] { background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); color:var(--dsw-alias-label-primary); font-weight:500; }
.dpa-seg button:disabled { cursor:default; opacity:.6; }
.dpa-kv { display:grid; grid-template-columns:auto 1fr auto; gap:8px 12px; align-items:center; }
.dpa-kv-row { display:contents; }
.dpa-kv-k { color:var(--dsw-alias-label-secondary); font-size:13px; }
.dpa-code { font-family:var(--dsw-font-mono, ui-monospace, Menlo, monospace); font-size:13px; word-break:break-all; user-select:all; }
.dpa-footer { display:flex; align-items:center; justify-content:flex-end; gap:12px; }
`

    function adminInfo() {
      const info = globalThis[ADMIN_GLOBAL]
      return info && typeof info.url === 'string' && typeof info.token === 'string' ? info : undefined
    }

    async function call(path, body) {
      const info = adminInfo()
      if (!info) throw new Error('no admin connection')
      const res = await fetch(info.url + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false', 'aria-label': label,
        className: 'dpa-switch', disabled, onClick: () => onChange(!checked),
      })
    }

    function Dot({ tone }) {
      return h('span', { className: `dpa-dot ${tone || ''}`, 'aria-hidden': true })
    }

    function StatusRow({ label, tone, text, sub, action }) {
      return h('div', { className: 'dpa-row' },
        h('div', { className: 'dpa-label' },
          h('span', null, label),
          sub ? h('span', { className: 'dpa-sub' }, sub) : null),
        h('div', { className: 'dpa-status' },
          h(Dot, { tone }),
          h('span', { className: 'dpa-hint', style: { textAlign: 'right' } }, text),
          action || null))
    }

    function Message({ msg }) {
      if (!msg) return null
      return h('p', { className: `dpa-msg ${msg.tone || ''}`, role: msg.tone === 'bad' ? 'alert' : 'status' }, msg.text)
    }

    function useAction(reload) {
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const run = useCallback(async (fn, okText) => {
        setBusy(true)
        setMsg(null)
        try {
          await fn()
          if (okText) setMsg({ tone: 'ok', text: okText })
          await reload()
        } catch (error) {
          setMsg({ tone: 'bad', text: String(error && error.message || error) })
        } finally {
          setBusy(false)
        }
      }, [reload])
      return { busy, msg, run }
    }

    function BarkCard({ t, status, reload }) {
      const [key, setKey] = useState('')
      const { busy, msg, run } = useAction(reload)
      const configured = status.bark.configured
      return h('section', { className: 'dpa-card' },
        h('div', { className: 'dpa-head' },
          h('h3', { className: 'dpa-title' }, t('barkTitle')),
          h('span', { className: `dpa-badge ${configured ? 'ok' : ''}` },
            configured ? `${t('barkSet')}${status.bark.masked ? ` · ${status.bark.masked}` : ''}` : t('barkUnset'))),
        h('p', { className: 'dpa-hint' }, t('barkHint')),
        h(StatusRow, {
          label: t('serverLabel'), sub: status.bark.server,
          tone: status.bark.serverOk ? 'ok' : 'bad', text: status.bark.serverOk ? t('serverOk') : t('serverBad'),
        }),
        h('div', { className: 'dpa-inline' },
          h('input', {
            className: 'dpa-input', type: 'password', autoComplete: 'off', spellCheck: false,
            placeholder: t('barkPlaceholder'), value: key, 'aria-label': t('barkPlaceholder'),
            onChange: e => setKey(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter' && key.trim()) run(() => call('/bark-key', { key }).then(() => setKey(''))) },
          }),
          h('button', {
            type: 'button', className: 'dpa-btn primary', disabled: busy || !key.trim(),
            onClick: () => run(() => call('/bark-key', { key }).then(() => setKey(''))),
          }, t('save')),
          configured ? h('button', {
            type: 'button', className: 'dpa-btn danger', disabled: busy,
            onClick: () => run(() => call('/bark-key', { key: '' })),
          }, t('clear')) : null,
          h('button', {
            type: 'button', className: 'dpa-btn', disabled: busy || !configured,
            onClick: () => run(() => call('/test-push', {}), t('testSent')),
          }, t('testPush'))),
        h(Message, { msg }))
    }

    function PhoneCard({ t, status, reload }) {
      const { busy, msg, run } = useAction(reload)
      const ts = status.tailscale || {}
      const phone = status.phone
      const passkey = phone.passkey || {}
      const overall = !phone.enabled ? ['', t('disabled')] : phone.active ? ['ok', t('ready')] : ['', t('notReady')]
      return h('section', { className: 'dpa-card' },
        h('div', { className: 'dpa-head' },
          h('h3', { className: 'dpa-title' }, t('phoneTitle')),
          h('span', { className: `dpa-badge ${overall[0]}` }, overall[1])),
        h('p', { className: 'dpa-hint' }, t('phoneHint')),
        phone.enabled ? h('div', null,
          h(StatusRow, {
            label: t('server'), sub: `127.0.0.1:${phone.port}`,
            tone: phone.listening ? 'ok' : 'bad', text: phone.listening ? t('running') : t('stopped'),
          }),
          h(StatusRow, {
            label: t('tailscale'), sub: ts.dnsName,
            tone: !ts.installed ? 'bad' : ts.running ? 'ok' : 'warn',
            text: !ts.installed ? t('tsMissing') : ts.running ? t('tsConnected') : t('tsStopped'),
          }),
          h(StatusRow, {
            label: t('serve'), sub: `https · ${phone.httpsPort} → ${phone.port}`,
            tone: ts.serveOk ? 'ok' : 'warn',
            text: ts.serveOk ? t('serveOn') : `${t('serveOff')}${ts.running && ts.httpsEnabled === false ? t('httpsOff') : ''}`,
            action: !ts.serveOk && ts.running ? h('button', {
              type: 'button', className: 'dpa-btn small primary', disabled: busy,
              onClick: () => run(() => call('/tailscale/serve', {})),
            }, t('enableServe')) : null,
          }),
          h(StatusRow, {
            label: t('faceId'),
            sub: passkey.enrolled && passkey.createdAt ? new Date(passkey.createdAt).toLocaleString() : undefined,
            tone: passkey.enrolled ? (passkey.matchesUrl === false ? 'warn' : 'ok') : 'warn',
            text: passkey.enrolled ? (passkey.matchesUrl === false ? t('faceIdOther') : t('faceIdOn')) : t('faceIdOff'),
            action: passkey.enrolled ? h('button', {
              type: 'button', className: 'dpa-btn small danger', disabled: busy,
              onClick: () => { if (window.confirm(t('resetConfirm'))) run(() => call('/passkey/reset', {})) },
            }, t('resetFaceId')) : null,
          }),
          h(StatusRow, { label: t('url'), tone: phone.url ? 'ok' : '', text: phone.url || t('urlNone') })) : null,
        h(Message, { msg }))
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    // A real component (rendered with h), so its useState never shifts the parent's hook order.
    // The wrapper uses display:contents so its three cells still sit in the parent grid.
    function CopyField({ t, label, value, hint }) {
      const [copied, setCopied] = useState(false)
      return h('div', { className: 'dpa-kv-row' },
        h('span', { className: 'dpa-kv-k' }, label),
        h('div', null,
          h('div', { className: 'dpa-code' }, value),
          hint ? h('div', { className: 'dpa-sub' }, hint) : null),
        h('button', {
          type: 'button', className: 'dpa-btn small',
          onClick: async () => { if (await copyText(value)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } },
        }, copied ? t('copied') : t('copy')))
    }

    function EncryptionCard({ t, status, reload }) {
      const enc = status.encryption
      const [secret, setSecret] = useState(null)
      const { busy, msg, run } = useAction(reload)
      const reveal = () => run(async () => setSecret(await call('/encryption/reveal', {})))
      const badge = !enc.configured ? ['', t('encOff')] : enc.enabled ? ['ok', t('encOn')] : ['', t('encPending')]
      // A key that is not enabled yet is shown right away: the next step is entering it on the phone.
      useEffect(() => { if (enc.configured && !enc.enabled && !secret) void reveal() }, [enc.configured, enc.enabled])
      const btn = (label, onClick, cls = '') => h('button', { type: 'button', className: `dpa-btn ${cls}`, disabled: busy || !status.bark.configured, onClick }, label)
      return h('section', { className: 'dpa-card' },
        h('div', { className: 'dpa-head' },
          h('h3', { className: 'dpa-title' }, t('encTitle')),
          h('span', { className: `dpa-badge ${badge[0]}` }, badge[1])),
        h('p', { className: 'dpa-hint' }, t('encHint')),
        secret ? h('div', null,
          h('p', { className: 'dpa-hint', style: { marginBottom: '10px' } }, t('encSteps')),
          h('div', { className: 'dpa-kv' },
            h('span', { className: 'dpa-kv-k' }, t('encAlgorithm')), h('span', { className: 'dpa-code' }, enc.algorithm), h('span'),
            h('span', { className: 'dpa-kv-k' }, t('encMode')), h('span', { className: 'dpa-code' }, enc.mode), h('span'),
            h('span', { className: 'dpa-kv-k' }, t('encPadding')), h('span', { className: 'dpa-code' }, enc.padding), h('span'),
            h(CopyField, { key: 'key', t, label: t('encKey'), value: secret.key }),
            h(CopyField, { key: 'iv', t, label: t('encIv'), value: secret.iv, hint: t('encIvHint') }))) : null,
        h('div', { className: 'dpa-inline' },
          !enc.configured ? btn(t('encGenerate'), () => run(async () => setSecret(await call('/encryption/generate', {}))), 'primary') : null,
          enc.configured ? btn(t('encTest'), () => run(() => call('/encryption/test', {}), t('encTestSent'))) : null,
          enc.configured && !enc.enabled ? btn(t('encEnable'), () => run(() => call('/encryption/enable', { enabled: true }).then(() => setSecret(null))), 'primary') : null,
          enc.configured && enc.enabled ? btn(secret ? t('encHide') : t('encShow'), () => (secret ? setSecret(null) : reveal())) : null,
          enc.configured && enc.enabled ? btn(t('encDisable'), () => run(() => call('/encryption/enable', { enabled: false }))) : null,
          enc.configured ? btn(t('encRegenerate'), () => { if (window.confirm(t('encRegenerateConfirm'))) run(async () => setSecret(await call('/encryption/generate', {}))) }) : null,
          enc.configured ? btn(t('encClear'), () => { if (window.confirm(t('encClearConfirm'))) run(() => call('/encryption/clear', {}).then(() => setSecret(null))) }, 'danger') : null),
        h(Message, { msg }))
    }

    /** Shared draft/save logic for cards that edit plugin configuration. */
    function useConfigCard(status, reload, t, toDraftFn, toPatch) {
      const [draft, setDraft] = useState(() => toDraftFn(status.config))
      const initial = useRef(JSON.stringify(toDraftFn(status.config)))
      const action = useAction(reload)
      const writable = status.configWritable
      const disabled = !writable || action.busy
      const dirty = JSON.stringify(draft) !== initial.current
      const save = () => action.run(async () => {
        await call('/config', { patch: toPatch(draft) })
        initial.current = JSON.stringify(draft)
        // The plugin restarts with the new options; give it a moment before re-reading.
        await new Promise(resolve => setTimeout(resolve, 1200))
      }, t('saved'))
      const toggleRow = (label, checked, onChange, hint, extraDisabled = false) => h('div', { className: 'dpa-row' },
        h('div', { className: 'dpa-label' }, h('span', null, label), hint ? h('span', { className: 'dpa-sub' }, hint) : null),
        h(Switch, { checked, onChange, label, disabled: disabled || extraDisabled }))
      const fieldRow = (label, input, hint) => h('div', { className: 'dpa-row' },
        h('div', { className: 'dpa-label' }, h('span', null, label), hint ? h('span', { className: 'dpa-sub' }, hint) : null),
        input)
      const footer = h('div', { className: 'dpa-footer' },
        h(Message, { msg: !writable ? { text: t('readOnly') } : action.msg }),
        h('button', { type: 'button', className: 'dpa-btn primary', disabled: disabled || !dirty, onClick: save },
          action.busy ? t('saving') : t('saveOptions')))
      return { draft, setDraft, disabled, toggleRow, fieldRow, footer }
    }

    const PRESETS = {
      all: { approval: true, question: true, completed: true, error: true },
      actionable: { approval: true, question: true, completed: false, error: false },
    }
    const presetOf = events => Object.keys(PRESETS).find(name =>
      Object.entries(PRESETS[name]).every(([k, v]) => Boolean(events[k]) === v)) || 'custom'

    function MessagesCard({ t, status, reload }) {
      const card = useConfigCard(status, reload, t, config => ({
        events: { ...config.events },
        completedScope: config.completedScope || 'human',
        includeDetails: config.includeDetails,
        minTurnSeconds: String(config.minTurnSeconds),
      }), draft => ({
        events: draft.events,
        completedScope: draft.completedScope,
        includeDetails: draft.includeDetails,
        minTurnSeconds: Number(draft.minTurnSeconds),
      }))
      const { draft, setDraft, disabled, toggleRow, fieldRow } = card
      const setEvent = (k, v) => setDraft(d => ({ ...d, events: { ...d.events, [k]: v } }))
      const preset = presetOf(draft.events)
      const presetButton = (name, label) => h('button', {
        type: 'button', 'aria-pressed': preset === name ? 'true' : 'false', disabled: disabled || name === 'custom',
        onClick: () => { if (PRESETS[name]) setDraft(d => ({ ...d, events: { ...PRESETS[name] } })) },
      }, label)
      return h('section', { className: 'dpa-card' },
        h('div', { className: 'dpa-head' },
          h('h3', { className: 'dpa-title' }, t('msgTitle')),
          h('div', { className: 'dpa-seg', role: 'group', 'aria-label': t('msgTitle') },
            presetButton('all', t('presetAll')),
            presetButton('actionable', t('presetActionable')),
            presetButton('custom', t('presetCustom')))),
        h('p', { className: 'dpa-hint' }, t('msgHint')),
        h('div', null,
          toggleRow(t('evApproval'), draft.events.approval, v => setEvent('approval', v), t('evApprovalHint')),
          toggleRow(t('evQuestion'), draft.events.question, v => setEvent('question', v), t('evQuestionHint')),
          toggleRow(t('evCompleted'), draft.events.completed, v => setEvent('completed', v)),
          toggleRow(t('humanOnly'), draft.completedScope !== 'all', v => setDraft(d => ({ ...d, completedScope: v ? 'human' : 'all' })),
            t('humanOnlyHint'), !draft.events.completed),
          fieldRow(t('minTurn'), h('input', {
            className: 'dpa-input num', inputMode: 'numeric', value: draft.minTurnSeconds, disabled: disabled || !draft.events.completed,
            'aria-label': t('minTurn'), onChange: e => setDraft(d => ({ ...d, minTurnSeconds: e.target.value })),
          })),
          toggleRow(t('evError'), draft.events.error, v => setEvent('error', v)),
          toggleRow(t('includeDetails'), draft.includeDetails, v => setDraft(d => ({ ...d, includeDetails: v })), t('includeDetailsHint'))),
        card.footer)
    }

    function OptionsCard({ t, status, reload }) {
      const card = useConfigCard(status, reload, t, config => ({
        server: config.server,
        phoneApproval: {
          enabled: config.phoneApproval.enabled,
          questions: config.phoneApproval.questions !== false,
          publicUrl: config.phoneApproval.publicUrl || '',
          ttlSeconds: String(config.phoneApproval.ttlSeconds),
        },
      }), draft => ({
        server: draft.server,
        phoneApproval: {
          enabled: draft.phoneApproval.enabled,
          questions: draft.phoneApproval.questions,
          publicUrl: draft.phoneApproval.publicUrl.trim(),
          ttlSeconds: Number(draft.phoneApproval.ttlSeconds),
        },
      }))
      const { draft, setDraft, disabled, toggleRow, fieldRow } = card
      const setPhone = (k, v) => setDraft(d => ({ ...d, phoneApproval: { ...d.phoneApproval, [k]: v } }))
      return h('section', { className: 'dpa-card' },
        h('div', { className: 'dpa-head' }, h('h3', { className: 'dpa-title' }, t('phoneOptionsTitle'))),
        h('div', null,
          toggleRow(t('phoneEnabled'), draft.phoneApproval.enabled, v => setPhone('enabled', v)),
          toggleRow(t('phoneQuestions'), draft.phoneApproval.questions, v => setPhone('questions', v), t('phoneQuestionsHint'), !draft.phoneApproval.enabled),
          fieldRow(t('publicUrl'), h('input', {
            className: 'dpa-input', placeholder: status.tailscale && status.tailscale.url || 'https://', value: draft.phoneApproval.publicUrl,
            disabled: disabled || !draft.phoneApproval.enabled, 'aria-label': t('publicUrl'),
            onChange: e => setPhone('publicUrl', e.target.value),
          }), t('publicUrlHint')),
          fieldRow(t('ttl'), h('input', {
            className: 'dpa-input num', inputMode: 'numeric', value: draft.phoneApproval.ttlSeconds,
            disabled: disabled || !draft.phoneApproval.enabled, 'aria-label': t('ttl'),
            onChange: e => setPhone('ttlSeconds', e.target.value),
          })),
          fieldRow(t('barkServer'), h('input', {
            className: 'dpa-input', value: draft.server, disabled, 'aria-label': t('barkServer'),
            onChange: e => setDraft(d => ({ ...d, server: e.target.value })),
          }), t('barkServerHint'))),
        card.footer)
    }

    function SettingsPage({ t }) {
      const [state, setState] = useState({ kind: adminInfo() ? 'loading' : 'no-admin' })
      const reload = useCallback(async () => {
        if (!adminInfo()) { setState({ kind: 'no-admin' }); return }
        try {
          const status = await call('/status')
          setState({ kind: 'ready', status })
        } catch (error) {
          setState({ kind: 'error', error: String(error && error.message || error) })
        }
      }, [])
      useEffect(() => { void reload() }, [reload])
      const [refreshing, setRefreshing] = useState(false)
      const refresh = async () => {
        setRefreshing(true)
        try { await reload() } finally { setRefreshing(false) }
      }
      let body
      if (state.kind === 'no-admin') body = h('p', { className: 'dpa-msg bad' }, t('noAdmin'))
      else if (state.kind === 'loading') body = h('p', { className: 'dpa-msg' }, t('loading'))
      else if (state.kind === 'error') {
        body = h('div', { className: 'dpa-inline' },
          h('p', { className: 'dpa-msg bad' }, t('loadFailed') + state.error),
          h('button', { type: 'button', className: 'dpa-btn small', onClick: () => { void refresh() } }, t('retry')))
      } else {
        body = [
          h(BarkCard, { key: 'bark', t, status: state.status, reload }),
          h(EncryptionCard, { key: 'enc', t, status: state.status, reload }),
          h(MessagesCard, { key: `msg-${JSON.stringify(state.status.config)}`, t, status: state.status, reload }),
          h(PhoneCard, { key: 'phone', t, status: state.status, reload }),
          h(OptionsCard, { key: `options-${JSON.stringify(state.status.config)}`, t, status: state.status, reload }),
        ]
      }
      return h('div', { className: 'dpa-page' },
        h('style', null, CSS),
        h('div', { className: 'dpa-scroll' },
          h('div', { className: 'dpa-content' },
            h('header', { className: 'dpa-heading' },
              h('div', { className: 'dpa-heading-text' },
                h('h1', { className: 'dpa-page-title' }, t('pageTitle')),
                h('p', { className: 'dpa-hint' }, t('pageSubtitle'))),
              h('button', {
                type: 'button', className: 'dpa-btn', disabled: refreshing || state.kind === 'no-admin',
                onClick: () => { void refresh() },
              }, t('refresh'))),
            h('div', { className: 'dpa-root' }, body))))
    }

    // Sidebar glyph: a phone outline with a check, drawn in the row's current color.
    function PanelIcon({ size }) {
      const edge = size || 16
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('rect', { x: 3.5, y: 1.5, width: 9, height: 13, rx: 2 }),
      h('path', { d: 'M7 12.25h2' }),
      h('path', { d: 'M5.9 7.1l1.45 1.45L10.1 5.8' }))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'phone-approval: dictionaries')
        const t = ctx.locale.bind(NS)
        // A global page: the sidebar entry selects the `main` panel registered under the same id.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, SettingsPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, PanelIcon))
      },
    }
  },
})
