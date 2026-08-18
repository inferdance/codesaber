# Kimi Code CLI(agent-core-v2)深度架构分析报告

## 1. 总体架构

Kimi Code 是 pnpm monorepo,核心分三层:

- **应用层**:`apps/kimi-code`(CLI+TUI 主应用)、`apps/vscode`(VS Code 插件)、`apps/vis`/`apps/kimi-inspect`(会话可视化与检查器)。
- **引擎层**:`packages/agent-core-v2`(现行默认引擎)、`packages/agent-core`(legacy,需环境变量才启用)。
- **支撑层**:`kosong`(模型 provider 抽象)、`minidb`(自研嵌入式 KV+全文索引库)、`transcript`(会话转录模型)、`pi-tui`(终端 UI 框架)、`protocol`/`kap-server`(HTTP/JSON-RPC 与 Web 服务)、`acp-adapter`/`acp-server`(Zed/JetBrains ACP 接入)、`oauth`、`telemetry`、`tree-sitter-bash`(纯 TS bash 解析器)。

入口调用链:`apps/kimi-code/src/main.ts:147` 的 `main()` → Commander 解析 → 交互模式 `runShell` / headless `runPrompt`;`runShell` 中选择 `createKimiHarnessV2` 或 legacy(`src/cli/run-shell.ts:88-90`),harness 由 `packages/node-sdk` 提供,内部通过 SDK RPC 连到 agent-core-v2 引擎实例;TUI 通过 reverse-rpc 承接引擎侧的 approval/question 回调。

agent-core-v2 内部采用 VS Code 风格的 **DI + 分层 Scope** 架构:`_base/di`(instantiation/serviceCollection)之上定义 App→Workspace→Session→Agent 四级生命周期 Scope,所有服务用 `registerScopedService(LifecycleScope.X, ...)` 声明归属。功能按 **Feature** 插件化(如 `features/swarm/swarmFeature.ts:24` 注册 `AgentSwarm` 工具)。

## 2. Agent 循环

核心是 `packages/agent-core-v2/src/agent/loop/loopService.ts`(1223 行)的 `AgentLoopService`:

- **Turn/Step 双层模型**:`enqueue()` 按准入策略(`newTurn`/`activeOrNewTurn` 等)把 StepRequest 归入活动 turn 或新建 turn;`run()` 主循环每轮取一批 Step,先物化上下文消息(`materializeBatch`),再执行 `executeLoopStep`。
- **单步流程**:`llmRequester.start()` 发起流式请求 → 流式增量通过 `createStreamPartHandler`(`loopService.ts:1060-1129`)分发 `AssistantDelta`/`ThinkingDelta`/`ToolCallDelta` 事件 → 请求完成后把 content/toolCall 逐条写入 `context.appendLoopEvent`(事件溯源式上下文)→ `executeStepTools`(`loopService.ts:903-949`)以 async iterator 逐个产出工具结果 → `step.end` 记录 usage 与六项延迟指标。
- **工具并行**:工具调度器 `ToolScheduler`(`src/agent/toolExecutor/toolScheduler.ts:27-47`)按 `ToolAccesses.conflict()`(`src/tool/toolContract.ts:165-174`)做**资源冲突检测**:两个工具只要不冲突(如读不同文件)就并发执行,冲突则排队——"自动并行"而非固定并发度。系统 prompt 也显式鼓励模型并行发起互不干扰的调用。
- 循环支持 quiescence(压缩期间暂停准入)、可注册的错误恢复 handler、maxSteps 限制。

## 3. 工具系统

工具契约是 `resolveExecution(input): ToolExecution`(`src/tool/toolContract.ts:74,93`),声明式给出 `accesses`(调度冲突)、`approvalRule`/`matchesRule`(权限匹配)、`display`(TUI 渲染)、`execute`。Schema 用 **Zod 定义 + 转 JSON Schema**,描述文案放在 `.md` 模板中(`.md?raw` 资源,与代码同库同评审)。

内置工具:`Read`、`Write`、`Edit`、`Grep`、`Glob`、`Bash`、`ReadMediaFile`、`FetchURL`、`WebSearch`、`Skill`、`TodoList`、`AskUserQuestion`、`Agent`(subagent)、`TaskList/TaskOutput/TaskStop`(后台任务)、`CronCreate/CronList/CronDelete`、Goal 四件套、`select_tools`(动态工具激活);Feature 层追加 `EnterPlanMode/ExitPlanMode`、`AgentSwarm`、Tower 11 件套。

