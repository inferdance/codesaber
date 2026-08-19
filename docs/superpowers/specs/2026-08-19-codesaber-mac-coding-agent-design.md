# CodeSaber 技术方案设计:Mac 上最好用的 Coding Agent(CLI + App)

> 日期:2026-08-19。状态:设计已经用户逐节确认,待进入实施计划。
> 背景调研:`docs/research/00-coding-agent-architecture.md`(codex/pi/dsh/kimi-code/opencode 源码深读 + Claude Code 逆向 + arXiv 论文 + Harbor)。

## 1. 产品定位与已确认决策

**北极星**:Mac 上最好用的 coding agent,兼具 CLI 与原生 App。四个差异化方向(全选):

1. **Mac 原生体验 + 快**:原生 App(SwiftUI/菜单栏/通知)+ 极致性能(启动快、流式渲染丝滑);
2. **模型无关 + 成本可控**:多模型接入、成本透明;
3. **自主性与后台任务**:长任务后台跑、多会话并行(git worktree)、通知推送;
4. **工作流编排**:draw(计划)→ strike(执行)→ sheathe(交付)。

**关键决策记录**:

| 决策点 | 结论 |
|---|---|
| 架构复杂度 | 不考虑人力约束,按架构最佳实践设计 |
| 技术栈 | **Rust 引擎 + SwiftUI App** |
| 模型接入 MVP | **API key 先行**:OpenAI 兼容 + Anthropic Messages 两种线协议 + Ollama 本地 |
| App 定位 | 对标 **Codex macOS app / zcode**:完整 GUI 客户端(会话流、diff 审阅、审批、任务中心),CLI 全功能 |
| 引擎-App 连接 | **方案 A:常驻引擎进程 + 多前端**(类型化 JSON-RPC/SSE over Unix domain socket) |

被否的备选:方案 B(FFI 内嵌,App/CLI 会话不互通)、方案 C(内嵌 JS 插件层,YAGNI 留给 v2)。

## 2. 总体架构与进程模型

### 2.1 仓库结构(Rust workspace + Xcode 工程 monorepo)

```
codesaber/
├── crates/
│   ├── saber-protocol   # 协议类型唯一来源:RPC 方法、EventMsg、Config;schemars → 构建期生成 Swift Codable(+TS 备用)
│   ├── saber-core       # session/turn-loop/context/compaction/prompt 拼装
│   ├── saber-tools      # 工具注册表+调度器+内置工具(read/write/edit/grep/glob/bash)
│   ├── saber-provider   # 模型接入:OpenAI 兼容+Anthropic Messages+Ollama;usage/成本记账
│   ├── saber-sandbox    # macOS Seatbelt(.sbpl 模板)+ 命令前缀策略
│   ├── saber-jobs       # 后台任务:JobRegistry(start/list/read/kill/wait)
│   ├── saber-mcp        # rmcp 客户端(stdio/HTTP,命名空间注入)
│   ├── saber-server     # 常驻引擎:UDS 上的双向 JSON-RPC + notification 事件流
│   ├── saber-tui        # ratatui TUI(原生 scrollback 手法)
│   └── saber-cli        # 入口,arg0 多路分发:tui/server/exec/resume
├── app/                 # CodeSaber.app(SwiftUI,Xcode 工程)
└── docs/
```

### 2.2 进程模型与通信

- 单一二进制 `saber`,多模式:`saber`(TUI)/ `saber server`(常驻,launchd 管理)/ `saber exec -p`(headless)/ `saber resume`;**App bundle 内嵌版本锁定的 sidecar 引擎二进制**,也支持 attach 已运行的系统实例。
- 通信:Unix domain socket(默认 `~/.codesaber/daemon.sock`,可配置)上的**单连接双向 JSON-RPC 2.0**——前端与引擎互为 caller(审批/追问走引擎→前端反向调用,zcode reverse-rpc 同款);事件以 JSON-RPC notification 推送,前端 `subscribe(session_id)` 订阅、通知带 session 路由;协议独立 semver,握手带版本+能力协商。notification 携带单调序号(seq)与 session 路由,重连后可按 seq 重放,分帧统一为换行分隔 JSON(不使用 SSE)。App v1 严格只用内嵌 sidecar(版本强锁定),attach 外部实例 = M3+。
- **任何前端看到同一份会话事实**:App 发起的会话 CLI 能 resume,终端跑一半的任务 App 能接手。
- 数据目录 `~/.codesaber/`:sessions(JSONL 事件溯源)、config.toml、truncations/;凭据存 macOS Keychain(明文不落盘)。
- 分发:CLI 走 brew(预编译二进制)/cargo;App 走 Developer ID 签名 + 公证 + Sparkle 自动更新。README 的 npm 表述随 M0-T8 同步修正为 brew/cargo(如后续需要 npm 渠道,再加 npm 包装层,非 M0 范围)。

