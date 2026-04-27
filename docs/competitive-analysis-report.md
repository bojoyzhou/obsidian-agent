# Obsidian Agent 插件生态竞争分析 & 自查报告

> 生成时间：2026-04-27
> 我方仓库：`agent-client-multi-cli` v0.10.2-fork.1（fork 自 `RAIT-09/obsidian-agent-client`）
> 调研对象：9 个同类 Obsidian AI/Agent 插件 + 上游原始仓库

---

## 一、调研范围（9 个仓库 + 上游）

| 仓库 | Star | 定位 | 架构类型 | 与我们关系 |
|---|---:|---|---|---|
| **RAIT-09/obsidian-agent-client** | 1.8k | ACP 接入 Claude/Codex/Gemini | ACP 协议 | **上游原始仓库** |
| YishenTu/claudian | **9.3k** | Claude Code 嵌入 Obsidian | 私有 CLI 适配器 | 直接竞品，比上游星多 5× |
| logancyang/obsidian-copilot | 6.8k | 全能 AI 助手（BYOM） | RAG + Agent | 不同赛道 |
| brianpetro/obsidian-smart-connections | 4.9k | 语义搜索 + Chat | 本地 embedding | 不同赛道（专注 RAG） |
| khoj-ai/khoj | 34.3k | AI 第二大脑 | Python 服务端 | 半竞品 |
| nhaouari/obsidian-textgenerator-plugin | 1.9k | Prompt 模板驱动的生成 | 无 agent loop | 老一代 |
| infiolab/infio-copilot | 664 | Cursor 风格 AI | Chat + 自动补全 | 开源替代 copilot |
| jacksteamdev/obsidian-mcp-tools | 793 | MCP 桥接到 Claude Desktop | MCP 服务器 | **项目已停止维护** |
| kinghaonan/opensidian | 8 | OpenCode + MCP + Skills | MCP | 直接竞品（新，参考 Claudian） |

---

## 二、他们做得比我们好的设计（按价值排序）

### ⭐ 2.1 Claudian — 单词级 diff 预览 + 模式切换 UX（9.3k star 的关键所在）

Claudian 虽然和我们一样是 CLI agent 嵌入 Obsidian，但其 **「行内编辑 + 单词级 diff 预览」** 做到了本仓库没有的深度：

- **选中文本或光标定位 → 快捷键直接在笔记内编辑，预览单词级 diff**（我们虽然 `ToolCallBlock.tsx` 有 diff，但仅限 agent 给出的文件 diff，**不支持用户主动触发的原地编辑**）
- **Plan Mode 按 `Shift+Tab` 切换** —— 比我们的下拉菜单选模式更符合「键盘优先」的 Obsidian 用户习惯
- **`#` 指令模式** —— 把自定义指令从聊天里直接写入系统提示，区别于 `/` 命令
- **10 种语言的 i18n**（我们当前 0 种，全英文硬编码，见下面自查 §3.12）

**建议借鉴**：参考 Claudian 的 `features/inline-edit/` 模块做一个「选中笔记文本 → 描述修改 → 预览 diff → Apply/Discard」功能。这是 Obsidian 用户进入聊天前最缺的那一步。

---

### ⭐ 2.2 Claudian — 安全模式分级（YOLO / Safe / Plan）

Claudian 和 Opensidian 都引入了**三级安全模式**：

| 模式 | 行为 |
|---|---|
| YOLO | 所有工具调用无需确认 |
| Safe（推荐默认）| 只有危险操作（写文件、执行命令）才确认 |
| Plan | 所有操作都需确认，不自动执行 |

**我们当前**：只有全局 `autoAllowPermissions` 开关（一刀切），没有**按工具危险度分级**。这会导致：
- 开着自动允许时，连 `delete` 也会被自动执行 ⚠️
- 关着自动允许时，连 `read` 都要弹窗，频繁打扰

