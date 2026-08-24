# Codex vs DeepSeek Harness(dsh)横向对比

> 版本锚点:codex `c9b19de`(2026-08-23,rust-v0.149.1 stable);dsh `dsh-v0.1.0-rc.7`(2026-08-17,npm latest 0.1.1-rc.2 / 08-21)。
> 单项深挖见 `01-codex-rs.md` 与 `03-deepseek-dsh.md`;本文只做横向对比与结论。

## 0. TL;DR:两家公司,两个相反的赌注

- **codex 是产品公司的赌注**:"一个 Rust 多进程内核 + N 个前端"的产品家族,服务 500 万周活。工程重心是**治理**:14,130 个测试函数、五平台 CI 矩阵、122 个 feature flag 的渐进发布体系、每天多个 alpha 的发布流水线。
- **dsh 是研究实验室的赌注**:"一切皆插件"的 harness 平台实验,连 agent 循环、工具管线、UI 渲染都是插件,没有特权核心。工程重心是**契约**:221 个包、per-file 100% 覆盖率门禁、keyless 快照回放、双语文档的 hash 配对契约、"model-visible ⟺ logged" 运行时断言。
- **收敛点(已是 2026 年 table stakes)**:事件溯源会话日志、工具结果截断+外溢、auto-compaction、多智能体独立上下文、Code Mode(模型写代码编排工具)、沙箱+审批双层安全。
- **分歧点**:进程模型(多进程内核 vs 单进程插件树)、开放度(锁 OpenAI 栈 vs provider 无关、甚至能把 codex/claude-code 当子 agent)、远程执行(codex 重投入 exec-server vs dsh 刻意封死 `--host 0.0.0.0`)、终端形态(TUI 优先 vs Web 优先)。

## 1. 基本盘

| 维度 | codex | dsh |
|---|---|---|
| 出品方 | OpenAI(商业产品,Apache-2.0 开源) | DeepSeek(developer preview,承诺破坏兼容) |
| 语言/形态 | Rust workspace,130+ crates | TypeScript pnpm monorepo,221 个 npm 包(+9 vendor) |
| 代码规模 | 约 146 万行 Rust | 约 43 万行 TS(packages src) |
| 测试规模 | ~14,130 个测试函数;core 集成场景 126 个;745 个 insta 快照 | 六条 vitest lane + pytest;per-file 100% 覆盖门禁 |
| 发布节奏 | stable 每周 2-3 个,alpha 几乎每天(0.149.x) | 11 天 10 个 rc(0.0.1→0.1.1-rc),约每日一发 |
| 社区 | ~103k stars(8 月初),5M 周活 | 8-13 开源,~183k stars / 9 天(病毒式) |
| 产品成熟度 | 生产级(签名+公证、五平台) | 0.x 预览(Windows CI 靠 Wine 15 分钟兜底) |
| 分发 | npm `@openai/codex` + 6 平台子包 + TS/Python SDK | npm `@deepseek-ai/dsh-*` 221 包 + Python SDK(内置单文件可执行 runtime) |

一个刺眼的对照:codex 用 **3.4 倍的代码量**做出了五平台签名分发;dsh 用 **1/3 的代码量**做出了 221 包的插件架构和更严格的覆盖率门禁。这不是谁更好的问题,是两种工程美学的极致。

## 2. 产品哲学:治理的艺术 vs 契约的艺术

**codex 的世界里,一切改动都要能安全地到达 500 万用户手里**:

- 122 个 feature flag 按 Stable/UnderDevelopment/Experimental/Deprecated/Removed 分级(`features/src/lib.rs:828` 起),38 个 Stable 默认开、42 个在途、39 个已移除但保留 no-op 兼容——功能退场也是被治理的生命周期。
- 发布链全自动:tag 驱动 → Azure Key Vault 签名 + macOS 公证 → 6 个平台子包 npm 发布;`rust-release-prepare.yml` 每 4 小时 cron 自动更新 models.json 并开 PR。
- 遥测分两级:OTel 指标(默认 Statsig 端点)+ 业务 analytics 事件(POST 到 ChatGPT 后端)。CLI 默认关,**VS Code 扩展默认开**(`cli/src/main.rs:576-592`)——按渠道区分隐私默认值,这是产品公司的精细。