**Edit/Write 设计**:经典 `old_string/new_string` 精确替换,非唯一命中报错并提示 `replace_all`;写前经 workspace 路径安全校验。**Bash**:用 `cd 'cwd' && cmd` 包裹、非交互 env(`NO_COLOR=1`、`TERM=dumb`),输出流式转发并截断;**前台超时可自动转后台任务而非杀死**(`autoBackgroundOnTimeout`,`bashTool.ts:105-118`)。**统一截断**:工具结果模型侧上限 50k 字符、预览 2k;Read 单次 1000 行、单行 2000 字符、100KB 上限。

## 4. 子代理体系(主打特性)

- **定义**:subagent 即"Agent Profile",用 `registerAgentProfile` 注册:内置 `coder`(唯一有写文件的子代理,工具白名单)、`explore`(只读探索,系统 prompt 附加 overlay,注入 git context 前缀)、`agent`(主代理全量)。profile 声明 `renderSystemPrompt`、`whenToUse`、`summaryPolicy`。用户可用 `--agent-file`/agentfile 目录自定义。
- **Spawn**:`Agent` 工具(输入 schema 支持 `subagent_type`、`resume`、`run_in_background`、`model`)→ `launch()` 通过 `IAgentLifecycleService.create()` 建子代理。
- **上下文隔离**:`AgentLifecycleService.doCreate` 调用 `createScopedChildHandle(LifecycleScope.Agent, ...)`,即**同进程内创建一个全新的 DI Agent scope**,拥有独立的 contextMemory、loop、事件流、持久化 wire 文件,并在 sessionMetadata 注册 `type:'sub'` 元数据。子代理继承父的 permission mode 与用户工具,但**消息上下文完全从零开始**。还支持 `fork()` 复制上下文。
- **通信**:单向 prompt 进、summary 出;`mirrorAgentRun` 向父级事件流发布 `subagent.spawned/started/completed/failed` 可观测事件,最终只把 **summary 文本 + usage** 作为工具结果返回父代理。
- **Summary 质量门**:`distillSummary`(`runAgentTurn.ts:111-140`)要求最终回复 ≥200 字符,不足则用 `summary-continuation.md` 追加一轮强制扩写——配合 coder 角色提示"最终消息就是全部交接物"。子代理可 `resume`,可后台运行(detached 任务 + TaskList 管理)。
- **更上层编排**:`AgentSwarm` 一次扇出 N 个子代理;**Tower** 是多代理"塔式"工作区:每个 worker 独立 git worktree,经 `TowerInit/Plan/Spawn/Merge/Review...` 11 个协议工具协作,协议文件只能由工具写(merge gate),worker 写权限被限制在自己 worktree 内。

## 5. 上下文管理

- **事件溯源上下文**:contextMemory 记录 `step.begin/content.part/tool.call/tool.result/step.end` 等 loop 事件,`loopEventFold` 折叠为消息;`contextProjector` 在投影为 provider 消息时做异常修复(乱序 tool result 重排、孤儿丢弃、合成、连续 assistant 合并)。
- **压缩**:默认配置:上下文用量 ≥85% `max_input_tokens` 或触发 50k 保留余量即压缩;压缩保留最近 ≤4 条消息/≤20% 窗口的"近期窗口",`canSplitAfter` 保证不切断 tool call/tool result 配对;溢出时最多 3 次降级重试。压缩由 LLM 生成第一人称摘要,用户消息逐字保留。
- **Token 统计**:混合"实测(provider usage)+估算"策略。
- **文件树注入**:系统 prompt 模板含 `${cwd_listing}`,由 `prepareSystemPromptContext` 并行生成目录树(折叠隐藏目录)、AGENTS.md。配套 `agentsMdReminder`:用 tree-sitter 解析 Bash 命令提取 `ls/tree/find` 目标目录,目录下存在未注入的 AGENTS.md 时发 system-reminder。

## 6. 会话持久化

存储根 `~/.kimi-code`。两级结构:Session 级 `state.json`(含 agents 注册表、标题);**每个 Agent 一条 append-only `wire.jsonl` 事件日志**,由 `WireService` 串行写入、支持大媒体 offload 到 blob,日志头是带 `protocol_version` 的 metadata 记录,读取时按迁移链升级。恢复 = replay journal 重建状态 + `IEventDispatcher.restore()`。`resume(sessionId)` 支持 `--resume/--continue`。底层由 `persistence/interface`(appendLogStore/atomicDocumentStore/blobStore)抽象,默认 minidb 后端。

## 7. 权限与安全