**建议**：在 `acp/permission-handler.ts` 里按 `ToolCall.kind` 做白名单分级：
- `read/search/fetch/think` → 安全类，Safe 模式自动允许
- `edit/execute` → 危险类，Safe 模式必须确认

---

### ⭐ 2.3 Obsidian-Copilot V3 — 「可选索引」架构（降低启动成本）

Obsidian-Copilot 在 V3 做了一个大胆的决定：**语义搜索索引从「必需」改为「可选」**。开箱即用时用关键词搜索，用户愿意付性能开销才启用 embedding。

**对我们的启示**：
- 当前 `vault-service.ts` 的 `searchNotes` 是 **fuzzy search** 已经不错；但 `@[[note]]` 提及体验如果加一层**语义相似度 rerank**，效果会提升很多
- 不需要自己训练 embedding——借鉴 Smart Connections 的思路，直接让用户**可选**接入他们的 Smart Environment（共享本地嵌入）

---

### ⭐ 2.4 Claudian — 文件存储的清晰分层

Claudian 的存储布局非常专业：

```
vault/.claudian/    ← 插件自身设置与会话元数据
vault/.claude/      ← Claude 相关文件（可与 CLI 共享）
~/.claude/projects/ ← CLI 原生对话记录
~/.codex/sessions/  ← Codex 原生对话记录
```

**我们当前**：会话元数据塞在 `plugin settings`（单一的 data.json），消息历史在 `plugins/agent-client/sessions/*.json`。混合度高，单一 `data.json` 里很快就会塞进去 50 个 session 的元数据（见 `session-storage.ts` 中 `MAX_SAVED_SESSIONS = 50`）。

**建议**：把 `savedSessions` 元数据也独立成 `plugins/agent-client/sessions/index.json` 文件，减轻 `data.json` 的体积和写入频率。

---

### ⭐ 2.5 Smart Connections — 「零依赖」审计友好度

Smart Connections 的作者公开宣称：**比同类 AI 插件容易审计 3 倍以上**，因为几乎所有代码来自单一来源，零第三方依赖。

**我们当前的依赖**（package.json）：
```
@agentclientprotocol/sdk ^0.14.1
@codemirror/state 6.5.0
@codemirror/view ^6.35.0
@tanstack/react-virtual ^3.13.23
diff ^8.0.2
react / react-dom ^19.1.1
semver ^7.7.3
```

React + @tanstack/react-virtual 是刚需，难以去除。但可以考虑：
- `semver` → 用内联的 20 行手写函数替代（只需要 `satisfies` 检查）
- `diff` → ToolCallBlock 已有 word-level diff，可自研

降低依赖意味着供应链攻击面更小。上游的 `obsidian-mcp-tools` 已因「AI 生成 PR 审计压力」停止维护 —— 这是所有依赖分发二进制的插件共同的问题。

---

### ⭐ 2.6 Opensidian — 工具调用折叠 + MCP/Skill 选择器

Opensidian（只 8 star 但设计思路新颖）：
- **工具调用默认折叠**：长长的 tool call 序列用可折叠块隐藏，只显示摘要。他们有一个明确的折叠组件
- **MCP/Skill 选择器**：`@` 引用时可以搜索、筛选、分组显示已启用的工具，**选中即成为对模型调用工具的强提示**

**我们当前**：
- `MessageBubble.tsx` **已经有** `isExplorationToolCall` 的折叠逻辑（见 362-393 行），把 read/search/fetch/think 类工具调用折叠起来 ✅
- 但**没有**让用户在输入阶段主动挑选 "我想让 agent 用哪些工具"。这个 UX 是 Opensidian 的亮点

**建议**：把 `configOptions` API（ACP 层已支持）扩展出一个「工具启用开关」的 sub-category，让用户可以关掉某些危险工具。

---

### ⭐ 2.7 Infio-Copilot — PgLite 做 session/向量存储

Infio-Copilot 用 **PgLite**（浏览器端的 SQLite/PostgreSQL）做 session 与向量存储。

