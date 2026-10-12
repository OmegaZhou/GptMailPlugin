# 历史研究记录

以下按调研过程保留，旧密钥、单邮箱 OAuth 和导出配置方案已废弃，不作为当前操作说明。当前实现与验收见 [面板说明](settings.md)。

# 插件面板源码对照（2026-10-11）

目标保持为：在 GptMail 插件内配置连接、验证密钥并管理 IMAP/SMTP 邮箱。原有仓库、托管服务和 `/mail-mcp` 路径继续使用。

## 找到的真实实现

### Gmail 安装包

检查本机已安装的 `gmail/0.1.10`，`.codex-plugin/plugin.json` 声明 `apps: "./.app.json"`，`.app.json` 引用已经注册的 Gmail connector，并设为必需。包内没有邮箱设置的 HTML、JavaScript 或 MCP 服务程序。

浏览器实测 Gmail 管理页包含“已连接的账户”“连接另一个账户”及 OAuth 认证信息。因此 Gmail 账号面板来自宿主的应用连接管理；其托管后端和宿主面板实现不在这个插件安装包中。不能声称已取得 Gmail 完整服务端源码，也不能复制 Gmail 的 App ID 给 GptMail。

### OpenAI Bits & Bolts

完整公开源码：[openai/mcp-extensions](https://github.com/openai/mcp-extensions/tree/0d606217705e0e71eb21fff009619b67b80611dc/plugins/bits-and-bolts)。已克隆到被忽略的 `artifacts/references/mcp-extensions`，固定提交 `0d606217705e0e71eb21fff009619b67b80611dc`。

- [设置注册代码](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/plugins/bits-and-bolts/src/server/register.ts#L162)：`createSettings(server).register` 注册 fields、layout、read、update；Library 分组使用工具按钮打开 MCP App。
- [托管服务器代码](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/plugins/bits-and-bolts/src/server/remote/index.ts)：远程版本复用同一设置注册函数，并在 MCP 入口检查 OAuth。
- [官方设置 SDK](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/typescript/src/server/settings.ts)：生成 read/update 工具、严格输入输出结构和 `openai/settings` 能力声明。
- [结构化设置规范](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/docs/spec.md#structured-settings)：宿主在插件详情页绘制原生控件；MCP App 按钮在设置之上打开弹窗。

## 实现链路及当前差异

| 层次 | 参考实现 | GptMail 的状态 |
| --- | --- | --- |
| 宿主识别 | Gmail 引用注册应用；Bits & Bolts Remote 页面列出应用 | 账户插件仍是 MCP 配置包，没有注册应用绑定，网页管理链接指向桌面 |
| 设置发现 | `openai/settings` 指向同服务的读写工具 | 已改用官方 `createSettings`，保留现有工具名称 |
| 设置按钮 | layout 引用接受 `{}` 的 MCP App 工具 | `open_settings` 返回资源 URI；不再使用已移除的 settings entrypoint |
| 设置弹窗 | 宿主决定展示容器 | 支持 inline/fullscreen，不再自动把设置弹窗切到全屏 |
| 表单操作 | MCP Apps bridge 调用同服务工具 | 保留密钥验证、连接配置、邮箱增删改和测试 |

官方 [2026-10-10 更新记录](https://github.com/openai/mcp-extensions/blob/0d606217705e0e71eb21fff009619b67b80611dc/CHANGELOG.md) 删除了 `type:"settings"` entrypoint。这是本次发现的兼容问题，时间上不能用它单独解释此前所有失败。

[官方帮助](https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github#understand-the-desktop-only-label) 明确说明，声明远程 HTTPS MCP 的导入包也可能标为 Desktop only，加入 `.app.json` 仍需满足应用访问和认证条件。[打包文档](https://developers.openai.com/plugins/build/plugins#create-and-test-a-plugin-locally-with-an-mcp-server) 描述先注册 MCP 应用，再引用真实注册 ID 的流程。这是补齐宿主应用绑定的依据，不能通过改名称、增加 Interactive 标记或重新压缩 HTML 代替。

## 早期验证边界（已由文末后续验收更新）

- 已验证：浏览器能访问真实插件页；Gmail 管理控件；GptMail 尚缺网页配置入口。
- 已验证：本地构建及 32 项测试通过；SDK schema 校验、设置能力发现、按钮调用、资源读取、空/未知设置更新拒绝、凭据隔离、无 `/panel` 路由。
- 已验证：修复已部署到原托管服务，线上 HTTPS 检查通过，包括原生设置协议、HTML 资源、密钥验证及私有元数据；没有修改邮箱配置。账户插件仍保留原 0.4.0 发布，尚未上传下一版。
- 已验证：ChatGPT 的“添加自定义 MCP 服务器”表单识别出现有服务的 OAuth DCR、授权端点和 `mail.read` / `mail.write` 权限。表单已准备，尚未提交持久连接。
- 尚未完成：当前账户内的 GptMail 应用注册与绑定、OAuth 连接，以及真实宿主中点击设置按钮和保存邮箱。

只有最后一项通过才可宣布“插件面板已修复”。不以命令行测试、单独打开 HTML 或新版压缩包替代这一验收。

## 固定密钥与 ChatGPT 连接的研究结论

本节区分三个能力：服务端接受固定密钥、面板收集密钥、ChatGPT 为后续 MCP 请求自动携带密钥。前两项不能证明第三项成立。

- [官方认证文档](https://developers.openai.com/plugins/build/auth#client-identification) 明确说明 ChatGPT 不能提供自定义 API Key。OAuth 完成后，ChatGPT 会在后续 MCP 请求中附加服务端签发的 access token。这里的限制属于客户端支持范围，不能据此说固定密钥本身不足以保护服务端。
- [插件打包文档](https://developers.openai.com/plugins/build/plugins) 的清单支持 `api_key` 声明；[提交文档的认证限制](https://developers.openai.com/plugins/deploy/submission#authentication-limitations) 同时说明连接表单没有 API Key 或 Bearer token 输入流程，声明本身不能完成连接。提交门户限制不能直接推广为所有 MCP 客户端的限制。
- 本地 MCP Apps SDK 的 `App.callServerTool` 接收工具名称、参数和请求控制选项，由宿主代理到原 MCP 服务；没有设置宿主 HTTP Authorization 或更换连接 URL 的公开接口。项目面板的 URL 字段目前用于生成客户端配置，不会改变已经建立的宿主连接。
- [UI 参考](https://developers.openai.com/plugins/reference) 支持通过 CSP 的 `connectDomains` 允许组件发起网络请求。组件直接携带密钥请求 API 在技术上属于另一条请求链路，不能让模型发起的 MCP 工具调用自动继承该密钥，也不能由此宣称多端配置已完成。

### 另一个有密钥配置交互的官方源码

检查了 [OpenAI Developers 插件源码](https://github.com/openai/plugins/tree/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/openai-developers)，固定提交 `0722921d5542fc593105c27bd52630babd8b8c2a`。其 `.mcp.json` 启动本地 Node stdio 服务；`mcp/server.mjs` 的 elicitation 表单确认本地密钥文件目的地，配套脚本将解密后的密钥保存到本地环境文件。这个例子有配置交互，但没有演示从插件面板设置 ChatGPT 云端 MCP 请求头，不能用来满足本项目不依赖本地连接的要求。

### 实测及结论边界

再次执行 `npx tsx --test test/http.test.ts`，3 项通过：缺失/错误密钥拒绝访问、正确 Bearer 请求头完成远程 MCP 初始化与工具调用、生成远程连接配置。测试使用模拟邮箱，不代表 ChatGPT 云端已接入。

当前证据支持：固定密钥接口可用，但未找到满足“ChatGPT 插件内配置、多端、模型调用受保护邮箱工具”的公开固定密钥接入路径。OAuth 在这里承担客户端凭据接入适配；设置面板本身并不以 OAuth 为必要条件。此前仅凭表单缺少密钥输入推断限制，依据不充分；本次已补充官方文档和 SDK 源码依据。

本轮仅补充研究记录，没有修改认证实现、提交 OAuth 连接或发布新插件版本。真实插件面板的端到端验收仍未完成。

## 2026-10-11 后续真实宿主验收

已完成托管应用注册、OAuth 连接及原插件的应用绑定，保持原插件身份和私有可见性。真实浏览器发现授权回调曾被 `form-action 'self'` 阻止；修复为同时允许经过验证的回调 origin 后完成连接。

网页宿主已加载的设置渲染代码对 `kind === "tool"` 且 `transport.type === "hosted"` 的控件返回 `null`。这解释了只注册设置工具按钮时出现空面板的原因，继续改按钮声明不能解决该宿主行为。已注册应用的“打开插件”可打开全局 MCP App，且已实测密钥验证和客户端连接设置保存成功；但这与 Gmail 原生账户管理不是同一入口。

随后实现一次性 OAuth 邮箱选择/添加表单及 `get_connection_profile`。从原插件“管理 → 使用的应用 → GptMail → 连接另一个账户/重新连接”已实际走到“连接一个邮箱”表单。每个新连接的邮件工具只访问选定邮箱；令牌续期保留稳定身份，删除邮箱使其令牌失效。测试覆盖双邮箱隔离、授权码一次性和加密存储，修复已部署。

原插件已发布 0.4.2 并回读确认应用绑定与原生入口说明。当前没有真实邮箱，仍待用户直接在授权表单填写凭据，才能验证 ChatGPT 账户名称显示和实际读信。不能将到达表单或模拟邮箱测试当成最终验收通过。
