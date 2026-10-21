# DSH + 免费模型渠道 踩坑记录

在 Windows / 中国大陆网络环境下，用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 搭配社区插件 `dsh-our-free-model` 接入免费模型时，遇到并定位的几个问题。所有结论都附实测证据与可复现脚本。

> 本文只记录**现象与定位方法**，不提供规避上游服务条款的手段。若你是渠道提供方或插件作者，欢迎据此修复。

---

## 结论速查

| # | 现象 | 根因 | 是否可本地修复 |
|---|---|---|---|
| 1 | 插件"装了但没生效"：设置页能打开，模型选择器却没有它的模型 | profile 的 `dsh.profile.bundles` 被重置，只剩 `dsh-base` / `dsh-web-app`，插件包在 `node_modules` 里但没参与配置合成 | ✅ 加回 bundles 并重启 |
| 2 | 免费车道可用度 0/9，全部 `region-blocked` 或 `The free tier can only be used from within OpenCode` | 上游把第三方调用判为不合法 | ❌ 上游行为 |
| 3 | 安装 npm 上的版本后免费车道仍 0/9 | npm 最新是 `2.1.0`，GitHub 已到 `v2.5.1`，新版才修了上游适配 | ✅ 换 GitHub tag |
| 4 | 切到 CodeBuddy（`buddy`）的 `hy3` / `hy3-x`，聊天报 `请求被拦截，请重新发送 Illegal API invocation from an unapproved channel` / `INVALID_REQUEST` | 腾讯网关**内容级**风控：`system` 消息里出现特定字面量即返回 `400 / code 11128` | ❌ 见下文 |

---

## 问题 4 的定位过程（本文重点）

### 现象

- 同一账号、同一端点，换个模型（`hy3` → `hy3-x`）依旧被拦。
- 客户端只显示 `INVALID_REQUEST reason=unknown`，看不到上游原文。

### 方法：直接对上游做 A/B

用本机凭据向同一端点发两次**最小请求**，只改 `system`：

| | `system` 内容 | 结果 |
|---|---|---|
| A | `You are a helpful assistant.` | **HTTP 200**（950ms，模型正常流式回包） |
| B | DSH 实际发出的 system 提示词（5817 字符） | **HTTP 400 / `code 11128` `Illegal API invocation from an unapproved channel`** |

结论：**账号、token、端点、请求头全部正常**，问题在请求内容。

> 注意两个易踩的坑：
> - 该端点**只接受流式请求**（`stream: true`），否则返回 `11101 Non-stream chat request is currently not supported`，容易误判成鉴权失败。
> - 必须带 `X-Product-Code: codebuddy`、`X-Domain: <凭据里的 domain>`、`User-Agent: CodeBuddyIDE/<version>`。

### 方法：二分定位到具体句子

把 system 按空行切段（本例 18 段），对"前 N 段"做二分探测，**5 次请求**即收敛到第 1 段（48 字符）：

```
You are an AI agent powered by DeepSeek Harness.
```

### 方法：变体矩阵确认判定方式

| 变体 | 结果 |
|---|---|
| 原句（带句号） | **BLOCK 11128** |
| 原句（不带句号） | **BLOCK 11128** |
| 全小写 | **BLOCK 11128** |
| `…running on DeepSeek Harness.`（换动词） | ALLOW 200 |
| `…powered by Acme Harness.`（换产品名） | ALLOW 200 |
| `你是一个由 DeepSeek Harness 驱动的 AI 代理。`（中文） | ALLOW 200 |
| 只写 `powered by DeepSeek Harness` | ALLOW 200 |

即：上游按**大小写不敏感的精确字面量**匹配，需要包含完整句式；改写任意一词即可通过。被拦的请求**不消耗额度**。

### 为什么换模型无效、为什么"别的机器能通"

拦截发生在**内容层**，早于模型选择，所以同渠道下换 `hy3` / `hy3-x` 结果一致。
同理，若另一台机器发出的 system 不含这句完整字面量（不同客户端、不同版本），就会正常放行 —— 这与账号无关。

### 建议

- 对插件作者：该渠道的风控名单在服务端，随时会更新；建议按既有 `CONTENT_FINGERPRINTS` 机制补充条目并加回归用例。
- 对使用者：这条渠道当前对 DSH 不可用，改用官方 API 或其他渠道；不建议做提示词伪装去规避上游风控。

---

## 问题 1 / 3 的操作细节

### 插件已安装但未生效

```powershell
# 症状：网关端口没监听（插件自己的 HTTP 网关默认 8326）
Test-NetConnection 127.0.0.1 -Port 8326 -InformationLevel Quiet   # -> False

# 原因：profile 的 bundles 列表里没有它
Get-Content "$env:DSH_PROFILE_DIR\package.json"
```

修复：把包名加进 `dsh.profile.bundles`，然后**重启 DSH**（新增 bundle 行不会被热重载捕获，`patchReload: live` 只对已存在行的 config 变更生效）。

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-our-free-model"
  ] } }
}
```

### 版本坑

| 来源 | 版本 |
|---|---|
| `registry.npmjs.org/dsh-our-free-model` | `2.1.0`（旧） |
| GitHub `Ebony-Vinyl/dsh-our-free-model` tag | `v2.5.1`（新，含上游适配） |

升级前免费车道 9 个模型全部不可用；升级后 5 个可用（`mimo-v2.6-flash-free`、`longcat-2.5-preview-free`、`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`、`space-bunny-free`）。

---

## 脚本

需要 Node 18+，只读本机 DSH 凭据，**不会**把 token 打印到终端。

```bash
# 1) 指纹矩阵：确认哪些 system 写法被上游拦
node scripts/fingerprint-matrix.mjs

# 2) 二分定位：在你自己的 system 提示词里找出触发段
node scripts/bisect-system-prompt.mjs
```

前置条件：

- 已安装 DSH 与 `dsh-our-free-model`，并登录过 CodeBuddy 账号（凭据在 `~/.dsh/.credentials.yaml`）。
- 环境变量 `DSH_HOME` 默认 `~/.dsh`；如需改路径，设置 `DSH_HOME`。

请仅对自己的账号使用，请求均为 `max_tokens: 16` 的最小探测。

---

## 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 (19041) |
| Node | v22.12.0 |
| DSH | 0.2.0-rc.2 |
| dsh-our-free-model | 2.5.1 |
| 网络 | 中国大陆，直连 |

## License

MIT