**我们当前**：纯 JSON 文件读写，每次 turn 结束都**全量重写整个 session 文件**（见 `session-storage.ts:181-206` `saveSessionMessages`）。这就是上游 issue #180 提到的第 7 个性能瓶颈「会话持久化写入完整对话」。

**进一步的问题**：我们在 `useSessionHistory.ts:802-813` 的 `saveSessionMessages` 是 fire-and-forget，但**没有防抖**——意味着连续多条 tool_call_update 过来、每次 turn 结束都会完整重写一次 50k 字符的 JSON 文件。

**建议**：
- 简单方案：给 `saveSessionMessages` 套一层 500ms 防抖（跟 FloatingButton 保存位置那样）
- 激进方案：改成「append-only」格式（每个 turn 一行 JSON），只在导出时合并

---

## 三、对照上游 & 同类 Issues — 我们仓库的自查结果

> 审计范围：上游近期 20 个 issue + PR，逐条对照我们的代码是否已经修复。

### 3.1 ✅ Stop 后残留状态（对应上游 #200 + PR #230）

**上游状态**：Open 未合并，有 PR 待 review
**我方状态**：**已独立修复，且实现更完善**

证据（`src/hooks/useAgentMessages.ts`）：
```160:172:src/hooks/useAgentMessages.ts
const CANCEL_GRACE_MS = 1500;
const STREAMING_UPDATE_TYPES = new Set<SessionUpdate["type"]>([
	"agent_message_chunk",
	"agent_thought_chunk",
	"user_message_chunk",
	"tool_call",
	"tool_call_update",
]);
```

我们用 **1500ms "cancel grace window" + `sendAborted` + 清空 pending streaming updates** 三重保护，代码注释明确提到「upstream issue #155」，说明是自己踩坑修复的。再次送 prompt 时 `targetSlot.cancelledAt = null` 复位（行 549），完全覆盖 Tim-Devil 报告的场景。

**结论**：这一块我们反而比上游更成熟，可以考虑**反向贡献 PR 给上游**。

---

### 3.2 ⚠️ Vault-local 链接处理（对应 #208）

**上游状态**：Closed（4-7 修复）
**我方状态**：**部分修复，仍有缺口**

我们的 `MarkdownRenderer.tsx` 处理了：
- ✅ `a.internal-link`（Obsidian wikilink）+ WSL 路径转换
- ✅ 纯文本里自动识别 `foo/bar.md` 样式加 `agent-client-text-path-link`

**但没处理**：标准 Markdown 链接 `[text](path/to/file.md)` 形式。ObsidianMarkdownRenderer 渲染出的这类 `<a>` 没有 `.internal-link` class，会**穿透我们的拦截器，被 Obsidian 默认行为打开空白标签**——正是 #208 的原版 bug。

**修复建议**：在 `MarkdownRenderer.tsx` 的 `handleClick`（第 144 行起）加一个新分支：

```144:src/ui/shared/MarkdownRenderer.tsx
// 在 pathLink 分支和 internal-link 分支之间加：
const plainLink = target.closest("a") as HTMLAnchorElement | null;
if (plainLink && !plainLink.classList.contains("internal-link")
    && !plainLink.classList.contains(PATH_LINK_CLASS)) {
    const href = plainLink.getAttribute("href");
    if (href && href !== "#") {
        // 尝试判断是否为 vault 路径（处理 WSL /mnt/c/ → Windows 格式）
        let candidate = decodeURIComponent(href);
        if (isWslMode && candidate.startsWith("/mnt/")) {
            candidate = convertWslPathToWindows(candidate);
        }
        const normalized = candidate.replace(/\\/g, "/");
        if (normalizedVaultBase && normalized.startsWith(normalizedVaultBase + "/")) {
            e.preventDefault();
            const rel = normalized.slice(normalizedVaultBase.length + 1);
            void plugin.app.workspace.openLinkText(rel, "");
            return;
        }
    }
}
```

---

### 3.3 ✅ 长会话性能（对应 #180 + PR #185）

