# opencode 深度架构分析报告

**仓库**:`~/ccc/agent-research/opencode`(commit `9b0dd36`)

**前提澄清**:当前仓库已无任何 Go 代码。opencode 历史上曾是 Go + TS 混合,如今已完全迁移为 **TypeScript 单体(Bun monorepo)**,并全面构建在 **Effect-TS 生态**(Effect/Stream/Schema/Layer)之上。

## 1. 总体架构:client/server 分离与多客户端共享

核心包分工:

| 包 | 职责 |
|---|---|
| `packages/opencode` | 主 CLI 入口 + **v1 运行时**(session/tool/provider/server) |
| `packages/core` | **v2 运行时重构**(system-context、Context Epoch,见 `CONTEXT.md`) |
| `packages/server`、`packages/client` | HTTP 服务基建与生成的 Effect client |
| `packages/sdk/js` | 面向公众的 JS SDK(`@opencode-ai/sdk`) |
| `packages/tui`、`packages/desktop`、`packages/app` | 三类客户端 |

- **Server 是单例宿主**:基于 Effect `HttpApi` 构建路由(`packages/opencode/src/server/server.ts:56-114`),支持 **mDNS 局域网发布**(`server.ts:155-170`)——同网段的桌面端/移动端可以直接发现并连接。
- **TUI 是纯客户端**:通过 SDK 连接 server,所有状态经事件流同步。
- **Desktop(Electron)以 sidecar 方式拉起 server**;`opencode attach` 支持连接远端目录的实例。
- OpenAPI spec 由 Effect OpenApi 从代码生成(`server.ts:67-69`),API/SDK/文档三者同源。

## 2. Server 核心:session 管理与消息数据模型

- **消息/部分(parts)模型**是脊柱:一条 `Message`(user/assistant)挂多个强类型 `Part`:`text`、`reasoning`、`tool`、`step-start`、`step-finish`、`patch`、`file`、`subtask`、`compaction`、`snapshot`;流式输出以 `PartDelta` 事件增量下发(`session/session.ts:877-885`)。
- **存储层是 SQLite + drizzle-orm**:`SessionTable/MessageTable/PartTable/TodoTable/SessionMessageTable/SessionContextEpochTable`(`packages/core/src/session/sql.ts`),part 载荷序列化进 `data` 列;分页用 base64url cursor。
- Session 生命周期 API:`fork`(克隆消息并重映射 ID,`session.ts:691-732`)、父子 session、归档/分享。

## 3. Agent 循环:loop、工具执行与事件总线

主循环在 `packages/opencode/src/session/prompt.ts:1081-1341`(`runLoop`),`while(true)` 结构:

1. 读取历史并过滤已压缩消息;
2. 依据最后一条 assistant 的 `finish` 与是否存在未执行 tool call 决定退出;
3. 首步 fork 生成会话标题(小模型);
4. 分派特殊任务:`subtask`(子 agent)与 `compaction`;token 超限自动压缩;
5. 注入提醒(`SessionReminders.apply`)、组装 system、解析工具集,调用 `processor.process()`;步数达上限注入 `MAX_STEPS_PROMPT` 强制收尾。

**Processor** 把 LLM 事件流折叠为持久化 parts:tool part 状态机 `pending→running→completed/error`;`step-finish` 时落 usage/cost、生成文件快照 patch part 并检查溢出;返回三态 `Result = "compact" | "stop" | "continue"` 驱动外层循环。**doom loop 防护**:连续 3 次相同工具+相同参数触发权限询问(`processor.ts:29,356-380`)。

**LLM 双运行时 seam**:默认 AI SDK `streamText`,实验性 native 运行时可返回 `@opencode-ai/llm` 的 `LLMEvent` 流,失败自动回落;内置坏工具调用的自动修复(小写名匹配/转投 `invalid` 工具,`llm.ts:296-312`)。

**事件总线**:领域事件经 `EventV2Bridge` 发布并自动附加 location 路由信息,再汇入进程级 `GlobalBus`,最终通过 SSE/WebSocket 推给所有客户端。

## 4. 工具系统

