# Coding Agent 深度调研:模块设计、实现方案与 0→1 路线图

> 调研日期:2026-08-19。方法:本地深读 5 个开源仓库(codex / pi / deepseek-harness / kimi-code / opencode,已克隆至 `~/ccc/agent-research/`)+ Claude Code 逆向资料 + arXiv 论文 + Harbor 评测框架。
> 分报告索引见文末附录。文中 `repo:path:line` 引用均来自分报告的源码证据。

---

## 0. 一页结论(TL;DR)

1. **一个实用的 coding agent ≈ 13 个模块**,按依赖从下到上:模型接入层 → 事件溯源持久层 → 工具系统(含文件/搜索/Shell/计划)→ Agent Loop(turn/step 状态机 + steering)→ 上下文管理(compaction/注入)→ 提示词动态拼装 → 权限/审批/沙箱 → 扩展体系(MCP/插件/skills/hooks)→ 子代理 → 会话管理 → UI/多前端 → 评测。
2. **行业已收敛到三个共识**:(a) 会话 = append-only 事件日志(事件溯源),模型可见的一切都必须可从日志重建;(b) 循环 = turn/step 两级状态机 + mid-turn steering 队列;(c) 上下文 = 多层压缩级联(无 LLM 的 prune → 有 LLM 的 summarize),且要为 KV cache 稳定性设计。
3. **各家最大的分歧在四件事**:编辑协议(apply_patch vs 字符串替换 vs Code Mode)、安全哲学(OS 沙箱 vs 确认审批)、扩展架构(微核+事件 vs 一切皆插件)、产品形态(TUI 单体 vs client/server)。
4. **论文侧的核心启示**:SWE-agent 的 ACI(Agent-Computer Interface)研究证明 **harness 的接口细节比换模型更能提升成功率**;Context Rot 证明长上下文直接损害正确率(compaction 是正确性问题不只是成本问题);多智能体系统多数不如好的单 agent + 子代理上下文隔离。
5. **0→1 最短路径**:抄 pi 的循环(805 行 agent-loop,最干净)、抄 opencode 的 edit 九级容错链、抄 codex 的沙箱编排、抄 dsh 的"输出即契约"工具设计、抄 Claude Code 的提示词结构与 microcompact 级联;第 1 天就接 Harbor 评测,而不是等做完再评。

---

## 一、调研对象与方法

| 对象 | 语言/规模 | 一句话定位 |
|---|---|---|
| **OpenAI Codex CLI** | Rust,130+ crate | 工业级纵深防御的标杆:OS 沙箱 + Starlark 命令策略 + 事件溯源 rollout |
| **Pi**(earendil-works,原 badlogic/pi-mono) | TS,~1.7 万行核心 | 极简微核 + 全事件开放的自扩展 agent:"让 agent 自己给用户写扩展" |
| **DeepSeek Harness (dsh)** | TS,219 包(Cordis 插件框架) | "Everything is a Plugin" 的架构实验:循环/工具/UI/Provider 全部可替换 |
| **Kimi Code**(MoonshotAI) | TS,agent-core-v2 | VS Code 式四级 DI Scope,subagent = 完整引擎实例,主打子代理与 Tower 多 worktree |
| **opencode**(sst) | TS + Effect(已无 Go) | 本地 AI 开发服务器:client/server 分离,edit 九级容错 + bash AST 权限 |
| **Claude Code**(闭源,逆向) | Node 打包 cli.js | 上下文工程与提示词工程的产品化标杆,Skills 三级渐进披露 |

深读证据与逐家完整报告见附录(01~07 号文档)。

---

## 二、共识架构:一张图看懂 coding agent

六个项目虽然语言与理念迥异,但骨架惊人一致:

```
┌────────────────────────────────────────────────────────────┐
│ 前端层  TUI / IDE(ACP,LSP) / Web / 桌面 / SDK / headless exec │
├────────────────────────────────────────────────────────────┤
│ 协议层  JSON-RPC(codex app-server / kimi SDK RPC)             │
│         HTTP+SSE(opencode server) / stdio JSONL(pi rpc)      │
├────────────────────────────────────────────────────────────┤
│ 会话层  Session/Thread 管理器(多会话、resume、fork、checkpoint)  │
│   ├─ Agent Loop:turn/step 状态机 + steering/followup 双队列     │
│   ├─ Context Manager:历史容器 + compaction + 世界状态注入        │
│   └─ Prompt Assembler:系统提示词分节动态拼装(缓存友好)           │
├────────────────────────────────────────────────────────────┤
│ 能力层                                                       │
│   ├─ Tool Registry + Scheduler(声明式并行/冲突检测)             │
│   │    ├─ 文件:read / write / edit / apply_patch              │
│   │    ├─ 搜索:grep / glob(rg 内核)                            │
│   │    ├─ Shell:bash(前台/后台 job)+ 输出截断                   │
│   │    ├─ 计划:todo / plan / exit_plan_mode                    │
│   │    └─ 子代理:task / spawn_agent / send_message             │
│   ├─ 权限网关:规则匹配 + 审批链 + hooks(deny 优先)              │
│   ├─ 沙箱执行器:Seatbelt / Landlock+bwrap / Docker             │
│   └─ 扩展:MCP client(命名空间注入)/ 插件 / skills / commands    │
├────────────────────────────────────────────────────────────┤
│ 模型层  Provider 抽象(多线协议适配、OAuth、重试、计费、模型目录)   │
├────────────────────────────────────────────────────────────┤
│ 持久层  事件溯源日志(JSONL/SQLite)+ 投影重建 + zstd 冷压缩       │
└────────────────────────────────────────────────────────────┘
```

三条"共识定律":