**上游状态**：Open（PR #185 已合，但 #180 仍 open，有后续优化空间）
**我方状态**：**六大优化已全部到位**

| 优化 | 我们 | 证据 |
|---|---|---|
| React.memo 包裹 MessageBubble/ToolCallBlock/TerminalBlock | ✅ | `MessageBubble.tsx:602`, `ToolCallBlock.tsx:25`, `TerminalBlock.tsx:12` |
| RAF batching for streaming | ✅ | `useAgentMessages.ts:324-329` |
| 虚拟化列表（`@tanstack/react-virtual`）| ✅ | `MessageList.tsx:73-78` |
| O(1) tool call 索引（`Map<string, number>`） | ✅ | `useAgentMessages.ts:114`, `message-state.ts:181-209` |
| 用户滚上去时不强行拽回底部 | ✅ | `MessageList.tsx:86-87` |
| 持久化防抖 | ❌ | **见下文 3.3.1** |

#### 3.3.1 ⚠️ 唯一剩下的性能缺口：会话持久化未防抖

`useSessionHistory.ts:798-813` 的 `saveSessionMessages` 被 `onSessionTurnEnd` 回调无防抖触发，每次 turn 结束立刻全量重写 JSON 文件。对应 issue #180 作者 femto 列出的**第 7 个瓶颈**。

**修复建议**（最小代价版）：

```800:src/hooks/useSessionHistory.ts
// 改成：
const saveTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
const saveSessionMessages = useCallback((sessionId, messages) => {
    if (!session.agentId || messages.length === 0) return;
    const existing = saveTimerRef.current.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        void settingsAccess.saveSessionMessages(sessionId, session.agentId, messages);
        saveTimerRef.current.delete(sessionId);
    }, 500);
    saveTimerRef.current.set(sessionId, timer);
}, [session.agentId, settingsAccess]);
```

---

### 3.4 ⚠️ 密钥存储安全 & 日志泄漏（对应上游 PR #219 Harden secret storage）

**上游状态**：已合并（4-14，版本 0.10.0）
**我方状态**：**部分 OK，但 debug 日志有泄露风险**

**已做对**：
- ✅ API key 在 SettingsTab 里 `inputEl.type = "password"`（见 `SettingsTab.ts:861/934/1010`）
- ✅ key 不会直接写进 system prompt，只通过环境变量注入（`session-helpers.ts:143-170`）

**潜在问题**：
1. **明文存储在 data.json**：Settings 的描述里确实标注了「(Stored as plain text)」（`SettingsTab.ts:902, 927`），用户已被告知，可接受。但**上游 PR #219 可能加强了这点**，建议同步看一下代码。