- **定义框架** `Tool.define`(`tool/tool.ts:151-169`):参数用 Effect Schema 声明(自动转 JSON Schema),`wrap()` 统一做参数解码与**输出截断**。
- **内置工具**:`bash`、`read`、`edit`、`write`、`glob`、`grep`、`apply_patch`、`webfetch`、`websearch`、`todowrite`、`task`、`skill`、`lsp`、`plan`、`question`、`invalid` 及 MCP resource 三件套;`grep` 复用内置 Ripgrep 服务。
- **edit 的 string replacement 是九级渐进 fallback 链**(`tool/edit.ts:694-704`):`Simple → LineTrimmed → BlockAnchor → WhitespaceNormalized → IndentationFlexible → EscapeNormalized → TrimmedBoundary → ContextAware(锚行+50%相似度) → MultiOccurrence`;设计源自 cline/gemini-cli 的编辑纠错研究。附加防护:拒绝"匹配区间远大于 oldString"的替换、多匹配强制补上下文、每文件 Semaphore 串行、保留 CRLF/BOM、写后触发 formatter 与 LSP 诊断回注。
- **输出截断**:默认 `MAX_LINES=2000`、`MAX_BYTES=50KB`;超限时全文写入共享 truncation 目录(7 天保留),返回预览+`outputPath` 提示模型用 read 回读——"托管工具输出文件"闭环。
- `read` 流式读取、带行号输出、超长行截断与二进制探测,文件不存在时给出相似文件建议。

## 5. 权限与安全

- **三层规则模型**:规则 `{permission, pattern, action∈ask/allow/deny}`,判定用 `findLast` 保证"后写覆盖先写",无规则默认 `ask`。
- **ask/reply 协议**:ask 挂起在 `Deferred` 上并广播事件;reply 支持 `once/always/reject`——`always` 把 pattern 晋升为会话级 allow 并**自动放行其它 pending 请求**,`reject` 会**级联拒绝同会话全部 pending**。
- **配置即白名单**:`permission: { bash: { "git *": "allow" } }` 直接编译为规则。
- **默认安全基线**:`*.env`/`*.env.*` 读取需 ask(镜像 GitHub gitignore)、doom_loop ask、外部目录默认 ask。
- **bash 权限的 AST 级粒度**:web-tree-sitter 解析 bash/PowerShell AST,抽出每条命令的命令前缀与路径参数,分别触发 `bash`(命令前缀 wildcard,用 `BashArity` 计算 `always` 前缀)与 `external_directory` 两类询问。
- 工具可见性按权限过滤,deny 且 pattern `*` 的工具直接不进 schema。

## 6. 上下文管理:compaction 与 token 计数

全在 `session/compaction.ts`:

- **token 计数极简估算**:`estimate = length/4`——快、够用、可离线。
- **尾部保留预算**:按"用户消息 turn"切分历史,从最新 turn 倒序累加直到预算耗尽;`splitTurn` 允许在 turn 内部按消息粒度切分以吃满预算。
- **总结生成**:交给隐藏的 `compaction` agent(专用 prompt:结构化摘要、保留路径/标识符、禁止续写对话)。
- **溢出恢复**:overflow 场景回放最后一条未被压缩的用户消息。
- **prune(第二层压缩)**:从尾部保护约 `PRUNE_PROTECT` tokens 的工具输出,将更早的已完成工具 part 标记 compacted 清空输出以释放上下文。
- 插件可定制压缩 prompt 或关闭自动续跑。

## 7. 会话持久化、share 与 resume

- SQLite 表 + JSON 载荷,天然支持跨进程共享与 `opencode attach` 恢复;step 级文件快照(patch part)支撑 revert。
- **share**:走 ShareNext 服务生成分享 URL;`share: "auto"` 时新建会话自动分享。

## 8. 扩展机制:plugin、MCP、agents、commands、LSP

