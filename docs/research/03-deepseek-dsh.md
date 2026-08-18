# DeepSeek Harness(dsh)深度架构分析报告

## 0. 项目概览

DeepSeek Harness(简称 `dsh`)是 DeepSeek 开源的一个 agent harness,基于 vendored 的 Cordis 插件框架构建,核心理念是 **"Everything is a Plugin"**。仓库为 pnpm monorepo,采用 `packages/<group>/<pkg>/` 两级分组布局,共约 **219 个包**,每个包发布为 `@deepseek-ai/dsh-<name>`。整个产品——包括模型适配器、工具注册表、会话日志、乃至 agent 循环本身——都是插件,"没有需要 patch 的特权核心"(docs/architecture.md:11-13)。

## 1. 总体架构:Monorepo 与分层组合

包分组(`packages/README.md:12-59`):

- **`core/`** — 产品 API 脊柱:`session`(事件溯源会话日志)、`system-prompt`(prompt 组装)、`tools`(工具注册表与执行管线)、`agent`(Agent 接口与活注册表)、`agent-loop`(默认驱动)、`scope`(按 agent 的作用域注册原语)
- **`llm/`** — `llm`(消息/流词汇与适配器缝隙)、`llm-deepseek`(官方直连适配器)、`llm-pi-ai`(多 provider)、`llm-retry`、`token-meter`
- **能力族(capability family)** — `shell/`、`fs/`、`subprocess/`、`terminal/`(PTY)、`web/`、`lsp/`、`skill/`、`subagent/`、`workflow/`、`jobs/`、`sandbox/`、`compaction/`、`context/`、`spill/`(工具结果外溢)等
- **`session/`** — 持久化(JSONL/SQLite)、投影、标题、遥测
- **`interaction/`** — 审批、权限、命令、ask-user
- **`preset/`** — 每 session 的 agent 组合(persona、agent-presets)
- **`extensions/`** — agent 运行时自修改(cordis_inspect/cordis_define 等工具)
- **`bundle/`** — 可安装的 profile 补丁层(base/web-app/headless)
- **`boot/`**、**`host/`**、**`client/`**、**`api/`**、**`sdk/`**、**`acp/`** 等

**Profile 与 Bundle:组合即配置**。一次运行中的 `dsh` 是一棵开机时从有序层组合出的插件树。Profile 存于 `$DSH_HOME/profiles/<name>`,声明其堆叠的 bundle 列表;bundle 是"Cordis 配置行 + 其挂载代码"的分发格式。层应用顺序:profile 列出的各 bundle → profile 级 `cordis.patch.yml` → home 级 → `--patch` 覆盖。`dsh-base` 是所有 profile 的第一层,插入全部基础插件行(`packages/bundle/base/cordis.patch.yml:15-451`)。

**Cordis 五核心思想**(docs/cordis-primer.md:9-26):插件是 `Service` 实现;context 是服务仓库(`ctx.tools`、`ctx.llm` 等);用 `inject` 声明依赖决定加载顺序;类型化事件(`emit`/`waterfall`/`parallel`/`serial` 四种分发模式是事件公共契约的一部分);**注册即可逆 effect**——`ctx.effect()` 返回 disposer,插件卸载时按序解绕。dsh 规定 "Plugins, not loop changes":新行为必须挂在文档化的扩展点上。

## 2. 插件系统(核心重点)

### 2.1 插件能覆盖/扩展哪些点(docs/architecture.md:106-129)

| 目标 | 机制 |
|---|---|
| 加模型 provider | 在 `ctx.llm` 上注册 adapter |
| 加模型可见能力 | 注册到 `ctx.tools`,schema 自动进入 prompt 组装 |
| 单 session 不同能力集 | 组合 agent preset |
| 加 shell 执行 | 注册 `ctx.shell` backend |
| 加人类命令 | 注册 `ctx.commands`(不经过模型轮次直接分发) |
| 加后台工作 | 注册 `ctx.jobs` |
| 拦截请求/工具/轮次 | 用 `agent/*` 或 `tools/*` 事件 |
| 加模型可见上下文 | `agent.inject()` |
| 加 UI | 驱动 `ctx.agents` 并从 `session/event` 渲染 |

### 2.2 生命周期钩子与隔离

- **作用域链**:`dsh-scope` 提供 `ScopedLayers`,注册可落在全局层、preset 层或某个 agent 的层,解析时 `agent → preset → global` 就近遮蔽最远。每个 Agent 拥有 `agent.ctx`,scope 的注册边界随 agent 退出而解绕。
- **Agent preset 隔离**:preset 目录含一个 `agent.cordis.yml`,每进程只挂载一次;加入它的 session 通过 scope 父链共享其工具与 prompt 段;损坏的 preset 以 `broken` 原因列出而非跳过。子 agent 用同步的 `composeFrom()` 绑定父组合。
- **加载 fail-loud**:任一 entry 失败则销毁部分 context 并抛错;抽象缝隙被直接当行加载会在构造函数里抛错。