**dsh 的世界里,一切都要可组合、可审计、可回滚**:

- 连框架都 vendor 进来:重命名进 `@deepseek-ai` scope、锁 commit、记录全部本地改动("the harness fully owns its framework layer")。
- 文档是带强制契约的:每个 doc 三件套 `foo.md + foo.zh.md + foo.i18n.yaml`,yaml 记录两侧"最后确认语义一致"时的 git blob hash,CI 校验、专用 git merge driver 处理冲突。
- 有编号的 postmortem(0001-0004)、每个扩展缝隙一份 Agent Note、每个包 README 声明 KV-cache 影响——这是实验室的实验记录纪律。

## 3. 架构:多进程内核 vs 单进程插件树

**codex:进程边界隔离关注点**。`app-server`(JSON-RPC,stdio/unix/ws 三种传输,`app-server/src/main.rs:29-36`)是所有前端的统一后端;执行被抽象成 `Environment`——本地沙箱或远端 `exec-server`(独立进程,WS/stdio);Code Mode 有独立 host 进程(甚至可 gRPC 远程)。前端列表:TUI(Embedded 进程内 / LocalDaemon 共享 socket / Remote ws 三种 target,`tui/src/lib.rs:275-279`)、VS Code 扩展(默认 session-source 就是 vscode,`protocol/src/protocol.rs:2587-2598`)、`codex app` 桌面应用、`codex remote-control` 手机遥控(经 ChatGPT 后端外拨配对)、`codex cloud` 云任务、`codex mcp-server`(反向服务其他 agent)、TS SDK(包 `codex exec --json`)、Python SDK(直开 app-server)。

**dsh:插件作用域隔离关注点**。单个 Node 进程跑全部:agent 循环 + HTTP/WebSocket 服务 + 静态 SPA,浏览器只是远程渲染器。上行 HTTP POST `/api/*`,下行**两条专用 WebSocket**(events.mux 全 session 聚合流 + events.host)——特意用 WS 而非 SSE,是为了绕开 HTTP/1.1 每源 6 连接限制;断线按 `since: Record<SessionId, number>` 续传。类型化调用面由 Typert 构建期从 `@Remote` 装饰器生成端到端契约。**远程访问被刻意封死**:`dsh web --host 0.0.0.0` 直接报错 "intentionally not supported yet for safety: it would expose remote code execution to the network"(`bundle/web-app/src/startup.ts:69-70`)。

对照结论:codex 回答"怎么让一个内核服务十种形态的客户端"——答案是进程协议化;dsh 回答"怎么让一个进程内的所有能力都可替换"——答案是注册表+作用域遮蔽(agent → preset → global 就近遮蔽)。**codex 的扩展单元是进程,dsh 的扩展单元是插件**。

## 4. Agent 循环

| 维度 | codex | dsh |
|---|---|---|
| 术语 | turn(内部 StepContext 快照 + run_sampling_request) | turn = 零或多 step;step = 一次模型请求 + 工具调用 |
| 用户中途干预 | mid-turn steering:模型运行中从 input_queue 取新输入(`session/turn.rs:285-292`) | 单一 Inbox 三种投递:`followup()` 下轮唤醒 / `steer()` 下步唤醒 / `inject()` 不唤醒(`core/agent-loop/src/agent.ts:122-132`) |
| 压缩触发 | turn 前 pre-sampling compact + turn 中 token 超限双触发,阈值 90% 窗口;保留全部用户消息 | `agent/pre-step` 自动触发,tokenMeter 压力测量,selectCompactableRange 保留 retainTokens |
| 请求可定制性 | 模型流内固定;stop hooks 可拦截收尾 | 全链路 waterfall:`agent/pre-step`(可拒绝)、`agent/request`(可改 config)、`agent/request-error`(可决定 retry) |
| KV cache 策略 | 服务端:同 turn 复用 WebSocket 与 `previous_response_id` 命中 Responses API 服务端缓存(`core/src/client.rs:254-297`) | 客户端:prompt 段有序稳定、plan 模式不换工具目录、每个包 README 声明 KV-cache 影响 |
| 维护相位 | 无(压缩内联在 turn 生命周期) | `runMaintenance()`:compaction 等不与模型轮次竞争 |