## 3. 引擎核心设计(saber-core)

### 3.1 Agent Loop:turn/step 状态机 + steering

- `turn` = 用户输入→任务完成;`step` = 一次模型请求+工具调用。模型流式运行中,用户输入进 steering 队列,在下一个 step 边界注入。
- 三条硬防线:
  1. `stopReason=length`(响应被截断)时**拒绝执行所有工具调用**,统一回错让模型重发(pi 手法,防半截参数产生副作用);
  2. **doom-loop 防护**:连续 3 次相同工具+相同参数,强制转人工确认(opencode 手法);
  3. stop hook 可阻止 turn 收尾。
- 循环代码保持极小,新行为全部挂事件钩子(dsh "Plugins, not loop changes" 纪律)。

### 3.2 工具系统:声明式契约 + 自动并行

- 工具契约:`name/description/schema/execute + 可选 concurrency_safe/timeout_ms/permission_rule/render`。
- 调度器按资源占用做冲突检测自动并行(kimi `ToolAccesses` 手法);写文件类互斥。
- MVP 六件套:
  - `bash`:超时杀进程树;输出三层治理(头尾截断→全量落盘 `truncations/` 供 read 回读→提示词引导用 rg);
  - `read`:行号格式(cat -n 风格),默认 2000 行/单行 2000 字符;编辑前必须先 read;
  - `write`:已存在文件须先 read;
  - `edit`:old/new 精确替换 + **渐进容错链前六级**(Simple→LineTrimmed→BlockAnchor→WhitespaceNormalized→IndentationFlexible→EscapeNormalized)+ disproportionate-match 防护 + 每文件信号量串行 + CRLF/BOM 保留(opencode `edit.ts` 手法);
  - `grep`/`glob`:内嵌 ripgrep 库。

### 3.3 上下文管理:两层压缩 + 缓存友好注入

