# DSH OpenCode Connect（OpenCode 连接器）

把 **OpenCode Zen** 的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（DSH）的社区插件，包括 Zen 的**限时免费模型池**（`*-free`、`big-pickle` 等，无需余额）。

## 原理

Zen 的免费层只放行"真正的 opencode 客户端"：请求必须携带

- `User-Agent: opencode/<版本>`（自动跟随 npm 上的 opencode 发版刷新）；
- `x-opencode-session` 与 `x-opencode-session-id` 成对出现，且 id 必须是 opencode 自家格式（前 12 位 hex 可解码为时间戳）；
- 工具清单里存在名为 `read` 的工具，并且是流式请求。

DSH 的普通配置层无法伪造这些（`user-agent` 是 DSH 的保留归因头，会被剥掉），所以插件在进程内起一个 **loopback shim**：pi-ai 对 shim 说标准 OpenAI Chat Completions，shim 对 Zen 说"opencode"。dsh 的真实 agent 轮次自带 `read` 工具，天然过闸；标题生成等无工具请求由 shim 注入最小 `read` + `tool_choice:"none"`，并把模型偶尔返回的工具调用剥掉。免费池 429/5xx/模型下架时，shim 沿已启用目录自动 fallback 到下一个模型。

架构与 [dsh-qoder-connect](https://github.com/masknull/dsh-qoder-connect) 同源（loopback shim + 进程内注册 provider + 卡片管理），伪装逻辑与 [zen-proxy](https://github.com/12errh/zen-proxy) 同源，但作为 DSH 插件运行：**无需外部进程、无需改配置文件**。

## 安装

```sh
# 从 GitHub 安装（必须带 github: 前缀，见下方「包名撞车」）
dsh plugin --profile web add github:sixzjd/dsh-opencode-connect#<commit>

# 或本地目录（开发用，link: 是活符号链接）
dsh plugin --profile web add "link:/绝对路径/dsh-opencode-connect"
```

装好后新开一个 DSH 会话，模型选择器出现 **OpenCode Zen** 分组。设置 → 插件设置 → "OpenCode 连接器"卡片可：

- 粘贴你自己的 Zen API Key（留空 = 匿名免费池）；
- 查看模型目录来源（实时 / 上次保存 / 内置）并手动刷新；
- 开关单个模型（关闭的模型从选择器隐藏）。

## 须知

- **包名撞车**：npm 上的 `dsh-opencode-connect` 是另一个人的独立项目（`sanser9`），不是本仓库。
  本仓库没有发布到 npm，也**不要执行 `npm publish`**（会直接撞名失败）。安装一律用
  `github:sixzjd/dsh-opencode-connect#<commit>`，并钉住 commit 以便复现。
- **免费池是每日额度**：实测 2026-11-08，池子耗尽时每个免费模型都回 `429 / FreeUsageLimitError`，
  `retry-after` 指向次日 UTC 零点（北京时间 08:00），但 `/models` 仍然 200。插件会把这句话翻成
  「免费池今日额度已用尽，约 X 重置」，而不是转述上游那句「请订阅 OpenCode Go」。
- **付费模型不进匿名候选链**：带 `cost.input.price > 0` 的模型只有当用户自己填了 API Key 时才参与
  fallback。否则一旦被走到，它回的 `402 Insufficient account funds` 会把免费池真正的失败原因盖掉
  ——「我要的是免费模型，为什么提示我余额不足」就是这么来的。
- **点名即尊重**：用户显式请求的模型即使没有 key 也会被尝试一次，插件不替用户的账户做判断。
- 免费池按 IP 限流、共享池位，高峰期会 429（插件会自动换模型重试）；
- 这是对上游明示限制的绕过，官方不支持（anomalyco/opencode#42500 被 closed as not planned），门闸随时可能收紧导致失效；
- 插件数据（key、目录缓存）都在 `<profile>/.dsh-opencode-connect/` 一个目录里。
- 内置兜底清单是**实测**捕获的（2026-11-08 的 11 个免费模型），并按上下文窗口降序排列——fallback 按
  顺序走，把窗口小的排前面会让长对话先撞一圈小窗口。`node test/smoke.mjs` 会校验这份清单仍然
  只含免费模型、覆盖整个免费池、并且顺序正确。

MIT
