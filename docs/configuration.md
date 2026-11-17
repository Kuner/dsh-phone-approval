# 配置参考

## 配置的保存位置

插件配置是 DSH profile 中 `id: phone-approval` 一行的 `config` 字段，桌面版位于 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: phone-approval
  name: dsh-phone-approval
  config:
    server: http://127.0.0.1:8080
    minTurnSeconds: 30
    phoneApproval:
      ttlSeconds: 600
```

常用项可以在设置页中修改，设置页会通过 DSH 的配置编辑器写回这个文件，并重新加载插件。其余字段需要手动编辑文件，保存后重启 DSH。未填写的字段使用下表中的默认值。

仓库中的 `cordis.patch.yml` 是安装时使用的初始配置，`config` 为空。

## 配置项

“设置页”一列标明能否在设置页中修改。

### 推送

| 字段 | 默认值 | 设置页 | 说明 |
|---|---|---|---|
| `server` | `https://api.day.app` | 是 | Bark 服务器地址，http 或 https |
| `credential` | `DSH_BARK_KEY` | 否 | 保存 Bark key 的凭据引用名 |
| `events.approval` | `true` | 是 | 推送审批请求。关闭后同时停用手机审批 |
| `events.question` | `true` | 是 | 推送 agent 提问。关闭后同时停用手机回答 |
| `events.completed` | `true` | 是 | 推送对话完成 |
| `events.error` | `true` | 是 | 推送对话出错 |
| `completedScope` | `human` | 是 | `human`：只推送由你发起的对话（输入消息或回答提问）的完成；`all`：同时推送自动开始的对话 |
| `minTurnSeconds` | `0` | 是 | 短于该秒数的对话不推送完成通知，0–86400 |
| `includeDetails` | `true` | 是 | 推送正文中包含审批原因、问题内容、回复预览 |
| `openUrl` | `""` | 否 | 点击完成和出错通知时打开的地址 |
| `group` | `DSH` | 否 | Bark 通知分组名 |
| `timeoutMs` | `10000` | 否 | 单次推送请求的超时时间（毫秒） |

### 手机审批（`phoneApproval`）

| 字段 | 默认值 | 设置页 | 说明 |
|---|---|---|---|
| `enabled` | `true` | 是 | 启用手机审批。关闭后只发送不带链接的通知 |
| `questions` | `true` | 是 | 允许在手机上回答 agent 提问 |
| `publicUrl` | `""` | 是 | 手机打开的 HTTPS 地址。留空时根据 Tailscale 自动生成 `https://<MagicDNS 名称>:<httpsPort>/` |
| `httpsPort` | `8443` | 否 | `tailscale serve` 在 tailnet 上使用的 HTTPS 端口 |
| `host` | `127.0.0.1` | 否 | 审批页服务的监听地址。不建议修改 |
| `port` | `47391` | 否 | 审批页服务的本机端口 |
| `adminPort` | `47392` | 否 | 设置页管理接口的本机端口，固定监听 `127.0.0.1` |
| `ttlSeconds` | `600` | 是 | 审批链接的有效期，60–3600 秒 |
| `questionTtlSeconds` | `21600` | 否 | 提问链接的有效期（秒） |
| `readyTimeoutMs` | `8000` | 否 | DSH 启动或插件重新加载后，审批页地址尚未就绪时，请求最多等待的时间。超时后发送不带链接的通知 |

修改 `httpsPort` 或 `port` 后，需要相应调整 `tailscale serve` 的转发，或在设置页点击 HTTPS 转发的 **开启**。

修改 `publicUrl` 或 Mac 的 MagicDNS 名称后，已注册的 Face ID 不再有效，需要在下次审批时重新注册。

## 凭据

密钥类数据保存在 DSH 凭据存储（`~/.dsh/.credentials.yaml`）中，不写入配置文件。

| 位置 | 名称 | 内容 |
|---|---|---|
| `refs` | `DSH_BARK_KEY` | Bark 设备 key |
| `records` | `phone-approval/passkey` | 已注册通行密钥的公钥、凭据 ID、签名计数、绑定域名 |
| `records` | `phone-approval/bark-encryption` | 推送加密的 Key、IV，以及是否启用 |

早期版本使用的记录 `bark-notify/passkey` 会在首次读取时自动迁移到 `phone-approval/passkey`。

## 端口

| 端口 | 监听地址 | 用途 | 对外暴露 |
|---|---|---|---|
| 47391 | `127.0.0.1` | 手机审批页 | 通过 `tailscale serve` 以 HTTPS 发布到 tailnet 的 8443 端口 |
| 47392 | `127.0.0.1` | 设置页管理接口 | 不暴露 |
| 8080 | `127.0.0.1` | 自建 bark-server（可选） | 通过 `tailscale serve` 发布到 tailnet 的 8444 端口，供 iPhone 注册设备 |

## Tailscale 命令的查找路径

插件按以下顺序查找 `tailscale` 命令。从 Finder 启动的应用通常拿不到终端里的 `PATH`，所以除了直接调用 `tailscale`，还会依次尝试几个常见的安装位置：

1. `tailscale`
2. `/usr/local/bin/tailscale`
3. `/opt/homebrew/bin/tailscale`
4. `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
5. `/usr/bin/tailscale`

插件每 60 秒检查一次 Tailscale 状态。