- **Plugin API(TS)**:插件是返回 Hooks 的函数,拿到 client SDK + Bun shell。Hook 面极宽:`config`、自定义 `tool`、`auth`(OAuth/API key 向导 UI)、`chat.message/params/headers`、`permission.ask`、`tool.execute.before/after`、`tool.definition`、`shell.env`、`experimental.chat.messages.transform`、compaction 定制等。还支持 `{tool,tools}/*.{js,ts}` 文件系统级工具发现。
- **MCP**:stdio/SSE/StreamableHTTP 全支持,带 OAuth 流程;server 级 instructions 以 `<mcp_instructions>` XML 注入 system,且按权限过滤。
- **自定义 agents**:配置声明 `Agent.Info`,`mode ∈ subagent/primary/all`;内置 `build/plan/general/explore/compaction/title/summary`,plan agent 只许写 plans 目录,explore 只读;甚至能用 LLM 生成新 agent 定义。
- **commands**:markdown 模板命令(支持 `@file` 展开)。
- **LSP**:edit/write 后 `lsp.touchFile` + 拉取诊断并格式化回注到工具输出,另有独立 `lsp` 工具。

## 9. 提示词设计

- **按模型族分发系统 prompt**:claude→`anthropic.txt`、gpt-4/o 系→`beast.txt`、codex→`codex.txt`、gemini→`gemini.txt` 等,兜底 `default.txt`(强调极简输出:能 1-3 句不写 4 句、禁 emoji、禁前后缀客套)。共 14 个 prompt 文件。
- system 组装顺序:`environment(模型ID/cwd/worktree/git/平台/日期)→ AGENTS.md instructions → MCP → skills`。
- **AGENTS.md 上下文注入是懒加载的**:从历史 read 工具 part 的 metadata 中提取已读文件,只注入相关指令,轮次结束清空。
- v2 方向:把整个 system 重构为"可增量刷新的 System Context 源 + 中途系统消息"(Context Epoch)。

## 10. 模型接入层

- **models.dev 是模型元数据的唯一上游**(含 cost、limit、reasoning 能力)。
- Provider 家族适配器覆盖官方网关、azure、bedrock、vertex、vertex-anthropic、sap-ai-core、gitlab、cloudflare、snowflake 等。
- 统一出口 `getLanguage` 返回 AI SDK `LanguageModelV3`;`getSmallModel` 为 title/summary 路由廉价小模型;`closest` 做模型名模糊纠错;`ProviderTransform` 按 model id 做消息/参数变换。
- 成本核算:逐 step 写入 assistant 消息。

## 11. TUI

- 技术栈 **OpenTUI + SolidJS 响应式渲染**(非 Ink/bubbletea)。
- 组件化:大量 dialog 组件(model/provider/agent/mcp/session-list/skill/theme/workspace),路由化 home/session。
- 状态层是一组 Solid Context Provider,TUI 完全通过 SDK + 事件流与 server 同步,无本地业务状态;支持 TUI 插件注册路由。

## 12. 最值得借鉴的工程设计

1. **九级渐进式编辑纠错链**:把"模型给出的 oldString 不精确"当作常态工程问题,用逐级放宽的匹配器换取一次成功率,同时用 disproportionate-match 防护守住安全下限——对 LLM 输出容错的最佳实践之一。
2. **bash 工具的 AST 级权限**:tree-sitter 解析出命令前缀与路径参数,分别匹配 `bash` 与 `external_directory` 规则,并按 arity 计算"始终允许"的前缀粒度——细粒度权限与低打扰兼得。
3. **事件溯源式消息模型 + Part 状态机**:消息与 parts 分表、tool part 显式状态机、`PartDelta` 增量事件,让 TUI/desktop/web/分享链接共享同一份可重放事实流;快照/patch part 顺手解决了 step 级 revert。
4. **双层上下文压缩**:summarize(尾部预算 + turn 内切分)+ prune(保护近期工具输出、清空更早输出),配合 chars/4 的零成本 token 估算,整套方案无外部依赖、完全可解释。
5. **Effect-TS 全面工程化 + v1/v2 并行演进**:Layer 组合 DI、Schema 即 API(OpenAPI 自动生成)、Stream 驱动 agent loop;同时在 `packages/core` 用严格领域语言重写运行时,v1 桥接共存——大型 CLI 存量项目渐进重构的范例。

**结论**:opencode 当前版本的实质是"**Effect-TS 上的本地 AI 开发服务器**"——server 拥有会话、权限、工具、模型路由的全部事实,TUI/desktop/web/插件只是事件流的视图;其最深的护城河在 edit 容错链、AST 权限、双层压缩与事件溯源模型这些"把 LLM 不可靠输出工程化"的系统性设计。