2. **Debug 日志泄漏** ⚠️：`acp-client.ts:154-157` 在 debug 模式下会打印整个 `config` 对象：
   ```154:157:src/acp/acp-client.ts
   this.logger.log(
       "[AcpClient] Starting initialization with config:",
       config,
   );
   ```
   而 `config.env` 里含有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`。虽然 logger 受 `debugMode` 保护（`logger.ts:22`），但如果用户打开 debug 后截图，就会泄漏 API Key。

   **建议**：打印 config 前脱敏：
   ```ts
   const redacted = { ...config, env: redactEnv(config.env) };
   function redactEnv(env?: Record<string, string>) {
       if (!env) return env;
       return Object.fromEntries(Object.entries(env).map(
           ([k, v]) => [k, /key|token|secret/i.test(k) ? "***" : v]
       ));
   }
   ```

---

### 3.5 ✅ nvm / login shell（对应上游 PR #214）

**上游状态**：已合并（4-10）
**我方状态**：**已同步，处理完善**

证据（`src/utils/platform.ts:374-396`）：macOS/Linux 分支显式用 `-l -c`（login shell）启动，并在 `nodeDir` 存在时注入 PATH。与上游 PR #214 的修复路径一致。

**追加保险**：`getLoginShell()`（行 32-37）优先读取 `$SHELL` env，fallback 到 `/bin/zsh`（macOS）或 `/bin/sh`（Linux），兼容 NixOS 等非标准环境。

---

### 3.6 ❌ 数学公式渲染（对应上游 PR #218）

**上游状态**：已合并（4-15）
**我方状态**：**未明确处理**

我们在 `MarkdownRenderer.tsx` 直接调用 `ObsidianMarkdownRenderer.render()`，理论上 Obsidian 内置会处理 `$...$` 和 `$$...$$`。但上游 PR #218 明确说要「fix math formula rendering in chat messages」说明 Obsidian 默认渲染在 chat 上下文里有问题（可能是 MathJax 没被注入某些容器）。

**建议**：拉取上游 PR #218 的 diff 看一下具体改动，判断是否需要同步。最简单的验证方法：手动发一条包含 `$E=mc^2$` 的消息看渲染是否正常。

---

### 3.7 ✅ 宽 Markdown 横向滚动（对应上游 PR #190）

**上游状态**：已合并（3-27）
**我方状态**：**已同步**

证据（`styles.css:1463-1469`）：
```css
.agent-client-markdown-text-renderer.markdown-rendered pre,
.agent-client-markdown-text-renderer.markdown-rendered table,
.agent-client-markdown-text-renderer.markdown-rendered .mermaid,
.agent-client-markdown-text-renderer.markdown-rendered svg {
    overflow-x: auto;
    display: block;
}
```

---

### 3.8 ✅ Context window 使用量（对应上游 PR #143）

**上游状态**：已合并（3-1）
**我方状态**：**已同步，UX 更好**

我们在 `InputToolbar.tsx:290-304` 实现了颜色分级指示器：
- 70%+ caution, 80%+ warning, 90%+ danger
- tooltip 同时显示 used/size tokens 和成本（$）

---

### 3.9 ✅ resource_link 非图片附件（对应上游 PR #144）

**上游状态**：已合并（3-1）
**我方状态**：**已同步**

`message-sender.ts`, `useAgentMessages.ts`, `type-converter.ts`, `chat-exporter.ts` 都处理了 `resource_link` 类型。拖拽/粘贴非图片文件时走 resource_link 路径（`InputArea.tsx:488-492, 552-557`）。

---

### 3.10 ✅ configOptions API（对应上游 PR #138）

**上游状态**：已合并（2-28）
**我方状态**：**已同步**

`ConfigOptionUpdate` 类型（`session.ts:438-441`）+ `setSessionConfigOption` ACP 调用（`acp-client.ts:740-762`）+ hooks `setConfigOption`（`useAgentSession.ts:483-545`）+ 乐观更新回滚（537-545 行），实现完整。且 legacy mode/model 有独立的 deprecation 路径。

---

### 3.11 ✅ 自动滚动不覆盖用户手动滚动（对应 commit e03d1f0）

**上游状态**：已合并
**我方状态**：**已同步**

`MessageList.tsx:86-87`：
```ts
virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () =>
    isAtBottomRef.current;
