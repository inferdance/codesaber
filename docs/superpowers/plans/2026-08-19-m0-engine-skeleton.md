# M0 实施计划:CodeSaber 引擎骨架

> 日期:2026-08-19。上游 spec:`docs/superpowers/specs/2026-08-19-codesaber-mac-coding-agent-design.md`。
> M0 目标:可 headless 完成真实编码任务的最小引擎 + 质量门禁 + 评测基线。**不含** TUI、server、App、权限审批 UI;**含**最小 Seatbelt 沙箱(bash 跑在沙箱内)+ 引擎级写路径策略(write/edit,见 T4/T4b)。

## Definition of Done

1. `saber exec -p "任务"` 在真实仓库完成"读 → 改 → 跑测试"闭环,输出 JSONL 事件流;
2. Harbor adapter 就绪,terminal-bench 子集 10 题跑出基线分(数字记录进 `docs/eval/baseline-m0.md`);
3. 质量门禁全绿:workspace lints(deny unwrap/expect)+ `clippy -D warnings` + `cargo-deny`(单门禁:advisories/bans/licenses/sources;cargo-audit 维护者已退出,不采用)+ cargo-shear + insta 快照 + 依赖锁定;
4. 协议 JSON Schema artifact 构建期生成(`saber-protocol/schema/`),CI 校验与 Rust 类型同步;
5. mock provider 驱动的 loop 集成测试覆盖:正常 turn / length 拒执行 / doom-loop / 工具失败回错;
6. 边界测试:bash 写 cwd 之外被拒、网络被拒、`.ssh`/`.env` 读被拒、子进程 `env` 中无 `SABER_*`/密钥变量(环境白名单生效)、write/edit 越界路径被引擎拒绝。

## 环境前置

- Rust stable + nightly fmt(clippy/rustfmt);ripgrep 以库形式(grep 搜索器直接复用 `grep` crate 系);
- 测试 API key 经环境变量注入**引擎进程**(`SABER_ANTHROPIC_KEY` / `SABER_OPENAI_COMPAT_*`);工具子进程环境一律白名单(只传 PATH/HOME/LANG/TMPDIR),密钥绝不进入子进程环境。CI 用 mock provider,真机评测本地/夜间跑。

## 任务分解(按依赖排序)

### T1 Workspace 脚手架(0.5d)
- cargo workspace:9 crates 骨架(protocol/core/tools/provider/sandbox/jobs/mcp/server/cli;M0 激活 protocol/core/tools/provider/sandbox/cli,其余空壳占位防后续大挪移);
- `[workspace.lints]`:deny unwrap/expect/clippy::all -D;rustfmt.toml;deny.toml(license=Apache-2.0 兼容、advisory);Cargo.lock 提交;测试跑 cargo-nextest;
- GitHub Actions:fmt + clippy + nextest + cargo-deny + cargo-shear + nightly schedule 触发(重跑全部门禁捕捉新 advisories);schema-sync 随 T2(schema artifact 诞生时)加入 PR 与 nightly。
- 验收:CI 全绿样板。

### T2 saber-protocol v0(1d)
- 内部消息模型(spec §3.4/R1-Q4 全深度):`Message{role, blocks}`,`Block = Text | Thinking | ToolCall | ToolResult | Image`;`Usage{input,output,cache_read,cache_write,cost}`;
- `EventMsg` v0:`TurnStarted/TurnComplete/StepStarted/AssistantDelta(Text|Thinking|ToolCallDelta)/ToolStarted/ToolOutputDelta/ToolCompleted/TokenCount/Error`;
- 会话 JSONL 事件 schema(`{ts, seq, session_id, type, payload}`,type 覆盖 session_meta/user_message/assistant_message/**tool_call(WAL intent,副作用前同步落盘)**/tool_result/error/compaction);
- schemars 导出 + `schema/` artifact 写盘任务(build.rs 或 xtask)。
- 验收:insta 快照锁定 schema;schema-sync CI 通过。

### T3 saber-provider(2d)
- `Provider` trait:`stream(request) -> Stream<ProviderEvent>`(错误编码进流,禁止 panic——pi 契约);
- HTTP 用 reqwest 0.13(默认 rustls);**SSE 解析自研**(~100 行:LLM SSE 只是 `data:` 行 + `[DONE]`;reqwest-eventsource 已停维护,不用);
- OpenAI 兼容 adapter(/chat/completions + SSE 解析 + tool call 增量拼装)+ Anthropic Messages adapter(含 thinking 块、cache_control 断点);
- 重试:限流/超时指数退避(基础版,failover 完整版 M1);
- usage/成本记账(静态价格表进 config);chars/4 估算 fallback;
- **MockProvider**:fixtures 录制/回放(真实响应样本 + 注入故障:截断、限流、坏 JSON)。
- 验收:两 adapter 对同一 mock 会话产出归一化的内部事件流;故障注入测试通过。