### 2.3 官方内置插件(`dsh-base` patch 清单节选)

timer/hmr、`dsh-llm`、`dsh-session`、session 标题(含 LLM 生成)、`dsh-agent`、agent-default-model(默认 `deepseek-official / deepseek-v4-flash`)、jobs-local、llm-retry、settings-file、credentials-local、llm-pi-ai、session-persistence-jsonl、session-query-sqlite、session-projection、session-telemetry-otel、subprocess-local、sandbox-local + sandbox-policy、bash-sandbox/pwsh-sandbox(按平台互斥)、user-approval、permission-presets、shell-env、tool-bash/tool-pwsh、tool-jobs、fs-observation-policy、tool-fs、tool-fs-search、agent-instructions、skill 三件套、commands、goal 四件套、plan-mode、token-meter、compaction-basic、command-compact、subagent 五件套、workflow-worker-thread + tool-workflow、timeout-policy、spill 两件套、session-checkpoint-policy、tool-result-pruner、tool-todo、tool-goal、tool-ralph、tool-str-replace-editor、repeat-tool-reminder、web + web-search-deepseek + tool-web、tools、system-prompt、agent-loop、fs-sandbox、llm-deepseek。

## 3. Agent 循环

核心驱动是 `ReactLoopAgent`(`packages/core/agent-loop/src/agent.ts:64`)。术语:**step = 一次模型请求 + 其工具调用;turn = 零或多个 step**。

Turn 流程(docs/architecture.md:67-84):

```
turn/start → claim 下一步输入+一条排队消息 → 组装 prompt 段+工具 schema
  → agent/pre-step(拒绝 | enter)
    step/start → append user/message → 从日志 derive 模型历史
    agent/request → llm/stream → assistant/chunk* → assistant/message
    tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
    step/end
  → agent/turn-stopping(serial,无 next)
turn/end
```

- **单一 Inbox,三种投递**:`followup()`(下一轮唤醒)、`steer()`(下一步唤醒)、`inject()`(不唤醒,等待下次请求被领取)(`agent.ts:122-132`)。
- **preStep**:领取消息 → `systemPrompt.assemble()` → `agent/pre-step` waterfall(监听者可改写消息或直接 reject;被拒的第一步仍会关闭一个不花费 step 的 durable turn,使日志记录这次尝试)。
- **step()**:`renderPrompt(assembly)` → `buildRequest()` → 逐 chunk 消费流并 append `assistant/chunk` → finish 原因 → 错误走 `agent/request-error` waterfall 决定是否 retry → 组装 `assistant/message`(带 usage)→ 无 tool-call 则 completed,否则进入 `executeToolCalls`。
- **buildRequest()**:从会话持久化的 `request/header` 恢复路由,经 `agent/request` waterfall 提议 config,再 `ctx.llm.prepareCall()` 绑定 adapter;`request/header`(initial/resume/change)按变化落日志。
- **runMaintenance()** 提供 maintenance 相位让 compaction 等在不与模型轮次竞争时运行。

### 工具调度

`executeToolCalls`(`tool-calls.ts:59`)按工具的实时并发模式分组:**exclusive 调用形成屏障,parallel 调用进入有界滚动池**;dispatch 可重叠,而 policy(pre/post)与结果提交保持模型序;abort 时为未启动的调用补写合成错误结果以保证 replay 有效;调度器内部失败会 drain 已启动调用而不伪造结果。

## 4. 工具系统

### 4.1 工具定义方式

`ToolDefinition`(`packages/core/tools/src/index.ts:222-288`)除了 name/description/parameters 外,强制声明:

- `output: { schema, render, presentationMeta? }` — **输出即契约**:body 只返回 canonical lossless-JSON value,`render` 纯投影为模型内容,`presentationMeta` 供 UI 回放;
- `execute(args, exec)` — 必须尊重 `exec.signal`;
- 可选 `timeoutMs`(由 timeout-policy 插件执行,绝不发给模型)、`isConcurrencySafe(args)`(只有精确 `true` 才进并行组,fail-closed)、`presentCall`/`presentResult`(**UI 渲染意图是工具设计的一部分**,纯函数以支持日志回放)。

### 4.2 执行管线(五段式)