- **无 LLM 层(prune/microcompact,~80% 用量触发)**:清空早期已完成工具输出、保留近期——零成本解决大部分爆窗(Claude Code 手法)。
- **LLM 层(auto-compact,~92% 触发)**:总结模型默认用会话当前模型、可在 config.toml 指定为便宜模型;保留架构决策/未解决 bug/最近文件/**用户消息逐字**;压缩后自动续跑被打断的 turn(pi willRetry 手法)。
- token 计数:`chars/4` 估算起步,provider usage 到达后校准。
- KV cache 友好:系统提示词"静态前、动态后"排序(dsh 手法);AGENTS.md 沿目录祖先链聚合注入。

### 3.4 权限与沙箱:三档模式 + Seatbelt

- 模式:`read-only` / `workspace-write`(默认)/ `danger-full-access`;审批 `ask/once/always`,always 按命令前缀记忆并可热更新(codex execpolicy 思路;Starlark 完整策略引擎留给 v2)。
- 沙箱:macOS Seatbelt(`sandbox-exec` 策略模板;workspace-write 下 cwd 可写、网络走本地代理);执行闭环:"沙箱预执行→拒绝识别→升级审批→重试"(codex orchestrator 手法)。**最小 Seatbelt 自 M0 生效**(可写 = cwd + `~/.codesaber/`、禁网、**工具子进程环境白名单**——只传 PATH/HOME/LANG/TMPDIR,密钥只存在于引擎进程内,绝不传入子进程),审批闭环 M1 接入。
- bash 权限 AST 级解析(tree-sitter-bash 抽命令前缀+路径参数分别询问,opencode 手法);`.env`/秘钥文件读取硬拒绝。

### 3.5 后台任务(saber-jobs)

- `bash` 支持 `run_in_background` 返回 job id;`job_output/job_list/job_kill` 工具;完成经 macOS UserNotifications 推送。
- JobRegistry 语义:"没有 attached controller 时拒绝 start"(dsh 手法);job 以 session id 围栏。

### 3.6 模型路由(saber-provider)

- MVP 三家:OpenAI 兼容(覆盖 DeepSeek/Kimi/GLM/OpenRouter/网关)+ Anthropic Messages + Ollama;统一 usage+成本记账;会话内可切模型。
- **failover v1**:同一请求失败(限流/超时/5xx)自动切换到可配置的备用 provider/model;RequestRouter seam 现在留。
- 成本核算:provider usage 权威 + chars/4 估算 + 静态价格表(config);会话/日预算软告警。
- v2:智能路由(便宜模型探路、贵模型决策)、models.dev 目录、订阅 OAuth。

### 3.7 draw / strike / sheathe 工作流(产品差异化)

三个一等模式,不只是命名:

- **draw**:只读探索(工具白名单只读)+ 产出 plan 文件;
- **strike**:按 plan 执行(默认 workspace-write);
- **sheathe**:收尾——整理 diff、生成 commit message、跑全量测试。

模式切换经 `exit_plan_mode` 式审批;工具目录跨模式不变以保请求缓存稳定。

## 4. 前端与数据流

### 4.1 TUI(`saber`)

- ratatui + crossterm,**原生 scrollback 手法**:已定稿历史直接写终端原生缓冲区(转义序列插入,零渲染成本、可原生复制),活动区只画输入框与运行中块(codex 手法)。
- 交互:Esc 中断 turn、Esc-Esc 回退(checkpoint)、`/` 命令、diff 内联渲染、markdown 流式渲染、模型/权限弹窗。

### 4.2 SwiftUI App(CodeSaber.app)

- 信息架构四区:**会话列表侧栏**(每会话=独立 git worktree,显示状态/成本/耗时)· **会话主视图**(消息流+工具调用可折叠+流式 diff)· **审批中心**(权限请求集中处理)· **任务中心**(jobs 监控);菜单栏常驻 + 全局快捷键唤起。
- 架构:SwiftUI + Observation(MV 模式);网络层为构建期生成的 Codable 客户端(UDS JSON-RPC + SSE);**App 不做业务决策,全部状态来自引擎事件流**(opencode"前端只是事件流的视图"原则)——保证 CLI/App 行为永远一致。
- 原生独占能力:Keychain、UserNotifications、菜单栏、剪贴板、FSEvents 文件监听、后续 Services/Shortcuts。

### 4.3 headless

`saber exec -p "..." --json` 输出 JSONL 事件流(M0 即具备);`--output-schema <path>` 结构化输出 = M1(定义:schema 校验、不符时一次重试、失败退出码)。这是 CI、Harbor 评测、脚本编排的统一入口。

### 4.4 数据流(一次 turn)

```
用户输入(App/TUI)→ RPC submit_prompt → 引擎 steering 队列
→ loop 组装上下文(系统提示词+历史+世界状态)→ provider 流式响应
→ EventMsg 增量(reasoning/text/tool_delta)→ JSON-RPC notification 广播全部订阅前端
→ 工具执行(权限网关→沙箱→截断)→ tool_result 追加事件日志
→ 循环直到 turn 完成 → TokenCount/成本事件 → 会话 JSONL 落盘
```

### 4.5 错误处理

- Provider 层:限流/超时指数退避重试;上下文溢出→自动 compact→重试(最多 3 次降级,kimi 手法)。
- 工具层:失败转为 `isError` 的 tool_result 回给模型(不崩溃循环);截断输出带警告头。
- 引擎层:会话日志采用 **WAL 语义**——工具副作用执行前同步落 `tool_call` intent、执行后落 result(其余事件可批量 flush);崩溃恢复时显式识别"有 intent 无 result"的未完成调用,撕裂行截断仅处理半行写入;server 崩溃由 launchd 拉起,前端自动重连+按 seq 事件重放。

## 5. 测试、评测与里程碑

### 5.1 测试策略(三层)

1. **单元/集成**:mock provider(录制/回放 LLM API 的 SSE 流,与前端协议无关)驱动完整 loop;turn/steering/压缩/权限全部可离线测;insta 快照测协议事件序列。
2. **协议一致性 CI**:JSON Schema 生成物(Swift/TS)与 Rust 类型同步校验,防前后端漂移。
3. **真机评测(Harbor)**:`BaseAgent` 适配器包 `saber exec --json`;PR 冒烟 terminal-bench 子集(10 题),夜间全量 + `--attempts 3`;私有回归集从真实工单沉淀(task.toml + Dockerfile + test.sh + solution/)。每次 prompt/工具改动都要有分数。

### 5.2 里程碑

- **M0 引擎骨架**:workspace + protocol + provider 两家(OpenAI 兼容 + Anthropic)+ loop + 6 工具 + JSONL 会话(WAL 语义)+ **最小 Seatbelt 沙箱(写边界+禁网+子进程环境白名单)**;`saber exec` 完成"读→改→跑测试";质量门禁全套上线(lints/cargo-deny/insta)。验收:Harbor 10 题基线分。
- **M1 可用 CLI**:TUI + steering + 权限三档 + compaction 两层 + resume + headless(`--output-schema <path>` 结构化输出)+ 第三家 provider(Ollama)+ **failover** + **`saber replay` 回放器** + OTel trace。验收:日常自用一天不打断;夜间回归无退化。
- **M2 Mac App**:saber-server 常驻 + Swift 协议生成 + App 四区 + worktree 并行会话 + 通知 + **协议 v1 冻结(兼容性进 CI)** + `read_image`/App 粘贴图片。验收:App 与 CLI 互通同一会话;签名公证发布;**Terminal-Bench 2.0 ≥40%**。
- **M3 差异化纵深**:draw/strike/sheathe 模式化 + jobs + MCP(延迟加载默认)+ Skills(SKILL.md 双通道)+ 成本看板 + egress proxy + App inspector tab + hooks(exec 式六事件)。验收:**Terminal-Bench 2.0 ≥55%**;App 内完成一次并行双会话真实任务。

### 5.3 明确不做(YAGNI)

内嵌 JS 插件运行时;Windows/Linux 沙箱(跨平台只留抽象缝隙);订阅 OAuth(MVP);云同步/团队协作;自训模型;**audio/video 多模态**。v2 再评估:Starlark 完整策略引擎、模型智能路由、WASM 插件 ABI、多机 attach、auto-memory(opt-in)。

License:**Apache-2.0**——LICENSE 文件与 README 同步落地于 M0-T8(设计文档本身不构成授权)。App 最低系统版本:**macOS 14+**(SwiftUI Observation 基线)。

## 6. 参考实现映射(抄哪儿)

| 模块 | 参考仓库 | 位置 |
|---|---|---|
| turn/step 循环、mid-turn steering | codex | `codex-rs/core/src/session/turn.rs` |
| length 拒执行、retry、JSONL 会话树 | pi | `packages/agent/src/agent-loop.ts`、`session-manager.ts` |
| edit 容错链、bash AST 权限、doom-loop | opencode | `packages/opencode/src/tool/edit.ts`、`tool/shell.ts` |
| 沙箱编排、Seatbelt、rollout | codex | `codex-rs/core/src/tools/orchestrator.rs`、`sandboxing/src/seatbelt.rs` |
| jobs 语义、输出即契约 | dsh | `packages/jobs/jobs/src/index.ts` |
| 子代理/profile(未来) | kimi-code | `agent-core-v2/src/session/agentLifecycle/` |
| TUI scrollback 手法 | codex | `codex-rs/tui/src/insert_history.rs` |
| 评测 | Harbor | harbor-framework/harbor |

## 7. 架构天花板决策(grilling 三轮,2026-08-19,23 项全部确认)

### 7.1 决策记录表

**Round 1 — 架构天花板**

| # | 决策 |
|---|---|
| 1 | 扩展策略:能力注册统一走 Registry 抽象留缝隙;v1 扩展面只开 hooks+MCP+Skills;WASM ABI 后推 |
| 2 | Session 一等公民 + **Workspace trait**(LocalWorktree / InRepo / 未来 Remote·Docker);并行会话默认 worktree 隔离,串行可直接在 repo 内 |
| 3 | 子代理抽象现在冻结:Agent Profile 注册表 + 可嵌套子 session(Task 工具 M3 再发) |
| 4 | 内部消息模型 day 1 全深度:thinking/reasoning 块、reasoning effort、prompt cache 断点、图片内容块 |
| 5 | 存储:JSONL 唯一事实源 + SQLite 只读索引;不变量 "index is derivable" |
| 6 | OTel trace day 1(span:turn/step/tool/provider);`saber replay` M1 |
| 7 | 量化验收:Terminal-Bench 2.0 M2 ≥40%、M3 ≥55% |
| 8 | 网络:M1 沙箱内默认禁网+审批放行;M3 egress proxy(带白名单,兼作 MCP OAuth token 防护基础) |

**Round 2 — 协议与编排**

| # | 决策 |
|---|---|
| 9 | hooks = exec 式(对齐 Claude Code:JSON stdin,退出码 0=放行/2=阻断且 stderr 回给模型)+ 进程内事件总线(引擎自身功能载体);v1 六事件:PreToolUse/PostToolUse/UserPromptSubmit/Stop/PreCompact/SessionStart;**PreToolUse deny 优先级高于一切模式(含 full-access)** |
| 10 | 协议:单 UDS 连接**双向** JSON-RPC,`subscribe(session_id)` 订阅、通知带 session 路由;App v1 严格用内嵌 sidecar(版本强锁定),attach 外部实例 M3+ |
| 11 | worktree 生命周期:SessionManager 全权;自动建(`saber/<slug>-<id>` 分支);**绝不自动删除有未合并提交/脏文件的 worktree**;归档时引导 merge & clean |
| 12 | 子代理规则:权限只收不放(子 ⊆ 父)、最大深度 2、仅 full 模式可 spawn、后台子代理持久化可 resume |
| 13 | MCP:命名空间 `mcp__server__tool` + description 截断(2048)+ **延迟加载默认**(tool_search 按需拉,codex ToolExposure::Deferred);stdio+HTTP;OAuth/elicitation 后置 |
| 14 | 模型路由:failover v1(同请求失败自动换备用);智能路由 v2;成本 = usage 权威 + chars/4 估算 + 静态价格表 + 会话/日预算软告警 |
| 15 | 记忆:AGENTS.md 层级只读注入(沿祖先链,兼容读 CLAUDE.md);auto-memory = v2 且默认 opt-in |
| 16 | 质量门禁 M0 起:workspace lints(deny unwrap/expect + clippy -D warnings)+ cargo-deny + cargo-audit + insta 快照 + 依赖锁定 |

**Round 3 — 收尾细节**

| # | 决策 |
|---|---|
| 17 | 多模态:M2 给 `read_image` 工具 + App 粘贴图片;不做 audio/video |
| 18 | Skills 双通道(pi 式):系统提示词只常驻清单(name+description),正文由模型 read 自取;`/skill-name` 手动展开 |
| 19 | 调试:M1 `saber replay`(快进/过滤/事件树,事件日志直接投影);M3 App inspector tab |
| 20 | 版本:协议独立 semver,v1 于 M2 冻结、兼容性进 CI;引擎/CLI/App 同 repo 同 tag;0.x 每周 tag,M3 后按需 |
| 21 | License:Apache-2.0(LICENSE 文件与 README 随 M0-T8 落地) |
| 22 | plan 载体:`.codesaber/plans/<session>-<slug>.md` 结构化 markdown(frontmatter status:drawn/striking/shipped);draw 产出、strike 消费、sheathe 归档,跨会话可复用、可 git 提交 |
| 23 | App 最低系统版本 macOS 14+(SwiftUI Observation 基线) |

### 7.2 增补设计细节

- **Workspace trait**(saber-core):`fn resolve(path) / fn apply_patch(...) / fn exec(...)` 之类的文件系统与执行视图接口;LocalWorktree/InRepo 是 v1 实现,Remote/Docker 留缝。沙箱与未来远程执行共用这条缝,工具 schema 不感知实现。
- **Agent Profile**:注册表(profile = 工具白名单 + 提示词 overlay + 权限继承声明 + summaryPolicy);v1 内置 `agent`(全量)/`explore`(只读)/`coder`(M3 子代理用);子 session 复用引擎全部服务,消息上下文从零开始(kimi 手法)。
- **审批协议**(双向 JSON-RPC 的第一个反向调用):`approval/request` → 前端展示命令/diff/触发规则 → `approval/response {once|always|reject}`;always 按 AST 前缀+路径集记忆;reject 级联同会话 pending(opencode 手法)。
- **failover 配置**:`[model_failover] primary = "anthropic/claude-..." fallback = ["openai-compat/deepseek-...", "ollama/qwen3-coder"]`,限流/超时/5xx 触发,同 turn 内最多切换 2 次。