steering 语义是最有意思的分歧:codex 只有一种"排队注入",dsh 区分了三种唤醒粒度(轮级/步级/不唤醒)——dsh 的语义更细,但 codex 的实现伴随服务端缓存续用,工程上更省。

## 5. 工具系统

**定义方式**:codex 的 `ToolSpec` 直接序列化为 API 的 tools JSON(schema 单一来源),apply_patch 用 freeform custom tool + Lark 文法约束输出(`tools/src/tool_spec.rs:22-56`);dsh 的 `ToolDefinition` 强制声明 `output: { schema, render, presentationMeta }`——**输出即契约**:工具 body 只返回 canonical lossless-JSON value,渲染是纯投影,UI 回放与模型内容解耦(`core/tools/src/index.ts:222-288`)。dsh 的设计对"会话回放/审计"更友好,codex 的设计对"API 侧 schema 一致性"更省心。

**并发调度**:codex 走 `ToolRouter` + parallel 支持声明;dsh 是三态分组——`isConcurrencySafe` 只有精确 `true` 才进并行组(fail-closed),exclusive 调用成屏障,parallel 进有界滚动池;abort 时为未启动调用补写合成错误结果保证 replay 有效。**dsh 的调度器语义文档化程度明显更高**。

**编辑文件**:codex 只保留 `apply_patch`(上下文锚 + 前缀行的自定义补丁格式,独立 crate + 独立二进制);dsh 用 Claude Code 风格 `str_replace_editor`(旧串必须唯一匹配)+ 独立 read/write/edit 工具。codex 押注"补丁格式对模型更稳",dsh 押注"字符串替换最不容易幻觉"——两个都工作,因为两边都配了强校验。

**输出治理**:codex 按 tokens/bytes **中部截断**保头尾,加警告头(`utils/output-truncation`);dsh 三层——tool-result-pruner(阈值 8192 字符,头 4096/尾 1024)→ spill-policy(超 50KB inline 上限外溢到存储留 locator)→ presentationMeta。dsh 的 spill-to-disk 方案与 CodeSaber 现有设计同构。

### Code Mode 对比(两家都做了,路线不同)

| 维度 | codex `exec` 工具 | dsh `run_code` 工具 |
|---|---|---|
| 语言 | JavaScript | TypeScript(已发布后端);Python SDK 已生成、后端未发布 |
| 执行环境 | Rust 宿主内嵌 **V8 isolate**(deno_core,v8_enable_sandbox)**无 Node、无 fs、无网络** | 每次 run 一个全新 **Node worker_threads.Worker**;`stripTypeScriptTypes` 剥类型后 AsyncFunction 执行;堆上限 + 双预算(computeMs 事件循环利用率 + maxWallMs)→ terminate |
| 安全定位 | V8 sandbox isolate(仍有 escape 史,但立场是隔离) | 明确声明 **"Containment, not a security boundary"**,信任等同 bash |
| 工具访问 | 代码内 `await tools.exec_command(...)` 经 dispatch broker 回送 agent 工具链 | 代码内 `await tools.name(args)`,子派发走原生并发契约,maxParallelSubCalls 默认 10 |
| 进模型上下文的内容 | cell 输出构造器(text/image/audio) | **只有外层 curated 结果**;每次子派发记 CodeDispatchLog 供重放 |
| 部署 | code-mode-host 独立进程(默认 Stable 开启);模型侧 flag `code_mode` UnderDevelopment 默认关 | 环境变量 `DSH_TOOLS_MODE=native/code/both`;code 模式下生成的类型化 SDK 是模型**唯一**的工具知识来源 |
| 配套 | `wait` 续读输出、`store/load` 跨调用键值、`yield_time_ms` 主动让出 | SDK 注册表同一份 schema 生成 TS/Py 两个投影 |

判断:dsh 的 Code Mode 更成熟(默认可用、双语言规划、子调用日志可重放);codex 的更激进(V8 真 isolate、freeform+Lark 约束、远端 host 化)但还没默认开。**"模型写代码编排工具"从两家共同押注变成了行业方向**。