`tools/pre-execute`(allow/deny/ask,ask 需审批服务返回 `allowed-once`)→ 单调 **guard**(只能拒绝不能放行)→ `tools/execute`(around-dispatch,可做超时/重试/指标)→ `tools/post-execute`(accept/replace/block)→ `tools/result` 观察者。

### 4.3 内置工具清单

`bash`、`read`/`write`/`edit`/`read_image`、`grep`/`glob`、`str_replace_editor`(Claude Code 风格 view/str_replace/insert/create 命令式接口,旧串必须唯一匹配)、`web_search`/`web_fetch`(fetch 默认关闭,理由是 SSRF 保护未做)、`todo_write`、`plan`/`exit_plan_mode`、`skill`、`subagent`/`subagent_fork`/`send_message`/`list_agents`、`job_output`/`job_list`/`job_kill`、`ask_user_question`、`ralph`、`run_code`(Code Mode 传输)、`cordis_*` 自省/自修改工具族。

### 4.4 Code Mode

`Config.mode = 'native' | 'code' | 'both'`。`code` 模式下模型只见 `run_code` 一个工具 + 自动生成的 TypeScript/Python SDK prompt,模型直呼其他工具名会被 `UNKNOWN_TOOL` 拒绝,而 SDK 子分发(parent token)不受限——安全谓词 `collapses()` 是提示词与执行器共用的同一份(`tools/src/index.ts:855-863`)。

## 5. 上下文管理

- **Prompt 组装**:`SystemPrompt` 管理有序 section(静态文本或每次求值的 provider)、动态 context、工具 schema 与变量;`{{variable}}` 严格插值:未知/未定义引用直接抛错。
- **运行时上下文注入**:动态 context 渲染为 user 角色的 durable 快照,头部固定为 "Current runtime context. This snapshot supersedes earlier runtime-context snapshots."
- **Compaction**:`BasicCompactionEngine` 用 `ctx.tokenMeter` 做压力测量,在 `agent/pre-step` 自动触发;`selectCompactableRange` 选择可压缩区间(保留 `retainTokens`),摘要走 LLM,溢出有独立的重试恢复路径。
- **工具结果分层削减**:先 `tool-result-pruner`(阈值 8192 字符,头 4096/尾 1024),再 `spill-policy`(超过 50000 字节 inline 上限外溢到存储并留 locator)。
- **Token 统计**:精确用量到达前用固定文本密度估算。

## 6. 会话持久化

- 核心模型是**事件溯源**:`dsh-session` 提供 append-only `SessionEvent` 日志;持久化是插件 concern。`deriveMessages()` 从日志投影模型历史;"**模型可见即可从日志重建**"是运行时断言的硬不变量(docs/architecture.md:92-96)。
- **JSONL 后端**:每 session 一个追加文件,header + 连续事件;连续 `assistant/chunk` 打包为 `text-chunks` 等复合行(无损且约小 60%);默认 **zstd 帧压缩**,首帧独立可解且必须是 header;含撕裂帧恢复与 prepared-session 缓存。另有 SQLite 后端供全文本检索。
- **Resume/Fork**:`request/header` 以 `reason: 'resume'` 重新落日志;`ctx.sessions.fork(source, boundary?, childSessionId?)` 从日志分叉。

## 7. 权限与安全

- **文件效果沙箱**:`SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`;策略**每次调用携带**而非固定在 provider 上;后端通过 `confine(argv, policy)` 把调用方的精确 argv 包装为受限 runner argv(bwrap/Landlock/Seatbelt,Windows 走 ACL restricted-token),并返回该后端自己的"拒绝方言"stderr 签名,使消费方能区分"被拦"与"没跑"。
- **审批流**:`ApprovalService` 策略 `ask | never`,结果 `allowed-once | rejected | cancelled | unavailable`;`tools/pre-execute` 的 `ask` 决策只有拿到 `allowed-once` 才放行,缺审批服务时 ask 退化为拒绝。升级审批机制支持被拒后加宽策略重试。
- **权限预设**:把 sandbox 模式与审批策略配对成三档,默认 `workspace-write + ask`。
- 没有静态命令黑名单;安全模型是"沙箱强制 + 按事件审批"。web fetch 默认不挂 provider(SSRF 保护未做)。
- **守卫类插件**:`repeat-tool-reminder`(连续重复调用的建议性提醒,阈值 3/5/8)、`tool-call-timeout-policy`。

## 8. 提示词设计

系统 prompt 是**注册表组装的产物**而非单个文件:

