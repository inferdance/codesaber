# OpenAI Codex CLI(Rust 实现)深度架构分析报告

> 分析对象:`~/ccc/agent-research/codex`(以 `codex-rs/` 为 Rust workspace 根,下文路径相对仓库根)。该版本 workspace 成员超过 130 个 crate,采用 Rust 2024 edition + tokio 异步运行时(`codex-rs/Cargo.toml:6-135`),并带 Bazel/Nix 双构建体系、TS/Python SDK(`sdk/`)与 npm 分发壳(`codex-cli/`)。

## 1. 总体架构:从二进制入口到会话循环

技术栈:核心语言 Rust(tokio、serde、ratatui/crossterm、reqwest/rustls、sqlx(SQLite)、starlark(execpolicy)、rmcp(MCP)、landlock/seccompiler/bubblewrap(沙箱)、v8/deno(code-mode 实验)、schemars + ts-rs(协议代码生成)。

crate 划分(职责极为细碎,体现"宏内核+微 crate"风格):
- 门面与入口:`cli`(多命令入口)、`exec`(非交互)、`tui`、`app-server`/`app-server-protocol`/`app-server-*`(JSON-RPC 服务层)、`mcp-server`(Codex 作为 MCP server)。
- 核心:`core`(agent 循环)、`protocol`(EventMsg/ResponseItem/配置类型等跨端协议,同时生成 TS 类型)、`tools`(工具规范/派发抽象)、`apply-patch`(补丁独立二进制+库)、`function_tool` 在 core 内。
- 安全:`sandboxing`(seatbelt/landlock 命令构造)、`linux-sandbox`(bwrap+seccomp helper)、`windows-sandbox-rs`、`execpolicy`(Starlark 命令评估器)、`secrets`、`process-hardening`。
- 持久化:`rollout`、`history`、`thread-store`、`state`(SQLite)。
- 支撑:`config`、`model-provider-info`、`models-manager`、`prompts`、`rmcp-client`、`skills`、`hooks`、`ext/*`(guardian、web-search、memories、image-generation 等扩展)、`utils/*`(20 余个工具库,含 output-truncation、approval-presets)。

调用链(交互模式):`cli/src/main.rs:1007` 的 `main()` 经 arg0 多路分发(arg0 机制让同一二进制按 argv[0] 摇身变为 `codex-linux-sandbox`、`apply-patch` 等,见 `sandboxing/src/landlock.rs:10` 与 `arg0` crate)进入 `cli_main`(`cli/src/main.rs:1015`),无子命令时调 `run_interactive_tui`(`cli/src/main.rs:1102`)→ `tui::run_main`(`tui/src/lib.rs:927`)→ `run_ratatui_app`(`tui/src/lib.rs:953`)。关键点:**TUI 并不直接链接 core,而是启动/连接 app-server,通过类型化 JSON-RPC 会话交互**(`tui/src/app_server_session.rs:1-3`);app-server 内托管 `ThreadManager`(`core/src/thread_manager.rs:241`)→ `Session`(`core/src/session/session.rs:37`)→ `run_turn`(`core/src/session/turn.rs:153`)。非交互 `codex exec` 走 `codex_exec::run_main`(`exec/src/lib.rs:245`),支持 `--json`(JSONL 事件流)与 `--output-schema`。

## 2. Agent 循环核心(codex-core)

**Turn 生命周期**:`run_turn`(`core/src/session/turn.rs:153`)先 drain 异步 hook、执行 **pre-sampling compact**(turn.rs:169),再解析输入中 `@mention` 依赖的 MCP server(turn.rs:193)、捕获 StepContext(上下文/工具/世界状态的一致快照,turn.rs:207-227)、注入 skills/plugins 上下文项(turn.rs:230-261),然后进入主循环(turn.rs:281):

1. 从 `input_queue` 取出用户在模型运行期间新提交的输入(**mid-turn steering**,turn.rs:285-292);
2. 组装采样请求:历史 `ContextManager::for_prompt`(turn.rs:350-356)+ `run_sampling_request`→`try_run_sampling_request`(turn.rs:2160)消费模型流式输出,把 `ResponseItem::FunctionCall/CustomToolCall/ToolSearchCall` 经 `ToolRouter::build_tool_call`(`core/src/tools/router.rs:154-206`)转成 `ToolCall` 并经 `dispatch_tool_call_with_terminal_outcome`(router.rs:233)执行,支持并行工具调用(`core/src/tools/parallel.rs`、router.rs:137);
3. 采样后依据 `needs_follow_up`(模型还要继续/有新输入)与 token 状态决定继续、**auto-compact 滚动窗口**(turn.rs:440-479)还是结束(stop hooks 可阻止收尾,turn.rs:484-531)。

**流式与事件模型**:协议层 `Event { id, msg: EventMsg }`(`protocol/src/protocol.rs:1269-1275`),`EventMsg` 是 60+ 变体的 tagged enum(protocol.rs:1288 起):`TurnStarted/TurnComplete`、`AgentMessage/AgentReasoning*(含 SectionBreak)`、`ExecCommandBegin/OutputDelta/End`、`ExecApprovalRequest`、`TokenCount`、`ContextCompacted`、`McpToolCallBegin/End`、`ThreadRolledBack`、realtime 语音事件等。Session 通过 `send_event`(`core/src/session/mod.rs:1896`)把事件同时写入 rollout 持久化、经 app-server 推给前端。模型连接由 `ModelClient`/turn 级 `ModelClientSession` 管理,同一 turn 内复用 WebSocket 与 `previous_response_id` 以命中服务端会话缓存(`core/src/client.rs:12-16、254-297`)。

## 3. 工具系统

**定义/注册**:面向 Responses API 的 `ToolSpec` 枚举(`tools/src/tool_spec.rs:22-56`:Function/Namespace/ToolSearch/WebSearch/Freeform),直接序列化为 API 的 `tools` JSON(tool_spec.rs:82-142)。执行侧统一为 `CoreToolRuntime` trait(`core/src/tools/registry.rs:53-115`:spec、并行支持、hook 钩子、MCP 归属、取消语义),`ToolRegistry` 用 IndexMap 保序注册(registry.rs:270-369),外部工具与内置冲突时跳过并保护保留名 `shell_command`(registry.rs:346)。注册集中在 `build_tool_router`/`finalize_tool_router`(`core/src/tools/spec_plan.rs:120、317`)。

**内置工具全列表**(本版已无独立 read/edit 工具,读文件靠 shell+rg):
- shell 类:按模型 `shell_type` 二选一 —— `shell_command`(传统一次性命令,`handlers/shell_spec.rs:214`)或统一执行 `exec_command` + `write_stdin`(spec_plan.rs:980-999;会话式:返回 `session_id`,输出按 chunk 流式,shell_spec.rs:264-296);
- 文件编辑:`apply_patch`;
- 计划与上下文:`update_plan`(plan.rs:49)、`new_context_window`/`get_context_remaining`(模型主动换窗/查询余量)、`wait_for_environment`、`current_time`、`sleep`;
- 交互与权限:`request_user_input`、`request_permissions`(shell_spec.rs:227-262)、`list_available_plugins_to_install`/`request_plugin_install`;
- MCP:`list_mcp_resources` 等及各 server 工具;
- 多智能体 v2:`spawn_agent/send_message/followup_task/wait_agent/interrupt_agent/list_agents`(spec_plan.rs:1148-1190),子 agent 具名池见 `core/src/agent/agent_names.txt`,内置角色如 awaiter(`core/src/agent/builtins/awaiter.toml`:低推理力度、专职等待长任务并汇报);
- 其它:`view_image`、`web_search`、`tool_search`(延迟加载 MCP 工具,ToolExposure::Deferred,registry.rs:393)。

**apply_patch 补丁格式**:以 **freeform custom tool + Lark 文法**暴露(`handlers/apply_patch_spec.rs:9-27`,文法全文 `handlers/apply_patch.lark:1-20`),模型不产 JSON 而产纯文本补丁。格式由 `apply-patch/src/parser.rs:37-44` 定义标记:`*** Begin Patch` / `*** Add File: ` / `*** Delete File: ` / `*** Update File: `(+可选 `*** Move to: ` 重命名)/ 上下文锚 `@@`(可带路径)/ 变更行前缀 `+`/`-`/空格 / `*** End of File`(强校验 EOF)/ `*** End Patch`。运行时经文件系统抽象落盘、按沙箱 attempt 执行,失败输出会被启发式判定为沙箱拒绝并转审批升级(`core/src/tools/runtimes/apply_patch.rs:165-224`)。

**输出截断**:策略按模型配置为 `Bytes` 或 `Tokens`(`models.json` 中 gpt-5.6 系为 tokens:10000,`models-manager/models.json:12-15`;未知模型回退 bytes:10_000,`models-manager/src/model_info.rs:167`)。截断采用**中部删除**保留头尾,并加警告头"Warning: truncated output (original token count: N)"(`utils/output-truncation/src/lib.rs:12-30`);token 估算为 4 bytes/token 的近似(`utils/string/src/truncate.rs:4、71-78`)。

## 4. 上下文管理

- **历史容器** `ContextManager`(`core/src/context_manager/history.rs:45`):持有 `ResponseItemEnvelope` 列表 + 服务端 token usage + world_state 基线;`for_prompt` 按输入模态过滤(200),`record_items` 落库前先截断(156),`estimate_token_count` 逐项累加近似(247-271),`drop_last_n_user_turns` 支持回滚(314)。
- **auto-compact**:阈值默认取上下文窗口 90%(`protocol/src/openai_models.rs:488-498`),turn 前(turn.rs:169)与 turn 中 token 超限(turn.rs:440-479)双触发;压缩提示词是"CONTEXT CHECKPOINT COMPACTION 移交摘要"(`prompts/templates/compact/prompt.md`),产物以 `SUMMARY_PREFIX` 开头替换历史并保留全部用户消息(`core/src/compact.rs:349-366`);还支持服务端压缩端点 `/responses/compact`(`core/src/client.rs:162`)。
- **注入机制**:AGENTS.md 按 cwd→repo 根聚合进 developer 消息(`core/src/agents_md.rs`);环境/世界状态(working dir、git 分支、目录树)作为 TurnContextItem/WorldStateItem 注入并在变化时重放(`core/src/session/inject.rs`、`context/world_state/`);skills/plugins 按需注入(turn.rs:230-261)。

## 5. 权限与沙箱

- **审批策略** `AskForApproval`(`protocol/src/protocol.rs:915-939`):`untrusted`/`on-request`(默认)/`granular`(五开关)/`never`。沙箱模式 `read-only`(默认)/`workspace-write`/`danger-full-access`(`protocol/src/config_types.rs:86-96`)。
- **平台沙箱**:macOS 用 `/usr/bin/sandbox-exec`(seatbelt),网络出网仅经本地代理(`sandboxing/src/seatbelt.rs:27-33、41-115`);Linux 由 `codex-linux-sandbox` helper 施加 `no_new_privs`+seccomp+bubblewrap(`linux-sandbox/src/lib.rs:1-5`,`sandboxing/src/landlock.rs:23-63`);Windows 有独立 crate。
- **命令评估器 execpolicy**:Starlark 规则 `prefix_rule(pattern, decision=allow|prompt|forbidden, match/not_match 自带单测)` 与 `host_executable` 白名单(`execpolicy/README.md`);用户选"始终允许"时**追加规则并热更新**(`core/src/exec_policy.rs:277-492`)。
- **升级闭环**:工具编排器 `ToolOrchestrator::run_attempt` 统一"网络预审批→沙箱执行→拒绝识别→审批升级重试"(`core/src/tools/orchestrator.rs:55-135`);审批结果按命令前缀/文件集合缓存(`core/src/tools/sandboxing.rs:38-80`);补丁安全评估 `assess_patch_safety`(`core/src/safety.rs:26`)。

## 6. 会话持久化

- **格式**:每线程一个 JSONL rollout,文件名 `rollout-<时间>-<thread_id>`;每行 `RolloutLine { timestamp, ordinal, item }`,`RolloutItem` 变体涵盖 SessionMeta、ResponseItem、InterAgentCommunication、Compacted、TurnContext、WorldState、SecurityRiskScore、EventMsg(`history/src/lib.rs:95-105`)——本质是**事件溯源**,任何 UI 状态可由其重放。
- **写入**:`RolloutRecorder` 后台写任务(`rollout/src/recorder.rs:86-146`);旧文件自动 zstd 压缩,读取器透明解压(`rollout/src/compression.rs:196-210`)。另有 SQLite state db 做线程索引与检索。
- **resume**:`ThreadManager::resume_thread_from_rollout`(`core/src/thread_manager.rs:970`)→ `reconstruct_history_from_rollout`(`core/src/session/rollout_reconstruction.rs:114`)重建历史、上轮模型设置、参考上下文与 world_state 基线。

## 7. 扩展机制

- **MCP 客户端**:`rmcp-client` crate 支持 stdio 子进程与 Streamable HTTP(重试、OAuth 设备流、elicitation);配置在 config.toml `[mcp_servers]`,每 server 可设 transport、`enabled/required`、`supports_parallel_tool_calls`、`omit_tools_from`。
- **Codex 亦可为 MCP server**(`codex mcp-server`,stdio JSON-RPC)。
- **skills/plugins/hooks**:skills 目录扫描(`skills` crate)、插件市场与安装(`request_plugin_install` 工具)、hook 体系(turn 前/后、stop hook 可拦截收尾)。
- **profiles/config**:`ConfigToml` 覆盖 model、approval_policy、sandbox_mode、`[permissions]` 命名档、`model_providers` map、`profiles` map。

## 8. 提示词设计

- **默认系统 prompt**:`protocol/src/prompts/base_instructions/default.md`(编译期内嵌)。结构:# How you work(Personality)→ AGENTS.md 规范 → 响应性(工具前 1-2 句 preamble)→ 计划(update_plan 使用时机与好坏示例)→ 任务执行(自主性、"keep going until resolved"、apply_patch 唯一编辑入口)→ 验证(由窄到宽跑测试)→ 野心 vs 精准(surgical precision)→ 进度播报与最终答案格式规范(`path:line` 引用)→ 工具指南(优先 rg、update_plan)。
- **GPT-5 codex 专属 prompt**:`models-manager/models.json` 为每个模型内嵌完整 `instructions_template`。GPT-5 系 prompt 显著进化:personality 段带占位与变体;**commentary/final 双通道**沟通协议;压缩感知指令("turn 跨压缩窗口是一条逻辑事件链,不要重做");文件编辑约束("Use apply_patch… Do not create or edit files with cat")、破坏性动作守则;工具调用偏好并行、禁 `echo "===="` 拼接。

## 9. 模型接入层

- `ModelProviderInfo`(`model-provider-info/src/lib.rs:93-137`)含 base_url、env_key/wire_api、HTTP 头、重试与流超时;`WireApi` 目前仅 `Responses`;OSS 侧有 ollama/lmstudio 适配。
- `ModelClient`(`core/src/client.rs:254`):统一 POST `{base_url}/responses` 消费 SSE,或对 `prefer_websockets` 模型走 WebSocket;会话粘性复用 `previous_response_id` 与连接缓存;401 恢复、限流重试、三级遥测。
- **模型元数据**:`models.json` 每模型声明 context_window(272k 起,最高 872k)、auto_compact 阈值、truncation_policy、shell_type、推理档位、`tool_mode: code_mode_only`、`multi_agent_version: v2` 等。

## 10. TUI

ratatui + crossterm,渲染策略独树一帜:**用终端原生 scrollback 存放已定稿历史**(插入历史 cell 是转义序列操作而非 ratatui 绘制,`tui/src/insert_history.rs:1-4`,并对 Zellij 专门适配);活动视口只画底部 composer 与运行中 cell。`ChatWidget` 拆为 30 余个子模块,事件驱动经 `AppEvent` 队列;TUI 与 core 完全解耦为 app-server 的 JSON-RPC 客户端。交互:Esc 中断运行中 turn、Esc-Esc 回退历史、plan 模式切换与计划流式渲染、`/` 命令、markdown 流式渲染与 diff 视图。

## 11. 评测设施

仓库内**没有独立 eval/benchmark 框架**。质量保障靠:超大规模集成测试套件(`core/tests/suite/` 数十个场景,配合 mock 模型驱动完整 agent 循环)、insta 快照测试、wiremock 模拟 API、`rollout-trace` 重放追踪,以及 `codex exec --json/--output-schema` 便于外部评测 harness 程序化调用。

## 12. 最值得借鉴的工程设计亮点

1. **工具规范即协议**:`ToolSpec` 直接序列化为 API 的 tools JSON,apply_patch 用 freeform+Lark 文法约束输出格式——schema 单一来源;补丁格式"上下文锚 + 前缀行"比 unified diff 对模型更稳。
2. **纵深防御的执行管线**:Orchestrator 把"execpolicy 预评估→网络预审批→沙箱执行→拒绝指纹识别→升级审批→规则热更新"统一进一个 `run_attempt`,沙箱三平台原生。
3. **事件溯源式会话持久化**:rollout JSONL 记录全部 ResponseItem/EventMsg/TurnContext/WorldState,resume、多窗口、线程回滚、事后审计共享同一份数据。
4. **TUI 与核心彻底解耦 + 原生 scrollback 渲染**:一份 core 同服终端/IDE/云端;历史零渲染成本。
5. **turn 内 steering 与压缩滚动窗口**:用户输入可在模型运行中排队注入,token 超限在 turn 中途无缝 compact 并续跑。
6. **极端工程治理**:130+ crate 全 workspace 统一 deny `unwrap/expect`、数十条 clippy 强 lint、依赖零冗余。

---

# 增量调研:2026-08-23(c9b19de,上次 9b9b614 后 242 提交)

## 重大变化

### 1. shell_command 已删除,统一执行收编一切

传统一次性 `shell_command` 工具已完全移除。现在只有 `exec_command` + `write_stdin` 统一执行对,受 Feature flag 双开关控制。这意味着 codex 的"工具执行层"已完全统一到一个抽象上。

### 2. exec-server:远端执行架构

新增 `exec-server` / `exec-server-protocol` crate——统一执行可以承载到独立服务进程,通过 JSON-RPC over WebSocket + Noise relay 协议与主进程通信。支持 `--remote` 注册到环境 registry 和 forward 中继。**工具执行层已可整体外置**。

### 3. history/notes:私有模型状态工具(ext/history-notes)

跨上下文窗口的模型私有记忆:
- `history.*` 工具:上下文窗口重置后检索/读取归一化历史
- `notes.*` 工具:跨窗口私有笔记(虚拟路径,单文件 ≤1MB)
- **设计激进**:工具描述明确要求模型"静默使用、绝不向用户透露该工具的存在"

### 4. permission_profile_intersection(793 行)

权限档位求交做成代数运算:合并多个权限配置时,如果无法不弱化地合并就报错拒绝。这比简单的"后写覆盖"更安全。

### 5. Guardian V2 安全评审闭环

同步评审(升级命令走 `sync_reviewer`)+ 异步评分复用(评审线程结果在后续安全评分中复用)。评审线程与 subagent 明确区分。

### 6. content kinds 体系

用户输入和上下文片段按内容类别标注,在合并消息时保留标注——为后续的上下文管理(压缩/过滤/审计)提供元数据基础。

### 7. 新增 crate(差量内)

- `ext/history-notes` — 私有记忆工具
- `utils/redacted-string` — 凭据脱敏字符串类型(配合"Keep credentials out of app-server logs")

### 8. 沙箱进化

- 策略文件以 `.sbpl` 组织(seatbelt base/network/preferences/restricted_read_only)
- macOS 偏好读限全盘策略(新)
- Linux fd 传递挂载(新)
- Windows ACL/audit 强化
- **远端执行强制执行网络策略**

### 9. TUI 新功能

- 权限模式循环切换键位
- `/copy` 响应目标选择器
- vim `r` 替换字符
- `misalignment_policy`(流式渲染错位防护)
- 补丁审批分页(`file_change_approvals`)

### 10. 对 CodeSaber 最有参考价值的点

| codex 新特性 | 对我们的启示 |
|---|---|
| 统一执行 + exec-server | 工具执行层可整体外置(未来远程沙箱的基础) |
| history/notes 私有状态 | 上下文压缩后模型"记得什么"的解决方案 |
| permission_profile_intersection | 权限合并代数(比后写覆盖更安全) |
| Guardian V2 双层审查 | 同步+异步安全审查闭环 |
| content kinds | 上下文管理的元数据基础 |
| RedactedString | 凭据不进日志的类型级保障 |