## 6. 多智能体

**codex v2**:spawn 出的子 agent 是**独立 ThreadId + 独立 rollout + 独立上下文窗口**(`core/src/agent/control/spawn.rs:498-511`);fork 可继承父历史(FullHistory/LastNTurns 两档,清洗 developer 指令);`V2Residency` LRU 淘汰超容量的子线程、环境快照存盘可重载(`residency.rs:17-66`);role 层**只能减权限不能加**(`role.rs:91-118`);默认 root + 3 并发、spawn 深度 1(`config/mod.rs:225-235`);`multi_agent_v2` flag Stable 但**默认关**。内置角色只有 default/explorer/worker(awaiter 已注释移除),昵称池是科学家名。

**dsh**:`ctx.subagents` 是**多实现并存的命名注册表**,六种 provider:spawn(全新子 session,不见父历史)、fork(种子取到**最后一个 turn/end 边界**的连续前缀——刻意避开进行中 turn 的未闭合工具调用)、acp、**codex**、**claude-code**(把外部 CLI 当子 agent 后端)、dsh-sdk(递归驱动另一个 dsh)。continuable subagent = "持久子 session + 至多一个进程内 Activation",支持 admission 控制、冷恢复、直系父授权销毁。另有 Ralph 工具——Claude Code Ralph 同款"固定目标 + 每轮全新子 agent + 工作区当长期记忆 + 只传结构化 handoff",maxRounds 上限 256,纯插件实现,agent-loop 零特殊分支。

对照:dsh 的 fork-at-turn-boundary 和 "把别家 agent 当子 agent 后端" 是更开放的设计;codex 的 residency/graph-store/权限单调收窄是更规模化的工程。**dsh 甚至内置了 codex 作为子 agent 选项,而 codex 不可能反向这么做**——这本身就是两家开放度的注脚。

## 7. 会话持久化(都事件溯源,细节分野)

两家都把"会话 = append-only 事件日志"作为唯一事实源,这是 2026 年最强的行业收敛:

| 维度 | codex rollout | dsh session log |
|---|---|---|
| 格式 | 每线程一个 JSONL,`RolloutLine{timestamp, ordinal, item}`,item 覆盖 ResponseItem/EventMsg/TurnContext/WorldState/SecurityRiskScore | `SessionEvent` 追加日志;连续 assistant/chunk 打包为复合行(无损且约小 60%) |
| 压缩 | 旧文件 zstd 压缩,读取透明解压 | 默认 zstd 帧压缩,首帧独立可解且必须是 header,含撕裂帧恢复 |
| 索引 | SQLite state db 线程索引 | SQLite 后端全文检索 |
| 不变量 | 任何 UI 状态可由 rollout 重放(resume/回滚/审计共享同一数据) | **"model-visible ⟺ logged" 是运行时断言的硬不变量** |
| fork | thread/fork 子命令 | `ctx.sessions.fork(source, boundary?)`,boundary 停在 turn/end |

dsh 把不变量做成运行时断言(deriveMessages 与日志投影强制一致)比 codex 的"约定"更硬一档;codex 的 rollout 记录面更宽(TurnContext/WorldState/风险评分都在内),审计价值更高。

## 8. 安全模型

**codex:纵深防御成体系**。三平台原生沙箱(macOS Seatbelt .sbpl 策略族 / Linux Landlock+seccomp+bubblewrap / Windows 独立 crate);**Starlark execpolicy** 规则语言(prefix_rule/host_executable,"始终允许"追加规则并热更新);Guardian V2 同步评审 + 异步评分复用;**permission_profile_intersection**(793 行)——多权限配置合并做代数求交,无法不弱化合并就报错拒绝;`RedactedString` 类型级凭据脱敏;升级闭环统一在 `ToolOrchestrator::run_attempt`(预评估→沙箱执行→拒绝指纹识别→审批升级重试)。