- **定律一(事件溯源)**:会话的唯一事实源是 append-only 事件日志;内存态只是日志的投影。codex rollout(`codex-rs/history/src/lib.rs:95-105`)、pi 的 JSONL 树(`session-manager.ts`)、dsh 的 SessionEvent + "model-visible ⟺ logged" 运行时断言(`docs/architecture.md:92-96`)、kimi 的 per-agent `wire.jsonl`、opencode 的 SQLite parts 表,全部如此。好处:resume/fork/回放/审计/遥测共享同一份数据。
- **定律二(turn/step + steering)**:turn = 用户输入到任务完成的一段;step = 一次模型请求 + 其工具调用。模型运行期间用户可以插话(steering),在下一个安全点注入——codex `turn.rs:281-292` 的 input_queue、pi 的双 PendingMessageQueue、dsh 的 followup/steer/inject 三种投递(`agent.ts:122-132`)。
- **定律三(上下文是资产)**:上下文经营(最小高信号 token 集、多层压缩、子代理隔离)是比模型选择更可控的正确率杠杆——这是 Claude Code 官方工程博客的核心论点,也与 Context Rot 论文(arXiv:2507.06223)互证。

---

## 三、13 个功能模块逐个深挖

### 模块 1:模型接入层(Provider / LLM API)

**职责**:把 N 家厂商的 N 种线协议统一成一个流式接口,处理鉴权、重试、限流、计费、模型元数据。

| 维度 | 各家做法 |
|---|---|
| 抽象方式 | pi:**API(线协议)× Provider(厂商)双轴**,10 种协议 × 40 厂商(`packages/ai/src/types.ts:17-75`);dsh:`LlmAdapter` 只强制 `stream()` 一个方法(`packages/llm/llm/src/index.ts:180-233`);codex:只保留 Responses 一种 wire API;opencode:AI SDK `LanguageModelV3` + 双运行时 seam(`session/llm.ts:226-269`);kimi:kosong 三大基底(openai/anthropic/google-genai)派生 |
| 模型目录 | opencode/pi/kimi 都吃 **models.dev** 社区目录;codex 自建 `models.json`(每模型带完整 instructions_template、上下文窗口、截断策略、推理档位) |
| 订阅鉴权 | pi 独有:Anthropic/OpenAI/Copilot 等订阅 OAuth(PKCE + 本地回调),`lazyOAuth({isSubscription: true})`;dsh:凭据只存"引用名",token 每请求解析且必须与 endpoint 同代快照 |
| 错误处理 | pi:错误编码进流的 `stopReason`,**不允许抛异常**(`types.ts:322-334`),上层重试逻辑对 provider 无感;dsh:结构化错误分类(限流/配额/超窗)+ 空闲看门狗 |
| 会话缓存 | codex:同 turn 复用连接与 `previous_response_id` 命中服务端会话缓存(`core/src/client.rs:12-16`)——省钱大头 |

**从 0 到 1 建议**:
1. MVP 阶段只做 OpenAI Chat Completions 兼容一种线协议 + Anthropic Messages 一种,足以覆盖 90% 厂商(包括 DeepSeek/Kimi/各类网关);
2. 消息模型一开始就定义统一内部格式(user/assistant/tool 三种 + text/thinking/toolCall 内容块),把厂商差异封在 adapter 里;
3. 流式事件标准化:`start → text/thinking/toolcall delta → done|error`,错误进流不抛异常(pi 契约);
4. usage/cacheRead/cacheWrite/cost 从第一天就记账(后面一切预算逻辑依赖它);
5. 模型目录直接消费 models.dev,别自己维护价格表。

### 模块 2:Agent Loop(核心状态机)

**职责**:驱动"模型 ↔ 工具"循环,处理流式、工具调度、steering、错误恢复、终止条件。

**共识结构**(伪代码):

```
外层 while(还有待处理的用户输入 / follow-up):
    turn 开始:drain steering 队列 → 组装 prompt → 注入环境状态
    内层 while(true):
        流式调模型 → 事件增量外发(UI 渲染)
        若无工具调用 → 本 turn 结束
        校验工具调用(参数 schema、stopReason=length 时拒执行)
        调度执行工具(可并行)→ 结果写回上下文
        检查 token 水位 → 必要时 mid-turn compact
```

各家关键实现细节:

- **codex**(`core/src/session/turn.rs:153-531`):turn 前压缩 + turn 中压缩双触发;StepContext 一致性快照;stop hook 可阻止收尾。
- **pi**(`packages/agent/src/agent-loop.ts:155-275`):外层管 follow-up、内层管工具与 steering;`stopReason === "length"` 时**拒绝执行全部工具调用**并统一回错(`agent-loop.ts:207-214`)——防止截断的 JSON 参数产生半截副作用;重试在会话层做指数退避,且重试前把错误消息移出 agent 状态但保留在会话文件(`agent-session.ts:2779-2829`)。
- **dsh**(`packages/core/agent-loop/src/agent.ts`):事件驱动,`agent/pre-step`(waterfall,可拒绝)、`agent/request`(可改写请求配置)、`agent/turn-stopping`(serial);maintenance 相位让 compaction 不与模型轮次竞争。
- **kimi**(`agent-core-v2/src/agent/loop/loopService.ts`):StepRequest 准入策略(newTurn/activeOrNewTurn)入队 → 批处理;step.end 记录 usage + 六项延迟指标。
- **opencode**(`session/prompt.ts:1081-1341` + `processor.ts`):processor 返回三态 `"compact" | "stop" | "continue"` 驱动外层;**doom loop 防护**——连续 3 次相同工具+相同参数强制弹权限询问(`processor.ts:356-380`);步数达上限注入 MAX_STEPS_PROMPT 强制收尾;首步用小模型生成会话标题。

