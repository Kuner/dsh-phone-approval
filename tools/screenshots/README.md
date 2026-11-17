# 截图生成

`capture.sh` 重新生成 `docs/images/` 下的全部截图。

截图使用插件真实的 `page.js`（手机页面）和 `client.js`（设置页），配合 DSH 的主题样式表和 `server.mjs` 中的示例数据渲染，再由 headless Chrome 截取。示例数据中的地址、key 和会话名都是虚构的。

## 依赖

- DeepSeek Harness 桌面版：从安装包中读取主题样式表。
- Google Chrome。
- Node.js 20 及以上，以及 npm：首次运行时安装 React 18。React 19 不再提供 UMD 构建，因此固定使用 18。
- Python 3 和 Pillow：裁剪和拼接图片。

## 运行

```sh
tools/screenshots/capture.sh
```

可用环境变量覆盖默认路径：`NODE`、`PYTHON`、`CHROME`、`DSH_APP`、`PORT`（默认 47380）。

## 产出

| 文件 | 内容 |
|---|---|
| `hero.png` | README 首图：审批页和提问页 |
| `phone-approval.png` | 手机审批页 |
| `phone-question.png` | 手机回答页 |
| `phone-enroll.png` | 首次使用时的 Face ID 注册按钮 |
| `settings-light.png`、`settings-dark.png` | 完整设置页，浅色和深色主题 |
| `card-encryption.png` | 加密推送：已生成密钥、待启用 |
| `card-messages.png` | 推送哪些消息 |
| `card-phone.png` | 手机审批状态 |