- **`harness:identity`**(order -100):仅一行 "You are an AI agent powered by DeepSeek Harness."
- **`deployment:persona`**(order 0):部署自定义槽位,scoped 同名 section 可遮蔽
- **工具指引区 100-199**:每个工具插件自带 prompt 段
- **plan 模式段落**:严格计划模式规则(必须经 `exit_plan_mode` 退出、探索优先、工具目录跨模式不变以保 request-cache 稳定)
- **headless persona**:"You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}."
- Code Mode 的 SDK 段在工具指引之后渲染,且"只能直呼 run_code"的规则段(order 99)刻意放在工具指引之前。

整体设计极度关注 **KV cache 稳定性**(每个包 README 都有 "KV Cache effect" 节)。

## 9. 模型接入层

- **缝隙**:`LlmAdapter` 抽象类——`stream()` 是唯一必需方法;`LlmRuntime.registerAdapter(providers, adapter)` 返回带原子 `replace()` 的句柄,路由与 adapter 实例解耦,settings 变更可热替换路由。`llm/stream` 是每次流式调用的 waterfall。
- **DeepSeek 适配**:`DeepSeekAdapter` 是纯传输层——fetch + SSE 打 OpenAI 兼容的 `/chat/completions`;bearer token 每请求解析且只能来自与 endpoint 同代的快照,配置只携带 credential 引用名而非明文 key;支持 off/low/high/max 四档 reasoning effort;默认 context window 1M、maxTokens 256k;含空闲看门狗与限流/配额/超窗的结构化错误分类。

## 10. UI 层

dsh **没有传统的自绘 TUI**;产品形态是 Web UI:`npx @deepseek-ai/dsh web` 启动(默认 127.0.0.1:3080)。架构分为 `host/`(API gateway + HTTP 路由 server)与 `client/`(浏览器壳、wire、object services、slots 与 30+ 个 `ui-*` 插件)。会话渲染基于 **`ConversationNodeDefinition` + keyed renderer** 扩展点,节点类型覆盖 assistant、tool、compaction、retry、turn-error 等。终端侧替代面:`headless` 一次性 runner、`acp`(automation-only Agent Client Protocol server)与 `sdk`(JSON-RPC 协议 + TS/Python 客户端)。

## 11. jobs 体系

- **`dsh-jobs`(Service Definition)**:抽象 `JobRegistry` 契约 `start/list/get/read/kill/wait/onJobDone/onJobsChanged/attachController`。关键语义:访问以 owner 的 **session id** 围栏("授权而非保密是边界");结算 first-wins;完成通知最后发出;**`start` 在没有 attached controller 服务该 owner 时拒绝工作**,保证生产者不能启动无人可收集的作业。
- **`dsh-jobs-local`(Provider)**:进程内内存注册表;每 owner 并发上限默认 10;agent/服务销毁会取消活工作。
- **`dsh-tool-jobs`(Consumer)**:模型可见的 `job_output`(读流式增量)/`job_list`/`job_kill`。

典型用法:`bash` 工具的 `run_in_background: true` 返回 job id,长任务与前台对话解耦;continuable subagent 也建立在 job 模型上。

## 12. 独特工程设计亮点

1. **事件溯源会话日志作为唯一事实源,"model-visible ⟺ logged" 是可执行不变量**——resume/fork/回放/遥测/持久化全部成为同一流的不同投影,消灭"内存态与磁盘态不一致"这一整类 bug。
2. **Capability Seam 三角色纪律(Service Definition / Provider / Consumer)**:换一个 provider 就换掉整个产品形态——fs 与 subprocess provider 共享同一执行世界,指向远程沙箱即可把 Bash/PTY/LSP 一起搬走。
3. **作用域分层注册表(agent → preset → global 就近遮蔽)**:同一机制服务于工具可见性、prompt 段、presentation mode、审批监听,使"同进程内 Code Mode agent 与 native agent 并存"成为组合问题。
4. **自指插件系统:agent 能检查并改写自己的运行时**(`cordis_define/run/stop`),配合可逆 effect,agent 修改自身插件树后可干净回滚。
5. **输出即契约的工具设计 + 并发声明式调度**:工具 body 只返回 lossless-JSON value,渲染/回放与模型内容解耦;`isConcurrencySafe` fail-closed + exclusive 屏障 + 有界滚动池。
6. **配套工程纪律**:per-file 100% 覆盖率门禁、keyless snapshot 测试、文档门禁、每个非平凡 PR 附 Agent Note。

**总结**:dsh 的本质是"用插件框架重写 Claude Code 类产品"的架构实验——会话日志为源 + 能力缝隙三角色 + 作用域遮蔽三大机制,把 agent 循环、工具管线、安全策略、UI 渲染全部变成可从 YAML 配置树替换的插件。对最想构建可扩展 agent 基础设施的团队最有参考价值;代价是极高的概念密度(219 个包),更适合作为架构范本而非快速二次开发的底座。