**dsh:沙箱强制 + 按事件审批,诚实标注边界**。策略每次调用携带(不固定在 provider 上);`confine(argv, policy)` 把精确 argv 包装为受限 runner argv,后端返回自己的"拒绝方言" stderr 签名让消费方区分"被拦"与"没跑";Linux 用**自研 Landlock 启动器**(native/ 目录,C 源码 + npm 分发);无静态命令黑名单;`web_fetch` 默认不挂(SSRF 保护未做就先不开);repeat-tool-reminder(3/5/8 阈值)对死循环做建议性提醒;Code Mode / workflow 明确声明"遏制而非安全边界"。

对照:codex 的安全栈深一个数量级(策略语言、评审闭环、权限代数);dsh 的姿态更诚实克制——没做完的(SSRF、远程访问)宁可关掉也不带病上线,这一点上 `--host 0.0.0.0` 直接拒绝是教科书级的产品安全决策。

## 9. 模型接入

- **codex**:`WireApi` 只有 Responses;ChatGPT auth / API key;同 turn 复用 WebSocket 与 `previous_response_id` 命中服务端会话缓存;`models.json` 每模型带完整 instructions_template、context_window(272k-872k)、truncation_policy、shell_type、tool_mode。**锁定 OpenAI 栈**——remote-control/cloud/WS 模型都依赖 ChatGPT 后端。
- **dsh**:`LlmAdapter` 缝隙,`stream()` 是唯一必需方法;注册返回带原子 `replace()` 的句柄,**settings 变更热替换路由**;deepseek 官方直连(1M ctx 默认、off/low/high/max 四档 reasoning)+ pi-ai 多 provider;凭据只携带引用名不携带明文 key,bearer 每请求从同代快照解析;空闲看门狗 + 限流/配额/超窗结构化错误分类。

对照:dsh 的 provider 面天然开放(甚至要求"和 endpoint 同代的快照"这种细节级正确性);codex 把宝押在与自家推理服务的协同(服务端缓存、WS、压缩端点 `/responses/compact`)上。**开放性与协同优化不可兼得,两家各自选边**。

## 10. 工程纪律与测试

**codex(规模换质量)**:~14,130 测试函数;126 个集成场景由 **wiremock 伪造 SSE 的 mock 模型**驱动完整 agent 循环(不是 stub,是真实 Config+ThreadManager);745 个 insta 快照含"模型可见上下文快照"断言;CI 聚合 7 个子 workflow,合并后跑 **5 平台矩阵**(macOS/Linux x64+arm64/Windows x64+arm64,nextest);clippy -D warnings、cargo-shear、cargo-deny、Bazel 与 Cargo 双构建一致性校验、自研 dylint。

**dsh(契约换质量)**:六条 vitest lane——单元(per-file 100% 门禁 + 受版本管理的豁免清单 + 未覆盖位置 `path:line:col` 报告)、真实 API e2e(nightly)、**keyless 快照回放**(默认 replay 已录制模型响应,diff 请求/协议/转录)、Playwright web lane、perf、stress;pytest 测 Python SDK(fake runtime + 单文件可执行载体);lefthook pre-push 全量 typecheck;knip 查未用导出;**幂等发布**(按 registry integrity 三态判定:缺失则发/sha512 相同跳过/不同报错)——这是它敢每天发 rc 的工程底气。

两家的 mock 策略值得并读:codex mock **传输层**(SSE 假响应),dsh mock **模型层**(录制回放)。前者测 agent 循环的正确性,后者测协议与 prompt 的稳定性——分别对齐各自的最大风险面。

## 11. 遥测与隐私

| 维度 | codex | dsh |
|---|---|---|
| 信号 | OTel 指标/日志/trace + 业务 analytics 事件 | **仅 OTel logs** |
| 默认 | CLI 关 / VS Code 扩展开;`log_user_prompt` 默认 false | **DISABLED**(三态 FULL/FEEDBACK_ONLY/DISABLED) |
| 上报到哪 | Statsig 指标端点 + ChatGPT 后端 analytics | DeepSeek 自有 OTLP 端点(opt-in) |
| 退出 | `[analytics] enabled = false` | `DSH_TELEMETRY_DISABLED` 任意非空即整行 patch 掉;CI 强制关 |
| 身份 | ChatGPT 账号体系 | 匿名 UUID(删文件即重置) |