```
用 `isAtBottomRef` 判断，用户手动滚上去后流式更新不会拽回底部。

---

### 3.12 ❌ i18n 国际化

**同类插件**：
- Claudian：10 种语言（`src/i18n/`）
- Opensidian：中/英/日/韩
- 上游 issue #215：有用户专门提

**我方状态**：**零 i18n，全英文硬编码**

全文只有 3 处 `toLocaleString/toLocaleTimeString`（格式化时间），没有 `t()` 翻译函数。错误信息、按钮文本、Tooltip 全部硬编码。

**建议**：
- **P2 优先级**（英文用户不受影响，但中文用户体验差）
- 参考 Claudian 的 `src/i18n/` 实现：一个 `messages.zh.ts` + 一个 `t(key)` 函数，用 Obsidian 的 `moment.locale()` 判断当前语言

---

### 3.13 ⚠️ 其他 issue 反查

| Issue | 主题 | 我方情况 |
|---|---|---|
| #194 | opencode 模型列表不更新（snap 沙箱问题） | 非我们代码问题，Linux 用户文档应提醒用 deb 版 Obsidian |
| #226 | Custom Agent skills 加载不出来 | 我们只能被动转发 agent 上报的 slash 命令，无解 |
| #227 | Gemini subagent 不能请求权限 | 非插件问题，Gemini CLI 上游问题 |
| #217 | 希望支持 `/clear` | 同上，应去 claude-agent-acp 提 |
| #209 | opencode 1.3.15 消息重复 + @[[]] 原样显示 | **需警惕**：虽然是 opencode 上游 bug，但我们应在 `useAgentMessages.ts` 里检查 `user_message_chunk` 是否在当前 turn 已经本地 echo 过——避免 duplicate |
| #223 | WSL distribution 名含点号 | 我们 `platform.ts:274` 的正则 `/^[a-zA-Z0-9._-]+$/` 已允许 `.`，✅ |
| #229 | 长模型列表加搜索过滤 | 我们当前是普通 `<select>`，无搜索。**建议加** |
| #232 | Tabbed multi-session（内部多标签） | 大需求，但工程量大。可作为 roadmap |
| #222 | Embeddable Agent Code Blocks（在笔记里嵌入 agent）| 创新方向，可参考 |

---

## 四、关键共性问题模式（跨 9 个仓库的共振痛点）

### 4.1 🔥 外部 CLI/Agent 版本升级 → 静默失效

同一模式在 4 个仓库都出现：
- `RAIT-09#194`（opencode 模型列表）、`#209`（opencode user_message_chunk 错乱）、`#233`（Claude Code 静默失败）
- `copilot#2361`（claude-opus-4-7 thinking.type.enabled）
- `smart-connections#1316`（embedding 模型加载）
- `mcp-tools#68`（Local REST API 版本不匹配）

**通病根因**：插件依赖外部服务/二进制的内部协议，一旦对方小版本升级就崩。

**我方防御策略（建议补强）**：
1. **启动时探测版本并记录**：`acp-client.ts` 在 spawn 后记录 agent 输出的 `protocolVersion`，与 SDK 支持的版本对比，不匹配时立即给用户清晰错误
2. **给 `@agentclientprotocol/sdk ^0.14.1` 加 `peerDependenciesMeta` 风险提示**
3. 在 Settings 里加「版本诊断」按钮，一键打印所有依赖 CLI 的 `--version`

### 4.2 🔥 连接失败没有明确错误（issue #233）

**通病**：用户点了 "Start chat" 后没反应，也没 toast/banner。

**我方情况**：
- `acp-client.ts:522-532` 有 `PROMPT_IDLE_TIMEOUT_MS`（说明 prompt 阶段有超时）
- 但 **initialize / newSession 阶段**的超时处理需要确认（查看 `withTimeout` 的使用范围）
- ErrorBanner 组件存在，但是否所有失败路径都会路由到它？

**建议**：写一个 e2e checklist：「把 `claude.command` 改成 `/not/exist/fake-claude`，打开 chat panel，应立即在 15s 内看到 ErrorBanner 显示 'Command not found'」——测一遍所有 agent。

### 4.3 🔥 长会话性能退化（所有 chat 类插件共性）

我们已经做得不错（3.3 节有 6/7 项优化），但 **Chat session 持久化防抖** 是漏网之鱼。

### 4.4 🔥 跨平台 shell/环境变量不一致

- `RAIT-09#213`（nvm 环境）
- 我方已同步修复
- 但 **snap Obsidian**（`#194`）、**AppImage Obsidian**、**WSL 混合路径**（`#208`）还有长尾问题

**建议**：文档里增加「已知不兼容场景」清单。

### 4.5 🔥 MCP/工具生态碎片化

- `mcp-tools` 已停止维护
- 每个 CLI 对 slash 命令/skills/tool 的暴露方式都不同（`#226`）