**从 0 到 1 建议**:先抄 pi 的 `agent-loop.ts`(全文件 805 行,是最干净的教学实现),加三个必须品:doom loop 防护(opencode)、length 截断拒执行(pi)、mid-turn steering 队列。**循环代码要保持小,新行为全部挂事件/hook,不要往循环里加 if**(dsh 的 "Plugins, not loop changes" 纪律)。

### 模块 3:工具系统(注册、校验、调度、输出治理)

**职责**:工具的定义协议、注册表、并发调度、参数校验、输出截断与渲染。

**定义协议对比**:

- schema:codex 用 Rust 类型 + ts-rs 双生成;pi/kimi 用 TypeBox/Zod → JSON Schema;opencode 用 Effect Schema;dsh 是**输出即契约**——工具 body 只返回 canonical lossless JSON,`render` 是纯投影,`presentationMeta` 供 UI 回放(`packages/core/tools/src/index.ts:211-287`)。后者的好处:UI 回放、模型内容、调试数据三者解耦。
- 每个工具还应声明:**并发安全性**(dsh `isConcurrencySafe` 必须"精确 true"才进并行组,fail-closed;kimi 用 `ToolAccesses` 资源占用做冲突检测自动并行)、**超时**(dsh timeoutPolicy,绝不发给模型)、**权限规则**(kimi 工具自带 `approvalRule/matchesRule`)、**渲染器**(专属 TUI 展示)。

**调度**:pi 默认 `Promise.all` 并行、声明 sequential 则整批串行;dsh exclusive 工具形成屏障、parallel 进有界滚动池,abort 时为未启动的调用补写合成错误结果保证回放有效(`tool-calls.ts:248-259`);kimi 按资源冲突自动并行。

**输出治理(被严重低估的模块)**:所有家的共识是**三层防线**:
1. 截断:保留头尾删中部(codex `output-truncation`,按模型配 bytes 或 tokens);kimi 模型侧 50k/预览 2k;opencode 2000 行/50KB;
2. 全量落盘 + 回读闭环:opencode 超限时全文写 truncation 目录(7 天保留),返回预览 + `outputPath` 让模型按需 read;dsh 的 spill 机制(>50KB 外溢到存储留 locator);pi 把全量 bash 输出落 `fullOutputPath`;
3. 提示词侧引导:优先 rg 而非 cat;禁 `echo "==="`,拼接输出(codex GPT-5 prompt 明令禁止)。

**从 0 到 1 建议**:工具接口一开始就定成 `name/description/schema/execute + optional: concurrencySafe, timeoutMs, render, permissionRule`。MVP 先做 6 个工具:bash、read、write、edit、grep、glob。

### 模块 4:文件编辑(read / edit / write / apply_patch)

这是**分歧最大、也最影响成功率**的模块。三条路线:

| 路线 | 代表 | 格式 | 优劣 |
|---|---|---|---|
| **自由文本补丁** | codex `apply_patch` | `*** Begin Patch / *** Update File: path / @@ 锚点 / +/- 行`,freeform custom tool + Lark 文法约束输出(`handlers/apply_patch.lark`) | 单次可改多文件;对模型输出容错强;但需要专门的解析器与失败反馈设计 |
| **字符串精确替换** | Claude Code / kimi / dsh(str_replace_editor) / opencode / pi | `old_string/new_string`,要求唯一匹配,`replace_all` 可选 | 实现极简;对模型定位能力要求高;需要容错层 |
| **Code Mode** | dsh `run_code`、codex 实验性 | 模型只见一个 `run_code` 工具 + SDK prompt,用代码调用其余工具 | 表达力最强(循环/组合/错误处理);安全谓词必须提示词与执行器共用同一份(`tools/code-mode.ts:855-863`) |

**容错是核心竞争力**。opencode 的 edit 是九级渐进 fallback 链(`tool/edit.ts:694-704`):Simple → LineTrimmed → BlockAnchor → WhitespaceNormalized → IndentationFlexible → EscapeNormalized → TrimmedBoundary → ContextAware(锚行+相似度) → MultiOccurrence,并配 disproportionate-match 防护(匹配区间远大于 oldString 时拒绝)、每文件信号量串行、CRLF/BOM 保留、写后自动 formatter + LSP 诊断回注。这条链的设计源自 cline/gemini-cli 的实证研究。

**各家护栏细节**:
- Read 输出 `cat -n` 行号格式,且**编辑前必须先 Read**(Claude Code 用状态校验防盲改;read 默认 2000 行,单行截 2000 字符);
- Write 对已存在文件要求先 Read;dsh 的 `create` 拒绝覆盖已存在文件;
- Claude Code prompt 明令:Edit 的 old_string 要剥离 Read 输出的行号前缀、保留精确缩进;
- pi:所有文件写操作过 `file-mutation-queue` 串行化防竞态;edit 做 LF 规范化。

**从 0 到 1 建议**:MVP 用字符串替换路线(实现一天),但**立刻**加上 opencode 的前四级 fallback;等模型侧验证稳定后,可再评估 apply_patch(多文件原子编辑场景)。Aider Polyglot 的经验:**模型 × 编辑格式存在显著交互**,换模型要重新消融。

### 模块 5:Shell 执行与后台任务

**职责**:安全地跑命令,治理输出,支持长任务后台化。