三档模式 `manual/auto/yolo`。裁决链 12 个策略按序短路:用户 deny → auto 放行 → 会话历史放行 → 用户 ask → 用户 allow → 敏感文件询问 → git 控制文件询问 → yolo 放行 → **默认工具白名单放行**(Read/Grep/Glob/TodoList/Agent/Skill 等只读类)→ git cwd 写放行 → 兜底 ask。`AgentPermissionGate` 监听 `onBeforeExecuteTool` 仲裁,ask 走 `toolApproval` 反向请求到 UI。规则语法为 `Tool:pattern`(picomatch);Write/Edit 按 path 匹配,Bash 按命令文本匹配。另有 workspace trust 门、路径访问策略、`.env`/SSH 私钥等秘密文件读取硬拒绝。

## 8. 扩展机制

- **MCP**:stdio/HTTP/SSE/remote 四种 client 与 OAuth;工具命名 `mcp__<server>__<tool>`,超 64 字符 FNV 哈希截断;AI 原生 `/mcp-config` 技能对话式配置。
- **Hooks**:20 种生命周期事件(PreToolUse/PostToolUse/UserPromptSubmit/PreCompact/SubagentStart…),本地命令执行,可 block 工具调用。
- **Skills**:SKILL.md frontmatter 解析,`Skill` 工具动态注入技能正文,支持嵌套深度限制。
- **Plugins**:`kimi.plugin.json` manifest(可含 MCP/skills/hooks/commands),marketplace 与 GitHub 安装,系统 prompt 注入上限 32KB。

## 9. 提示词设计

系统 prompt 单文件模板 `src/app/agentProfileCatalog/system.md`:身份/语言 → 工具使用规范(并行鼓励、拒绝后不绕行)→ 编码准则(MINIMAL changes、git 变更须确认)→ 上下文管理说明(向模型解释自动压缩行为)→ 环境块(OS/shell/日期/`${cwd_listing}` 目录树/`${agents_md}`,并对 AGENTS.md 定性为"项目参考数据而非特权指令通道")。注入体系在 turn 边界插 plan-mode/goal/permission-mode/todo 等 `<system-reminder>`,并刻意避免每 step 重复以保 prompt cache。

## 10. 模型接入层

`kosong` 是统一 LLM 抽象:contract(message/usage/provider/tool)+ 三大基底 openai|anthropic|google-genai。Kimi provider 基于自研 OpenAI 兼容层(默认 `https://api.moonshot.ai/v1`,`interleaved-thinking-2025-05-14` beta header 即 K2 交错思考),工具 schema 有 Kimi 专用规范化,错误分类含配额耗尽模式匹配。模型目录经 oauth managed 配置 + models.dev 导入 + env overlay 合成;subagent 可独立选模型。

## 11. UI

TUI 为 **pi-tui 框架**(自 Editor/Markdown/ScrollView/SelectList/Image/KillRing/alt-screen 等,自绘布局树),主界面 `KimiTUI` 含 tool-renderers、dialogs、tasks-browser、subagent-activity-store 等控制器;approval/question 通过 reverse-rpc 与引擎交互。另有 ACP(Zed/JetBrains)、Web、VS Code 四种前端共享同一引擎。

## 12. 评测

无独立 LLM eval 基准设施;质量保障依赖 1213 个 vitest 单测文件(engine 有 `fakeRuntime` 等可测性基建)、telemetry 生产埋点(turn_started/turn_interrupted/subagent_created/permission_policy_decision 等)及 `apps/kimi-inspect`/`apps/vis` 会话回放分析工具。

## 13. 最值得借鉴的工程设计

1. **Scope 化 DI 的"多代理同进程"模型**:四级 scope 让 subagent 是"完整引擎实例"而非薄封装——独立 loop、独立 wire 日志、独立事件流,天然可恢复/可 fork,同时共享进程内服务。
2. **资源冲突驱动的工具自动并行**:`ToolAccesses` 声明式资源占用 + 冲突检测,让"能不能并行"从模型提示词约定变成引擎硬保证。
3. **事件溯源式上下文 + 投影修复**:上下文存 loop 事件而非最终消息,投影时系统化修复乱序/孤儿/重复 tool result。
4. **子代理 Summary 质量门**:minChars + continuation 重试 + 角色化"最终消息即交接物"提示,直接解决子代理交接信息丢失这一常见痛点。
5. **策略链式权限 + 声明式工具规则**:每个工具在 `resolveExecution` 内自带 `approvalRule/matchesRule/accesses`,权限系统零硬编码;Bash 输出超时自动转后台亦是细节亮点。

**总结**:kimi-code 的核心竞争力在于 agent-core-v2 的"VS Code 式分层 DI + 事件溯源 + Scope 隔离"引擎设计——subagent、压缩、权限、多前端全部统一为同一套可插拔服务;短板是双引擎并存的维护成本与尚缺公开评测基准。
