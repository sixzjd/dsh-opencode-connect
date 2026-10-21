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
# 从 GitHub 安装
dsh plugin --profile web add github:sixzjd/dsh-opencode-connect

# 或本地目录（开发用，link: 是活符号链接）
dsh plugin --profile web add "link:/绝对路径/dsh-opencode-connect"
```

装好后新开一个 DSH 会话，模型选择器出现 **OpenCode Zen** 分组。设置 → 插件设置 → "OpenCode 连接器"卡片可：

- 粘贴你自己的 Zen API Key（留空 = 匿名免费池）；
- 查看模型目录来源（实时 / 上次保存 / 内置）并手动刷新；
- 开关单个模型（关闭的模型从选择器隐藏）。

## 须知

- 免费池按 IP 限流、共享池位，高峰期会 429（插件会自动换模型重试）；
- 这是对上游明示限制的绕过，官方不支持（anomalyco/opencode#42500 被 closed as not planned），门闸随时可能收紧导致失效；
- 插件数据（key、目录缓存）都在 `<profile>/.dsh-opencode-connect/` 一个目录里。

MIT