- 执行细节共识:非交互环境变量(kimi:`NO_COLOR=1`、`TERM=dumb`);超时杀整棵进程树(pi `bash.ts:114-152`);`cd 'cwd' && cmd` 包裹(kimi);命令要求主动语态 description(dsh/Claude Code 都要求,便于审批展示)。
- **超时不等于杀死**:kimi 的 bash 超时可自动转后台任务(`bashTool.ts:105-118`);Claude Code `run_in_background` + TaskOutput 模式;**dsh 把它抽象成统一的 jobs 能力缝隙**——`JobRegistry` 契约(start/list/read/kill/wait),bash 的 `run_in_background: true` 返回 job id,子代理也建立在 job 模型上;关键语义:"start 在没有 attached controller 时拒绝工作"(生产者不能启动无人收集的作业,`jobs/src/index.ts:82-176`)。
- 会话式 shell:codex 新版用 `exec_command` + `write_stdin`(返回 session_id,输出按 chunk 流式)替代一次性命令,支持交互式程序。

**从 0 到 1 建议**:MVP 做一次性 bash + 超时 + 输出截断;第二阶段加 `run_in_background` + `task_output`/`task_kill` 三件套(这是跑测试/构建长任务的刚需)。

### 模块 6:上下文管理(compaction / 注入 / token)

**职责**:让长会话不爆窗、让模型始终知道"我在哪、改过什么、剩多少预算"。

**多层压缩级联**(Claude Code 逆向还原的完整阶梯,其他家是子集):

```
预算削减 → snip(LRU 归档最旧消息)
        → microcompact(~80% 用量触发,不调 LLM:清理陈旧大体积工具输出并重排以命中缓存)
        → 完整 auto-compact(~92%:LLM 总结历史,保留架构决策/未解决 bug/最近 5 个文件)
        → 被动 compact(请求溢出后兜底)
```

各家参数:codex 阈值 = 窗口 90%,turn 前 + turn 中双触发,压缩产物替换历史但**保留全部用户消息**(`compact.rs:349-366`);kimi:≥85% 或 50k 余量,保留最近 ≤4 条消息/≤20% 窗口,`canSplitAfter` 保证不切断 tool call/result 配对,溢出最多 3 次降级重试;opencode:尾部 turn 预算从最新往回累加 + `splitTurn` 允许 turn 内切分吃满预算;第二层 **prune**(保护近期工具输出,清空更早的已完成工具输出,`compaction.ts:271-317`);dsh:三层——tool-result-pruner(8192 字符,头 4096/尾 1024)→ spill(>50KB 外溢)→ BasicCompactionEngine(LLM 总结)。

**token 计数**:不要追求精确。opencode 用 `length/4`(零依赖);pi/kimi 混合"provider 真实 usage + 字符估算";dsh 在精确 usage 到达前用固定文本密度估算。**先粗后准**即可。

**注入(给模型的"世界观")**:
- 环境块:cwd/git 分支/平台/日期/模型名(Claude Code 24 组件之一;kimi 加 `${cwd_listing}` 折叠目录树);
- AGENTS.md/CLAUDE.md 层级注入(codex 按 cwd→repo 根聚合;pi 沿目录祖先链收集 + git worktree 遮蔽;**opencode 做成懒加载**——只注入历史 read 过的文件相关指令,turn 结束清空);
- pi 的 compaction 记录 `readFiles/modifiedFiles` 累积,跨多次压缩后模型仍知道碰过哪些文件——细节但极有效;
- **KV cache 稳定性**(dsh 的独门关注):系统提示词按"静态前、动态后"排序,运行时上下文快照头部固定写 "supersedes earlier snapshots",plan 模式不改变工具目录——一切为了 prompt cache 命中率。

**从 0 到 1 建议**:第一版 compaction 只要:阈值触发(85%)+ LLM 总结 + 保留最近 N 轮原文 + 用户消息逐字保留 + 压缩后自动重试被打断的 turn(pi 的 willRetry 模式)。然后尽快加 microcompact 级的无 LLM prune(清老工具输出)——它解决 80% 的爆窗且零成本。

### 模块 7:提示词工程(系统提示词动态拼装)

**共识:系统提示词不是文件,是函数。**

- Claude Code:约 24 个组件动态拼装(Drew Breunig 逆向),固定段(身份/规则/任务哲学/工具策略)+ 条件段(环境块/缓存边界标记/worktree 变体/undercover mode);
- dsh:注册表组装,有序 section(harness:identity order -100 → persona order 0 → 工具指引 100-199),`{{variable}}` 严格插值,未知引用直接抛错;
- pi:纯函数 `buildSystemPrompt`,**Available tools 列表由当前启用工具动态生成**,条件化 Guidelines;
- opencode:**按模型族分发 14 个 prompt 文件**(claude→anthropic.txt、codex→codex.txt、gemini→…),同一 agent 对不同模型说不同的话;codex 更极端:每个模型自带完整 instructions_template(GPT-5 系有 commentary/final 双通道协议、压缩感知指令)。

**值得整段抄的内容结构**(Claude Code 泄露 prompt 的骨架):
1. 身份与个性(简洁/直接);
2. 环境块(cwd/git/平台/日期);
3. 任务执行哲学(最小改动、"keep going until resolved"的自主性、做完为止);
4. 工具使用策略(优先专用工具而非裸 shell;避免 cat/head/tail/grep/find;并行调用鼓励;拒绝后不绕行);
5. 输出规范(≤4 行、无 emoji、`file:line` 引用、标题/短句/monospace);
6. 安全与确认(可逆性分级、危险动作确认、git 不主动 push);
7. 记忆体系说明(AGENTS.md 的读写规则);
8. 条件段(plan 模式规则、subagent 说明、skills 清单)。

**从 0 到 1 建议**:提示词分节存文件、代码拼装,静态段在前(缓存命中),环境/记忆段在后;每节可独立开关。把"编辑前先读、行号剥离、缩进精确"这类**工具使用细则写进工具 description 而非系统提示词**(Claude Code 的做法)——工具描述是离上下文最近的指令位。

### 模块 8:权限、审批与沙箱