### T4 saber-tools(2.5d)
- `ToolDefinition` 契约:`name/description/schema/execute + concurrency_safe/timeout_ms/permission_rule/render(可选)`;Registry(IndexMap 保序);调度器 v0:读写两类资源冲突检测,读并行写串行;
- 六工具:
  - `bash`:**经 T4b Seatbelt 执行**、进程树超时杀、输出头尾截断 + 全量落 `~/.codesaber/truncations/`(7 天);
  - `read`:cat -n 行号、2000 行/单行 2000 字符、二进制探测;
  - `write`/`edit`:**引擎级写路径策略**——目标路径 canonicalize 后必须落在 cwd 或 `~/.codesaber/` 前缀内,越界直接拒绝(write/edit 在引擎进程内执行,引擎因需外调 LLM 不能自身入沙箱;M1 评估下放沙箱执行器执行,codex 的 apply_patch 即走沙箱执行);write 要求存在文件先 read(会话状态校验);
  - `edit`:old/new 唯一替换 + 容错链前六级 + disproportionate 防护 + 每文件互斥 + CRLF/BOM 保留;路径策略同 `write`;
  - `grep`/`glob`:`grep-searcher`/`grep-regex`(ripgrep 内核)+ `ignore`/`globset`/`walkdir`(globwalk 已进维护模式,不采用);
- 提示词侧工具描述遵循 Claude Code 手法(细则进 description 不进系统提示词)。
- 验收:edit 容错链测试矩阵(≥20 case);并行/互斥调度测试。

### T4b saber-sandbox 最小 Seatbelt(1d)
- `sandbox-exec` 策略模板(M0 档 `workspace-write-lite`,参照 codex `sandboxing/src/*.sbpl`):`(deny default)` 起步,放行 process-exec/fork、sysctl-read(含 `hw.optional.arm.*`)、PTY、cfprefs;可写 = canonicalize 后的 cwd + `~/.codesaber/`(⚠️ `/var`→`/private/var` 归一化;排除子路径用 `require-not (literal)` + `(subpath)` 双条);其余只读;
- **读侧防护**:显式 `(deny file-read* (subpath "~/.ssh"))` + workspace 内 `**/.env` glob deny(TCC 不救场,子进程继承终端 Full Disk Access);
- **M0 全禁网**(策略不写任何 network allow 即默认拒绝):LLM API 调用在沙箱外引擎主进程,子进程无需网络;M1+ 需要装依赖时再评估 codex 式本地代理;
- 子进程环境白名单(只传 PATH/HOME/LANG/TMPDIR),引擎密钥不进子进程;沙箱只覆盖 bash 等子进程执行,write/edit 的边界由引擎路径策略保证(见 T4);
- M1 的权限网关/审批升级在此之上接入(本任务只做强制边界,不做审批)。
- 验收:DoD#6 沙箱边界测试三件套(cwd 外写被拒 / 网络被拒 / env 无密钥)+ `.ssh`/`.env` 读被拒。

### T5 saber-core loop + session(2.5d)
- `SessionManager`:JSONL 追加写,**WAL 语义**——工具副作用执行前同步落 `tool_call` intent(fsync)、执行后落 result,其余事件(assistant delta 等)批量 flush;启动重建投影;恢复时显式识别"有 intent 无 result"的未完成调用;会话目录 `~/.codesaber/sessions/<ts>-<id>/`;
- turn/step loop:`run_turn`(steering 队列接口先留,headless 无生产者)、三防线(length 拒执行/doom-loop 3 次转终止+报错/stop hook 挂点);
- prompt assembler v1:静态段(身份/输出规范,参照 Claude Code 骨架)+ 环境块(cwd/git/平台/日期)+ 工具节(动态生成)+ AGENTS.md(祖先链聚合,兼容 CLAUDE.md);静态前动态后排序;
- token 水位事件(TokenCount);溢出→报错退出(M0 不做 compact,compaction 是 M1)。
- 验收:mock 集成测试五场景(DoD#5);崩溃恢复测试覆盖工具执行边界(kill -9 于"intent 已落、副作用已发生、result 未落"时刻,重建后标记未完成调用而非重放)+ 尾行撕裂截断。

### T6 saber-cli headless(1d)
- `saber exec -p "<prompt>" [--json] [--model]`(`--output-schema <path>` 挪 M1:M0 不实现,避免无验收的半成品开关);非交互权限策略 v0 = **bash 由 T4b Seatbelt 强制,write/edit 由引擎路径策略强制**(禁网+环境白名单见 T4b/T4);敏感路径(.env/秘钥)在 read/write/edit 工具层硬拒绝(提示层,与强制层双保险);
- 退出码与事件流契约文档化。
- 验收:DoD#1 端到端。

### T7 Harbor adapter + 基线(1d)
- `eval/harbor-agent/`:BaseAgent 子类 + `install-saber.sh.j2`(下载 release 二进制或 cargo build)+ run 走 `saber exec --json`;
- 跑 terminal-bench 子集 10 题(确定性强的),结果与逐题 trace 存 `docs/eval/baseline-m0.md`。
- 验收:基线分落盘。

### T8 文档与收尾(0.5d)
- README 更新(M0 能力/限制;安装命令改为 brew/cargo,移除 npm 表述);仓库自身 AGENTS.md(贡献规范、质量门禁说明);提交 LICENSE(Apache-2.0 全文)并同步 README 许可证段落。

## 风险与对策

| 风险 | 对策 |
|---|---|
| Provider schema 漂移(尤其 tool call 增量格式) | fixtures 录制真实响应;归一化层单测钉死 |
| edit 容错链过度宽松改错位置 | 测试矩阵 + disproportionate 防护默认开 |
| Seatbelt 策略与 macOS 版本行为差异 | 以 codex `.sbpl` 模板为基线;沙箱测试标记 macOS-only,CI 加 macOS runner |
| Harbor 跑分环境与本地不一致 | 用官方 dataset 固定 commit;trace 全存档可复现 |

## 估时

约 12.5 人日(T1→T8 串行依赖,新增 T4b 1d);T2/T3 可并行,T4/T3 可并行,压缩后日历时间 ~8 天。
