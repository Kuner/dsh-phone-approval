# dsh-phone-approval

DeepSeek Harness（DSH）插件：把需要你处理的事件推送到 iPhone，并在手机上用 **Face ID** 处理权限审批。

*A DeepSeek Harness plugin that pushes approval requests, questions, finished turns and errors to your iPhone through [Bark](https://bark.day.app), and lets you answer approvals on the phone — reject freely, allow with Face ID (passkey) — over your private Tailscale network.*

## 功能

| 推送 | 触发 | iOS 级别 |
|---|---|---|
| 🔐 需要审批 | agent 申请权限（含子 agent），附带一次性审批链接 | 时效性通知 |
| ❓ 等待你回答 | agent 提问（`ask_user_question`、计划审阅），附带一次性回答链接 | 时效性通知 |
| ✅ 已完成 | 顶层会话中**你发起的**一轮正常结束（子 agent 交回结果、任务完成、目标轮次等自动触发的轮次默认不推） | 普通 |
| ⚠️ 出错 | 顶层会话一轮出错 | 时效性通知 |

**手机审批**

- 点开审批推送 → 手机页面显示会话、工具、原因和**具体要执行的命令**。
- **拒绝**无需验证；**批准**必须通过 Face ID。第一次批准时页面引导注册 passkey。
- 手机与电脑谁先处理以谁为准；手机先处理时，电脑上的审批框自动撤回。
- 链接一次性有效，默认 10 分钟过期，Face ID 连续失败 5 次作废；电脑上随时仍可处理。

**手机回答提问**

- 点开提问推送 → 手机页面显示完整问题和选项（含说明），可以选选项或自己写回答，多个问题一次提交。
- 提交回答需要 Face ID：像「确认发布」这样的回答等同于授权。
- 手机与电脑谁先回答以谁为准；手机先回答时，电脑上的提问框自动撤回。
- 提问链接默认 6 小时过期（`questionTtlSeconds`），适合发布门禁这种可能晚些才处理的问题。如果电脑上的提问已经超时转为「待回答」，手机回答会作为补充回复送给 agent。

**推送哪些消息**：设置页可一键切换「全部」或「只推需要我处理的」（审批和提问），也可逐类开关；「已完成」默认只推你发起的对话。

**加密推送**：设置页生成 AES-256-CBC 密钥，填进 Bark App 的「推送加密」后启用。之后标题、正文和审批链接都在本机加密，Bark 服务器和苹果推送服务只能看到密文；每条推送使用新的随机 IV。

**自建 Bark 服务器**：

```sh
docker run -d --name bark --restart unless-stopped -p 127.0.0.1:8080:8080 -v ~/.bark-server/data:/data finab/bark-server
tailscale serve --bg --https=8444 http://127.0.0.1:8080   # 让 iPhone 上的 Bark App 能注册
```

然后在 Bark App 添加服务器 `https://<mac>.<tailnet>.ts.net:8444`，设置页把 Bark 服务器改成 `http://127.0.0.1:8080` 并保存新的 key。

**设置页**：DSH 左侧边栏 → 「手机审批」。可以设置 Bark key、发测试推送、查看 Tailscale / HTTPS 转发 / Face ID 状态、一键开启 Tailscale 转发、重置 Face ID，以及调整通知选项。

## 安装

前提：DSH 桌面版或 `dsh --profile web`，macOS（Tailscale 路径探测针对 macOS，Linux 也可用）。

1. 克隆本仓库：`git clone https://github.com/Kuner/dsh-phone-approval.git`
2. DSH → **插件** → **添加插件** → 选择本地目录，指向克隆下来的目录（或让 agent 用 `plugin_manager install_bundle` 安装该目录）。
3. 完全退出并重新打开 DSH（设置页需要页面重新加载才能连上插件后台）。
4. 点左侧边栏的「手机审批」，按顺序完成：
   1. iPhone 安装 [Bark](https://bark.day.app)（App Store 搜索 Bark），把 App 首页的推送链接粘贴到「Bark 推送」，点「发送测试推送」。
   2. Mac 和 iPhone 安装 [Tailscale](https://tailscale.com) 并登录同一个 tailnet；在 Tailscale 后台启用 MagicDNS 和 HTTPS 证书。
   3. 「HTTPS 转发」点「开启」（等价于 `tailscale serve --bg --https=8443 http://127.0.0.1:47391`）。
   4. 状态显示「已就绪」后，下次审批推送点开即可在手机上处理。

只想要推送、不要手机审批：在选项里关闭「启用手机审批」。

## 工作原理

```
agent 需要审批
   └─ approval/request 审批链
        ├─ 本插件（最前）：生成一次性链接 → Bark 推送 → 等手机
        └─ DSH 自带转发 → 电脑上的审批框
   谁先决定用谁；手机先决定时中止转发信号，DSH 撤回电脑上的审批框

iPhone ──Tailscale(HTTPS, tailnet only)──▶ 127.0.0.1:47391 审批页（本插件）
DSH 设置页 ──Bearer token──▶ 127.0.0.1:47392 管理接口（不对 tailnet 发布）
```

- 通知只旁听已提交的会话事件（`session/event`），不改变任何结果。
- 审批请求本身不含工具参数；插件从同一会话的 `tool/call` 事件中取出命令，只显示在手机审批页上，不进入推送。

## 安全设计

- 审批页只监听 `127.0.0.1`，通过 `tailscale serve` 发布到你的 tailnet（不是 Funnel，不上公网）。
- 批准需要 WebAuthn passkey：服务端校验签名、challenge（一次性）、origin、RP ID 哈希、用户在场与**用户验证**（Face ID）标志；只接受 ES256。
- 只有在没有已注册 passkey 时才允许注册；passkey 公钥保存在 DSH 凭据存储的 `phone-approval/passkey` 记录中。
- 审批链接含 256 位随机 token，一次性、限时；POST 校验 Origin；页面带严格 CSP、`no-store`、禁止被嵌入。
- 设置页的管理接口在另一个只监听本机的端口上，要求 Bearer token；token 仅通过 DSH 的页面注入下发给 owner 的页面。
- Bark key 保存在 DSH 凭据存储（`DSH_BARK_KEY`），不写入配置文件。

**注意**：tailnet 内的其他设备都能打开审批页（但没有你的 Face ID 只能拒绝）；审批链接 URL 会经过 Bark 服务器。工具名、审批原因、问题内容和回复预览也会经过 Bark 服务器——可关闭「推送内容包含详情」，或自建 [bark-server](https://github.com/Finb/bark-server)。

## 配置

常用选项都在设置页里；全部字段见 [`cordis.patch.yml`](cordis.patch.yml) 中的注释。保存选项会让插件按新配置重新加载。

## 开发

```sh
node --check index.js     # 或 npm run check
node test/e2e.mjs         # 端到端测试：模拟 DSH 上下文 + 软件 WebAuthn 认证器
```

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件：通知、审批链监听、管理接口路由、页面注入 |
| `phone-approval.js` | 手机审批页服务、一次性链接、passkey 注册与校验流程 |
| `webauthn.js` | 无依赖的 CBOR 解码与 WebAuthn 校验 |
| `bark-crypto.js` | Bark 推送加密（AES-256-CBC） |
| `page.js` | 手机审批页 HTML |
| `admin.js` | 设置页用的本机管理接口 |
| `tailscale.js` | Tailscale 状态检测与 `tailscale serve` |
| `client.js` | 左侧边栏入口与设置页（浏览器端） |

修改插件代码后需要完全重启 DSH 才会加载新代码。

## 许可证

[MIT](LICENSE)