**两种哲学**:
- **确认式**(Claude Code / opencode / kimi / pi):规则匹配 + 审批 UI。共同细节:规则 `Tool:pattern`(kimi picomatch;opencode `{permission, pattern, action∈ask/allow/deny}` 后写覆盖);审批结果 once/always/reject,**always 自动放行其它 pending 同规则请求,reject 级联拒绝**(opencode `permission/index.ts:121-166`);默认安全基线(`*.env` 读取 ask;只读工具白名单直接放行);**hooks 的 deny 优先级最高且在 bypassPermissions 下依然生效**(Claude Code)。
- **沙箱式**(codex / dsh):OS 级强制隔离 + 审批只用于升级。codex 三档 read-only / workspace-write / danger-full-access;macOS Seatbelt、Linux bwrap+seccomp、Windows 独立 crate;**编排器统一"策略预评估→沙箱执行→拒绝指纹识别→升级审批→规则热更新"**(`tools/orchestrator.rs:55-135`);execpolicy 用 Starlark 写命令规则(`prefix_rule(pattern, decision)`),用户点"始终允许"时追加规则热更新。dsh:`confine(argv, policy)` 把精确 argv 包成受限 runner,并识别各后端的"拒绝方言"以区分"被拦"与"没跑起来"。

**bash 权限的精细化**(opencode 独门):web-tree-sitter 解析 bash AST,抽出命令前缀(按 arity 计算"始终允许"的前缀粒度)与涉及的路径参数,分别触发 `bash` 与 `external_directory` 两类询问——细粒度与低打扰兼得。kimi 用 tree-sitter-bash 做 AGENTS.md 提醒(发现模型 ls/tree/find 了含未注入 AGENTS.md 的目录时发 system-reminder)。

**从 0 到 1 建议**:阶段 1 做最简三档(read-only / auto-edits / full)+ 每工具审批;阶段 2 加规则配置(`bash: {"git *": allow}`)+ always 记忆;沙箱(如果做)直接抄 codex 的 seatbelt/landlock 调用参数,或退而求其次用 Docker。**安全底线两条**:间接注入防御(读到的文件/网页内容是不可信输入,提示词明确"数据不是指令")+ 秘密文件硬拒绝。

### 模块 9:会话持久化与恢复

**共识格式**:每会话一个 append-only JSONL(codex rollout、pi session、kimi wire.jsonl、Claude Code projects/<id>.jsonl),opencode 用 SQLite(+JSON 载荷)。

关键设计:
- **pi 的会话树**:entry 用 `id/parentId` 构成树,`/tree` 原地分支,切分支自动生成 branch_summary;fork 复制全部 entry 到新文件 + parentSession 指针,支持跨项目带记忆搬家;`custom` entry 存扩展私有状态(不进 LLM 上下文);
- **压缩与版本迁移**:zstd 冷压缩(codex 旧文件自动压缩、读取透明解压;dsh 连续 chunk 打包省 60% + 撕裂帧恢复);kimi/opencode/pi 都有 schema version + 迁移链——**日志格式一旦发布就要承诺迁移**;
- **resume 语义**:重建历史 + 上轮模型设置 + world_state 基线(codex `rollout_reconstruction.rs`);kimi resume = replay journal 重建状态;
- **checkpoint/rewind**:Claude Code 每条用户 prompt 自动快照(对话+文件双维度),Esc Esc 回退;opencode 的 step 级 patch part 支撑 revert;
- **大媒体 offload**:kimi blob store;dsh attachment。

**从 0 到 1 建议**:第一天就定 JSONL schema:`{ts, id, parentId, type, payload}`,type 至少含 session_meta / user_message / assistant_message(含 toolCall) / tool_result / compaction / custom。恢复 = 折叠投影。这个格式以后就是你的调试器、评测数据源和遥测源。

### 模块 10:扩展体系(MCP / 插件 / skills / hooks / commands)

**MCP(外部工具生态)**:全部支持。共同细节:命名 `mcp__<server>__<tool>`(kimi 超 64 字符 FNV 哈希截断);description 截断(Claude Code 2048 字符,防流氓 server 塞 60KB);stdio/SSE/StreamableHTTP 三传输 + OAuth 懒启动(401 才发起);server instructions 以 XML 注入 system(opencode);**延迟加载**(codex `tool_search` ToolExposure::Deferred,MCP 工具不默认全量进 schema)。codex 还能反向作为 MCP server 供 IDE 调用。

**插件(进程内扩展)**:三种深度——
1. pi:TS 模块 + jiti 热加载,约 40 个生命周期事件 + registerTool/Command/Shortcut/Flag/Provider,**连 UI 确认框都能在 headless 下经 RPC 桥接**(扩展代码不改一行同时服务 TUI 与 RPC);
2. dsh:Cordis 框架,插件 = Service,可逆 effect(卸载按序解绕),甚至有 `cordis_define/run/stop` 工具让 **agent 运行时检查并改写自己的插件树**;
3. opencode/kimi:plugin 函数返回 hooks 对象(config/tool/auth/permission.ask/tool.execute.before/after/chat.params transform),文件系统级工具发现(`tools/*.ts`)。

**Skills(知识/工作流扩展)**:已成事实标准(agentskills.io):`SKILL.md` + YAML frontmatter(name+description 常驻系统提示词),正文按需加载,捆绑脚本真正用到才读——**三级渐进披露**解决"附带上下文无边界"问题。pi/kimi/opencode/dsh 全部跟进。模型侧用法:系统提示词放 `<available_skills>` 清单,模型用 read 工具自取(`pi skills.ts:355-381`)。

**Hooks(治理扩展)**:Claude Code 20+ 生命周期事件(PreToolUse/PostToolUse/UserPromptSubmit/PreCompact/Stop/SubagentStart…),退出码语义(2 = 阻断且 stderr 反馈模型),kimi 同样 20 种。这是企业审计/自定义安全策略的标准挂点。