## 12. 收敛与分歧:对 2026 格局的启示

**已经收敛成 table stakes 的**(任何新 agent 不做就是落后):

1. 会话 = 事件溯源 JSONL(+压缩+SQLite 索引),resume/fork 是日志投影;
2. 工具输出治理(截断 + 外溢到盘);
3. auto-compaction(turn 前后双触发 / pre-step 触发);
4. 多智能体 = 独立上下文 + 独立持久化 + 受控通信;
5. Code Mode(模型写代码编排工具);
6. 沙箱 + 审批双层安全,且"没做完的宁可默认关";
7. MCP 接入(codex 双向,dsh 经 subagent 外接)。

**依然分歧的**(说明还未有定论,是差异化空间):

- **进程模型**:多进程协议化 vs 单进程插件化——没有第三方验证过哪条路对二次开发更友好;
- **开放度**:dsh 能把 codex/claude-code 当子 agent,codex 深度锁 OpenAI 推理栈——"编排一切" vs "协同优化";
- **终端形态**:codex 押 TUI(还发明了原生 scrollback 渲染),dsh 押 Web(连 Electron 都还是规划项)——**没有任何一家同时做好 TUI + Web + 同引擎跨端会话**,这个空位依然存在;
- **远程执行的时机**:codex 已经做到 Noise 后量子加密 relay 打洞,dsh 认为没有认证层之前远程就是 RCE——两家的安全阈值差了一个身位。

## 13. 对 CodeSaber 的启示

1. **通用 agent 的军备门槛已被拉爆**:14k 测试 / 五平台签名分发 / 每日 alpha 是 codex 的常态,183k star / 每日 rc 是 dsh 的起点。正面追平毫无胜算,垂直化或引擎库化是仅剩的位置(与此前战略结论一致,且更强化)。
2. **dsh 给"引擎库/编排层"方向提供了存在性证明**:它的 subagent registry 能外接 codex 和 claude-code,说明"用更薄的层编排成熟 agent"是被市场接受的产品形态;它的 capability seam(fs/subprocess 指向远端沙箱即可整体搬迁)是库设计的优秀范本。
3. **可以直接借鉴的工程件**(按性价比排序):dsh 的 keyless snapshot replay 测试策略、幂等发布、credential 0600 强制校验、settings 热更 + 保留注释的原子写;codex 的 `codex exec --json` 三级事件模型(thread/turn/item,`exec/src/exec_events.rs:7-32`)是我们 server 对外协议的最佳蓝本、输出中部截断、permission intersection。
4. **需要放弃的执念**:自建沙箱做到 codex 深度(三平台 + 策略语言)对一个新项目不现实;dsh 的"诚实标注 + 宁可默认关"是更可行的安全姿态。
5. **仍然空着的位置**:TUI + Web 同引擎(两家各占一端);TS 栈里"可嵌入的 agent 引擎库"(dsh 是 221 包的应用,不是库;codex 是 Rust 二进制产品)。

## 附:数据来源

- 本仓库内深挖:`01-codex-rs.md`(codex 全量 + 2026-08-23 增量)、`03-deepseek-dsh.md`(dsh 全量)。
- 本次增量调研(2026-08-24):codex 产品形态矩阵/多智能体 v2/exec-server/Code Mode/exec JSONL/CI 配置/feature flags/遥测;dsh Web 架构/ACP/SDK/subagent 六后端/workflow/Ralph/Code Mode worker/terminal PTY/测试六 lane/发布工程/凭据/遥测/双语文档契约——均出自两个仓库的 file:line 级核实。
- 社区数据:[Gradually.ai Codex Statistics](https://www.gradually.ai/en/codex-statistics/)(103,504 stars,2026-08-03)、[BestGeneralAIAgents 2026 指南](https://bestgeneralaiagents.com/blog/openai-codex-chatgpt-coding-agent-guide-2026/)(~105.7k)、[Flowtivity: DeepSeek Harness 95k stars in 2 days](https://flowtivity.ai/blog/deepseek-harness-open-source-agent-explained/)、[GitHub deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(~183.6k,2026-08-22)。