**战略观察**：**ACP 协议本身的抽象程度还不够**——不同 CLI 在 "skills" 这一层的表达差异，SDK 没统一。如果我们想做得比 Claudian 好，可以尝试在插件层做一层「normalize」。

---

## 五、优先级行动清单

### 🔴 P0 - 建议本周内处理

1. **修复 `MarkdownRenderer.tsx` 标准 Markdown link 处理**（3.2）—— 不然 agent 回复里给的 Markdown 链接在我们这里永远打不开
2. **给 `saveSessionMessages` 加 500ms 防抖**（3.3.1）—— 长会话的最后一个性能短板
3. **Debug 日志里脱敏 API Key**（3.4）—— 安全隐患

### 🟡 P1 - 2 周内

4. **对齐上游 PR #219 Harden secret storage**（3.4）—— 拉具体 diff 研究
5. **验证 & 补齐数学公式渲染**（3.6）
6. **模型下拉加搜索过滤**（#229）—— 只需 30 行代码
7. **启动时协议版本探测 + 不匹配清晰报错**（4.1）

### 🟢 P2 - 月度级别

8. **Safe/Plan/YOLO 三级权限模式**（2.2）—— 大大降低用户不安全感
9. **i18n 中文支持**（3.12）—— 参考 Claudian
10. **session 元数据独立成 index.json**（2.4）
11. **Inline Edit（行内编辑 + word-diff 预览）**（2.1）—— 这是能让我们接近 Claudian 9.3k star 的那个杀手级功能

### 🔵 P3 - Roadmap

12. **Tabbed multi-session**（#232）
13. **Embeddable Agent Code Blocks**（#222）
14. **MCP/Skill 选择器 UI**（2.6）

---

## 六、策略性观察：我们在生态中的位置

| 维度 | 我方现状 | 最强竞品 |
|---|---|---|
| Star 数 | fork 未发布 | Claudian 9.3k / Copilot 6.8k |
| 架构成熟度 | ✅ 性能优化到位、cancel 处理反超上游 | 与 Claudian 持平 |
| 功能广度（多 Agent）| ✅ 7 种 CLI 预设（Qoder/CodeBuddy/Qwen/OpenCode 等）| 强于 Claudian（只支持 Claude/Codex）|
| UX 打磨 | ⚠️ 权限分级、i18n、inline-edit 缺失 | Claudian、Opensidian 已做 |
| 安全性 | ⚠️ debug 日志泄漏风险 | SmartConnections 零依赖、Claudian 脱敏 |
| 文档/社区 | ❓ 仅 fork README | Copilot/Claudian 有官网 + Discord |

**核心判断**：我方代码质量**架构层面已经很扎实**（虚拟化、RAF batching、session 隔离、cancel 清理都做对了），真正的差距在**产品侧**——权限 UX、国际化、行内编辑这三件事如果能补上，技术上有望追近 Claudian。

但另一方面，我们的 **「多 CLI 预设」差异化** 是上游和 Claudian 都没有的。这是值得继续强化的点：**定位成「所有 ACP agent 的统一入口」**，而不是跟 Claudian 在 Claude-only 赛道硬拼。

---

## 附录：本次调研的 Issue 抽样清单

共查询 20+ 个上游 issue/PR、12 个 copilot issue、12 个 smart-connections issue、20 个 mcp-tools issue。重点分析的 Issue：

- RAIT-09: #180（性能）, #200（Stop 残留）, #208（链接）, #209（重复消息）, #213（nvm）, #217（/clear）, #226（skills）, #227（Gemini 权限）, #229（模型搜索）, #233（静默失败）
- 上游 PR: #138/143/144/145（功能）, #185（性能）, #190/218（UI fix）, #214（shell）, #219（安全）, #230（Stop fix 待合并）
- copilot: #2333/2329（LMStudio）, #2361（Claude bug）, #2365（冻结）
- smart-connections: #1316/1320/1329（模型加载）, #1319（git sync）
- mcp-tools: #71/78/83（patch_vault_file bugs）, #66/67（端口硬编码）, #79（项目停维护）