**从 0 到 1 建议**:顺序是 hooks(最便宜,几个同步挂点)→ MCP client(接生态)→ skills(纯约定 + 文件加载,无代码)→ 插件 API(最后做,先让内部模块走同一接口验证稳定性——**用自己的插件 API 实现自己的功能**,像 dsh 那样)。

### 模块 11:子代理与多智能体

**为什么需要**:上下文隔离(脏上下文切出去,只回传浓缩摘要)+ 并行(独立探索同时进行)。**不是为了"多角色更聪明"**——MAST 研究(arXiv:2503.13657)实证多智能体常劣于好的单 agent 基线。

实现谱系:
- **轻量委托**:Claude Code Task(无状态子代理,只回传最终报告,同消息可并发多个);opencode 的 subtask 会话(children + remap);
- **完整引擎实例**:kimi 的 `createScopedChildHandle(AgentScope)`——子代理是同进程内全新 DI scope,独立 loop/事件流/wire.jsonl,可 resume 可 fork;继承父权限模式但**消息上下文从零开始**;coder/explore/agent 三个内置 profile(工具白名单 + 角色 overlay + summaryPolicy);
- **具名代理池**:codex 的 spawn_agent/send_message/wait_agent/interrupt_agent 多智能体 v2,内置 awaiter 专职等长任务;
- **编排层**:kimi AgentSwarm(一次扇出 N 个)+ Tower(每 worker 独立 git worktree,11 个协议工具,merge gate 限制协议文件只能工具写)。

**质量细节**(直接决定子代理好不好用):
- kimi 的 **summary 质量门**:最终回复 ≥200 字符,不足则追加一轮强制扩写;coder 角色提示"最终消息就是全部交接物";
- Anthropic 披露的数字:子代理用干净窗口探索数万 token,回传 1000-2000 token 浓缩摘要;
- Claude Code 支持后台子代理 + resume。

**从 0 到 1 建议**:MVP 后第一个高级功能就是 Task 子代理(通用 + explore 只读两个 profile)。实现 = 复用你已有的 session/loop,换个系统提示词与工具白名单,隔离上下文,返回 summary——**你的架构如果对了,子代理应该是"new 一个 session"那么简单**(kimi 证明了这一点)。

### 模块 12:UI 与多前端

**共识:一个核心,N 个前端。**

- codex:TUI 是 app-server 的 JSON-RPC 客户端(同一 core 服务 CLI/TUI/桌面/云端);渲染上**历史写入终端原生 scrollback**(转义序列插入而非重绘,海量历史零成本、可原生复制),活动区才用 ratatui 画;
- pi:pi-tui 差分渲染(16ms 合帧、键盘输入立即渲染旁路、APC 光标标记支持 IME、Kitty 图片协议);同一 AgentSessionEvent 归一化后服务 interactive/print/json/rpc 四模式;
- opencode:server 单例 + mDNS 局域网发现,TUI(OpenTUI+SolidJS)/桌面(Electron sidecar)/Web/SDK 全是事件流视图;
- kimi:TUI(基于 **pi-tui 改造**——开源生态互相借用实锤)+ ACP(Zed/JetBrains)+ Web + VSCode;审批/提问经 reverse-rpc 回调 UI;
- dsh:干脆没有 TUI,Web UI(host/client + 30 个 ui-* 插件,会话渲染是可扩展的 keyed node renderer)。

**headless 是一等公民**:`codex exec --json`(JSONL 事件流)、`pi --print`、opencode SDK——这是 CI、评测(Harbor 接入就靠它)和编排的基础。

**从 0 到 1 建议**:MVP 用现成 TUI 框架(ink/pi-tui/bubbletea 按语言选),**但从第一天把"引擎 ↔ 渲染"做成事件流接口**(哪怕只是进程内 EventEmitter)——它是你后面接 IDE/server/评测的同一接口。

### 模块 13:评测与质量(Harbor)

**六个 agent 的共同短板**:除 pi 有 evals 包、codex 有超大集成测试(mock 模型驱动完整循环)外,都没有真正的 LLM 基准设施。行业方案是 **Harbor**(harbor-framework/harbor,Terminal-Bench 团队,Apache-2.0):

- **定位差异**:lm-eval-harness/HELM 评"模型"(静态数据集对答案);Harbor 评"agent 系统 = harness × 模型"(被测对象是 Claude Code/Codex 这类完整 agent,在每题独立 Docker 环境里自由行动,由可执行验证器打分)。
- **四概念**:Task(task.toml + instruction.md + environment/Dockerfile + tests/test.sh + 可选 solution/solve.sh)/ Agent(BaseAgent 适配器:name/version/setup/run,黑盒 CLI 接入)/ Environment(Docker,可配 CPU/内存/GPU/禁网/云沙箱 Dayatna/Modal/e2b)/ Verifier(脚本写 `reward.txt` 单值或 `reward.json` 多维;支持 LLM judge 但默认可执行验证)。
- **已内置 adapter**:claude-code、codex、opencode、goose、openhands、aider、gemini-cli、cursor-cli、cline、qwen-coder、mini-swe-agent…自建 agent 只需子类化 BaseAgent + 一个 install 脚本模板。
- **数据集**:terminal-bench@2.0(89 高难任务)/2.1/3.0、SWE-Bench、Aider Polyglot 经 benchmark adapter 接入。
- **CI 用法**:PR 触发 `--max-tasks 10` 冒烟;夜间全量 + `--attempts 3` 降方差;`harbor sweeps` 做 prompt/工具接口的参数扫描消融;私有回归集 = 团队真实工单做成 task 目录(每题配 solution/,用 oracle agent 验证可解性防坏题)。

