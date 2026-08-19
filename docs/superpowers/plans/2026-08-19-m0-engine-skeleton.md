# M0 实施计划:CodeSaber 引擎骨架

> 日期:2026-08-19。上游 spec:`docs/superpowers/specs/2026-08-19-codesaber-mac-coding-agent-design.md`。
> M0 目标:可 headless 完成真实编码任务的最小引擎 + 质量门禁 + 评测基线。**不含** TUI、server、App、沙箱、权限审批 UI。

## Definition of Done

1. `saber exec -p "任务"` 在真实仓库完成"读 → 改 → 跑测试"闭环,输出 JSONL 事件流;
2. Harbor adapter 就绪,terminal-bench 子集 10 题跑出基线分(数字记录进 `docs/eval/baseline-m0.md`);
3. 质量门禁全绿:workspace lints(deny unwrap/expect)+ `clippy -D warnings` + `cargo-deny` + `cargo-audit` + insta 快照 + 依赖锁定;
4. 协议 JSON Schema artifact 构建期生成(`saber-protocol/schema/`),CI 校验与 Rust 类型同步;
5. mock provider 驱动的 loop 集成测试覆盖:正常 turn / length 拒执行 / doom-loop / 工具失败回错。

## 环境前置

- Rust stable + nightly fmt(clippy/rustfmt);ripgrep 以库形式(grep 搜索器直接复用 `grep` crate 系);
- 测试 API key 经环境变量注入(`SABER_ANTHROPIC_KEY` / `SABER_OPENAI_COMPAT_*`),CI 用 mock provider,真机评测本地/夜间跑。

## 任务分解(按依赖排序)

### T1 Workspace 脚手架(0.5d)
- cargo workspace:9 crates 骨架(protocol/core/tools/provider/sandbox/jobs/mcp/server/cli;M0 只激活 protocol/core/tools/provider/cli,其余空壳占位防后续大挪移);
- `[workspace.lints]`:deny unwrap/expect/clippy::all -D;rustfmt.toml;deny.toml(license=Apache-2.0 兼容、advisory);Cargo.lock 提交;
- GitHub Actions:fmt + clippy + test + deny + audit + schema-sync( PR 与 nightly)。
- 验收:CI 全绿样板。

### T2 saber-protocol v0(1d)
- 内部消息模型(spec §3.4/R1-Q4 全深度):`Message{role, blocks}`,`Block = Text | Thinking | ToolCall | ToolResult | Image`;`Usage{input,output,cache_read,cache_write,cost}`;
- `EventMsg` v0:`TurnStarted/TurnComplete/StepStarted/AssistantDelta(Text|Thinking|ToolCallDelta)/ToolStarted/ToolOutputDelta/ToolCompleted/TokenCount/Error`;
- 会话 JSONL 事件 schema(`{ts, seq, session_id, type, payload}`,type 覆盖 session_meta/user_message/assistant_message/tool_result/error/compaction);
- schemars 导出 + `schema/` artifact 写盘任务(build.rs 或 xtask)。
- 验收:insta 快照锁定 schema;schema-sync CI 通过。

### T3 saber-provider(2d)
- `Provider` trait:`stream(request) -> Stream<ProviderEvent>`(错误编码进流,禁止 panic——pi 契约);
- OpenAI 兼容 adapter(/chat/completions + SSE 解析 + tool call 增量拼装)+ Anthropic Messages adapter(含 thinking 块、cache_control 断点);
- 重试:限流/超时指数退避(基础版,failover 完整版 M1);
- usage/成本记账(静态价格表进 config);chars/4 估算 fallback;
- **MockProvider**:fixtures 录制/回放(真实响应样本 + 注入故障:截断、限流、坏 JSON)。
- 验收:两 adapter 对同一 mock 会话产出归一化的内部事件流;故障注入测试通过。

### T4 saber-tools(2.5d)
- `ToolDefinition` 契约:`name/description/schema/execute + concurrency_safe/timeout_ms/permission_rule/render(可选)`;Registry(IndexMap 保序);调度器 v0:读写两类资源冲突检测,读并行写串行;
- 六工具:
  - `bash`:cwd 包裹、进程树超时杀、输出头尾截断 + 全量落 `~/.codesaber/truncations/`(7 天);
  - `read`:cat -n 行号、2000 行/单行 2000 字符、二进制探测;
  - `write`:存在文件须先 read(会话状态校验);
  - `edit`:old/new 唯一替换 + 容错链前六级 + disproportionate 防护 + 每文件互斥 + CRLF/BOM 保留;
  - `grep`/`glob`:grep crate 系(ripgrep 内核);
- 提示词侧工具描述遵循 Claude Code 手法(细则进 description 不进系统提示词)。
- 验收:edit 容错链测试矩阵(≥20 case);并行/互斥调度测试。

### T5 saber-core loop + session(2.5d)
- `SessionManager`:JSONL 追加写(批量 flush)+ 启动重建投影;会话目录 `~/.codesaber/sessions/<ts>-<id>/`;
- turn/step loop:`run_turn`(steering 队列接口先留,headless 无生产者)、三防线(length 拒执行/doom-loop 3 次转终止+报错/stop hook 挂点);
- prompt assembler v1:静态段(身份/输出规范,参照 Claude Code 骨架)+ 环境块(cwd/git/平台/日期)+ 工具节(动态生成)+ AGENTS.md(祖先链聚合,兼容 CLAUDE.md);静态前动态后排序;
- token 水位事件(TokenCount);溢出→报错退出(M0 不做 compact,compaction 是 M1)。
- 验收:mock 集成测试五场景(DoD#5);崩溃恢复测试(kill -9 后从撕裂行截断重建)。

### T6 saber-cli headless(1d)
- `saber exec -p "<prompt>" [--json] [--output-schema] [--model]`;非交互权限策略 v0:**full-access 限 cwd + 禁网提示**(M0 无沙箱无审批,文档显著标注;M1 引入权限网关后收紧);
- 退出码与事件流契约文档化。
- 验收:DoD#1 端到端。

### T7 Harbor adapter + 基线(1d)
- `eval/harbor-agent/`:BaseAgent 子类 + `install-saber.sh.j2`(下载 release 二进制或 cargo build)+ run 走 `saber exec --json`;
- 跑 terminal-bench 子集 10 题(确定性强的),结果与逐题 trace 存 `docs/eval/baseline-m0.md`。
- 验收:基线分落盘。

### T8 文档与收尾(0.5d)
- README 更新(M0 能力/限制);仓库自身 AGENTS.md(贡献规范、质量门禁说明);LICENSE = Apache-2.0。

## 风险与对策

| 风险 | 对策 |
|---|---|
| Provider schema 漂移(尤其 tool call 增量格式) | fixtures 录制真实响应;归一化层单测钉死 |
| edit 容错链过度宽松改错位置 | 测试矩阵 + disproportionate 防护默认开 |
| M0 无沙箱权限策略太宽 | exec 默认限 cwd + 显式警告;敏感路径(.env/秘钥)硬拒绝(M0 就做,独立于审批体系) |
| Harbor 跑分环境与本地不一致 | 用官方 dataset 固定 commit;trace 全存档可复现 |

## 估时

约 11.5 人日(T1-T8 串行依赖);T2/T3 可并行,T4/T3 可并行,压缩后日历时间 ~7 天。