**从 0 到 1 建议**:MVP 能跑通的第一个周末就写 Harbor adapter 接 terminal-bench 子集。评测不是终点装饰,而是你后面所有 prompt/工具/压缩改动的**回归安全网**——SWE-agent 论文的全部消融结论都建立在"接口改动必须数据驱动验证"上。

---

## 四、四个关键设计决策的深度对比

### 4.1 编辑协议之争

apply_patch(多文件原子、文法约束)适合自家的强模型与高频大改场景;字符串替换(简单、普适)适合生态兼容;Code Mode(表达力最强)对安全谓词要求高。**没有一个 universally 最优解——这就是要接 Harbor 做消融的原因**(Aider Polyglot 已证明模型×格式交互显著)。

### 4.2 上下文压缩对照表

| | 触发阈值 | 无 LLM 层 | LLM 层 | 保留策略 | 特殊设计 |
|---|---|---|---|---|---|
| Claude Code | 80%/92% 级联 | microcompact+snip | auto-compact | 最近 5 文件 | 被动 compact 兜底 |
| codex | 窗口 90% | — | turn 前+turn 中双触发 | 全部用户消息 | 模型可用 new_context_window 主动换窗 |
| opencode | 溢出自动 | prune(清老工具输出) | 尾部 turn 预算 | splitTurn 吃满预算 | 溢出回放最后未压缩用户消息 |
| kimi | 85%/50k 余量 | — | 第一人称摘要 | ≤4 消息/≤20% 窗口 | 溢出 3 次降级重试 |
| dsh | tokenMeter 压力 | pruner+spill | LLM 总结 | retainTokens | maintenance 相位不与轮次竞争 |
| pi | 窗口-reserve | — | LLM(可被扩展接管) | — | 记录 readFiles/modifiedFiles 累积 |

### 4.3 安全哲学:确认式 vs 沙箱式

确认式(轻量、用户掌控、易实现)+ AST 级 bash 解析,是开源社区主流;沙箱式(codex/dsh)适合无人值守/企业级,工程成本高(三平台内核机制)。务实路线:**确认式起步,接口预留沙箱执行器**(pi 的 Operations 虚拟化正是为此——工具副作用接口化,本地/SSH/微 VM 间切换不动 schema)。

### 4.4 架构风格:单体 vs 微核 vs 一切皆插件

- **pi(微核+开放事件)**:核心 1.7 万行,一切可替换——适合个人/极客工具,**学习成本最低,是读源码的首选**;
- **kimi/opencode(服务化 DI/client-server)**:适合多前端产品化;
- **dsh(一切皆插件)**:适合平台化/企业级基础设施,概念密度极高(219 包),不建议作为第一站;
- **codex(宏内核+微 crate)**:工业级,纵深防御值得逐模块抄。

---

## 五、学术启示:十条可执行结论

1. **ACI > prompt 调优**(SWE-agent, 2405.15793):把工具接口当一等设计对象——窗口化浏览、行号锚定、编辑后自动 lint、搜索截断,这些细节值数个百分点。
2. **不是所有环节都值得自主**(Agentless, 2407.01489):定位/验证等可确定性化的环节硬编码,把模型自主性留给判断密集处;固定流水线曾以 $0.34/issue 胜过多智能体。
3. **上下文越长越笨**(Context Rot, 2507.06223):compaction、选择性保留、子代理隔离是正确率问题。reasoning 模型受害更深。
4. **上下文是可演化的 playbook**(ACE, 2510.04618):记忆/规则不应手工固化,应设计为带增删改语义、可被 agent 自身维护的结构(pi/dsh 的 cordis_* 自修改工具是工程实现)。
5. **子代理的价值是上下文工程而非智能**(Anthropic 工程报告 + MAST 2503.13657):并行 + 隔离 + 浓缩回传;信息流最小化。
6. **记忆分层**(MemGPT, 2310.08560):主上下文/归档存储 + 换入换出,是 compaction 的理论原形。
7. **技能库复利**(Voyager, 2305.16291):成功方案沉淀为带描述的 skill(Skills 系统的学术原形)。
8. **失败要语言化沉淀**(Reflexion, 2303.11366):记录失败轨迹并结构化为"教训"跨会话传递(rules 文件自动进化)。
9. **间接注入是默认威胁**(2302.12173):读到的网页/文档/代码 = 不可信输入;权限分级 + 沙箱 + 注入鲁棒性回归缺一不可。
10. **趋势:模型越强,scaffold 越薄**(mini-swe-agent/Terminus 路线 + 2026 harness 形式化工作):不要把编排逻辑做厚,把接口做稳、把评测做严。test-time compute(并行采样+验证器选择)正在进入 harness 标配(R2E-Gym)。

---

## 六、0→1 路线图

### 阶段 0:选型(半天)

- **语言**:TS/Bun(生态最厚,抄 pi/opencode/kimi 代码最直接)或 Rust(要长期做企业级安全);不建议 Go(opencode 已放弃 Go)。
- **架构基调**:pi 式微核——核心只做 loop/session/tools/prompt,其他全是事件挂点。
- **目录骨架**:`core/(loop, context, session, prompt) + tools/ + providers/ + frontends/(tui, cli) + extensions/`。

### 阶段 1:MVP —— "能改代码的循环"(1~2 周)

| 做什么 | 抄谁 |
|---|---|
| LLM 接入(2 协议 + 流式事件标准化 + usage 记账) | pi-ai 的契约 |
| Agent loop(turn/step + length 拒执行 + doom loop 防护) | pi agent-loop.ts + opencode processor |
| 6 工具:bash/read/write/edit/grep/glob(TypeBox schema + JSON Schema 导出) | pi tools + opencode edit 前四级 fallback |
| 输出治理:头尾截断 + 全量落盘可回读 | opencode truncate |
| JSONL 事件溯源持久化(id/parentId 树)+ resume | pi session-manager |
| 最简 TUI(现成框架)+ `--print` headless | pi-tui / ink |
| 系统提示词 v1(分节文件 + 动态拼装:环境块 + 工具节 + AGENTS.md) | Claude Code 骨架 |

**验收**:Harbor adapter + terminal-bench 子集(10 题)跑通,记录基线分;真实仓库完成一次"读→改→跑测试"任务。

### 阶段 2:可用性 —— "敢天天用"(2~3 周)

- 权限:三档模式 + 规则配置(`Tool:pattern`)+ always 记忆 + 审批 UI;
- compaction v1(85% 阈值 + LLM 摘要 + 保留近期轮 + 用户消息原文 + willRetry)+ 无 LLM prune 层;
- steering(模型运行中插话)+ 会话 fork/分支(pi 树结构);
- 计划模式(plan/exit_plan_mode + todo 工具);
- 提示词打磨:按模型族分发 + 工具细则进 description + 输出规范;
- 错误恢复:指数退避重试、溢出→压缩→重试。

**验收**:8 小时真实工作日使用不爆窗;夜间 Harbor 全量回归无退化。

### 阶段 3:生产力 —— "快起来"(3~4 周)

- Task 子代理(general + explore profile,summary 质量门);
- 后台任务(bash run_in_background + task_output/kill);
- MCP client(命名空间 + OAuth + 延迟加载);
- Skills(SKILL.md 三级渐进披露)+ commands;
- hooks(PreToolUse/PostToolUse/Stop 等 8 个核心事件);
- AGENTS.md 懒加载注入(opencode 式)。

**验收**:并行子代理完成一个多模块调研任务;MCP 生态工具可调用。

### 阶段 4:工程化 —— "配得上用户"(持续)

- client/server 分离 + SDK(HTTP/SSE 或 JSON-RPC),IDE/Web 前端;
- 沙箱执行器(Seatbelt/Landlock 或 Docker)+ 命令策略热更新(codex execpolicy);
- 遥测(turn/step 延迟、token/成本、工具成功率)+ 会话回放调试器;
- 私有 Harbor 回归集(真实工单 → task 目录 + oracle 验证);
- 长任务:test-time compute(并行采样 + 验证器选择)、checkpoint/rewind、git worktree 并行会话。

---

## 七、给 codesaber 的落地建议

以本仓库(codesaber,"Cut through code")为目标工程时的三个初始决策建议:

1. **TS/Bun + pi 式微核**:直接把 pi 当参考实现放在手边(`~/ccc/agent-research/pi/packages/agent/src/agent-loop.ts` 全文精读),opencode 的 `tool/edit.ts` 与 codex 的 `core/src/tools/orchestrator.rs` 作为两个专题精读;
2. **第一周就冻结三份契约**:内部消息模型、agent 事件流、会话 JSONL schema——它们是所有后续模块的地基,改它们的成本随时间指数上升;
3. **评测先行**:MVP 当天写 Harbor BaseAgent 适配器,每次 prompt/工具改动跑 `--max-tasks 10` 冒烟;这会把"感觉变好了"变成"分数变好了"。

---

## 附录 A:分报告索引(本目录)

| 文件 | 内容 |
|---|---|
| `01-codex-rs.md` | Codex CLI(Rust)深度架构:crate 划分、turn 状态机、apply_patch 文法、沙箱编排、rollout |
| `02-pi.md` | Pi 深度架构:pi-ai 双轴抽象、agent loop、会话树、扩展体系、pi-tui 差分渲染 |
| `03-deepseek-dsh.md` | dsh 深度架构:Cordis 插件系统、ReactLoopAgent、工具五段管线、jobs 体系、Code Mode |
| `04-kimi-code.md` | Kimi Code 深度架构:四级 DI Scope、ToolScheduler 冲突并行、subagent/Tower、kosong |
| `05-opencode.md` | opencode 深度架构:client/server、parts 模型、edit 九级容错、bash AST 权限、双层压缩 |
| `06-claude-code.md` | Claude Code 逆向调研:提示词 24 组件、压缩级联、hooks/Skills/MCP、checkpoint |
| `07-papers-and-harbor.md` | arXiv 论文综述(30+ 篇按主题)+ Harbor 评测框架完整调研 |

## 附录 B:本地仓库

```
~/ccc/agent-research/
├── codex            (openai/codex, Rust)
├── pi               (earendil-works/pi, TS monorepo)
├── deepseek-harness (deepseek-ai/deepseek-harness, TS + Cordis)
├── kimi-code        (MoonshotAI/kimi-code, TS)
└── opencode         (sst/opencode, TS + Effect)
```

## 附录 C:核心参考文献

- SWE-agent(Agent-Computer Interface):arXiv:2405.15793 ｜ Agentless:2407.01489 ｜ CodeAct:2402.01030 ｜ OpenHands:2407.16741
- MemGPT:2310.08560 ｜ Context Rot:2507.06223 ｜ ACE(Agentic Context Engineering):2510.04618
- SWE-bench:2310.06770 ｜ Terminal-Bench:2601.11868 ｜ MLE-bench:2410.07095 ｜ TheAgentCompany:2412.14161 ｜ R2E-Gym:2504.07164
- Voyager:2305.16291 ｜ Reflexion:2303.11366 ｜ Why Do Multi-Agent LLM Systems Fail?:2503.13657
- 间接注入:2302.12173 ｜ AgentDojo:2406.13352
- Anthropic:Effective context engineering for AI agents ｜ Multi-agent research system ｜ Agent Skills 工程博客
- Harbor:github.com/harbor-framework/harbor ｜ tbench.ai
