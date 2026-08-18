# Claude Code 架构与设计调研报告(基于公开资料与社区逆向)

> Claude Code 为 Anthropic 闭源产品,本报告综合官方文档、官方工程博客与社区逆向分析写成,关键结论附来源链接。

## 1. 总体架构:闭源但"可读"的 Node CLI

Claude Code 通过 npm 包 `@anthropic-ai/claude-code` 分发,本质是约 13MB 的单文件打包 `cli.js`——只做压缩混淆,**未做字符串加密或控制流扁平化**,约 14.8 万个字符串字面量全部明文,逻辑自发布起就公开可分析。v2.1.88 曾因误打包 `.map` source map 造成"源码泄漏",AST 分析一次性提取出 147,992 个字符串,包括 1000+ 段系统提示词片段、837 个 `tengu_` 前缀遥测事件、504 个环境变量、内部项目树(1,884 个文件)、未发布的自主守护进程 KAIROS,以及**反蒸馏机制——向 API 请求注入 `fake_tools` 诱饵工具定义**。

社区通过 monkey-patch SDK 的 `beta.messages.create` 记录全部请求还原了运行时行为(Yuyz0112/claude-code-reverse):启动时用 **Haiku 3.5** 做配额探测与主题识别,主 Agent 循环用 Sonnet;压缩、会话恢复摘要等辅助任务走小模型。API 层面依赖 **1P tool use + interleaved thinking**(beta 头 `interleaved-thinking-2025-05-14`)。另有 "opusplan" 模型编排:规划阶段用 Opus、执行阶段用 Sonnet。插件体系上,hooks/settings 原生支持 plugin 与 marketplace 字段。

## 2. 系统提示词:动态拼装的"上下文工程"

流传的系统提示词并非静态文本,而是由**约 24 个组件动态拼装**(Drew Breunig 的分析):固定段包括身份定义、系统规则(权限、注入防护、system-reminder 标签)、任务执行哲学(最小改动、不做未要求的重构)、"谨慎执行动作"(按可逆性与影响面确认危险操作)、工具使用策略(优先 Read/Edit/Glob/Grep 而非裸 shell)、语气与输出效率;条件段按特性开关与环境注入——**缓存边界标记**(把全局可缓存内容与会话特定内容分开,配合 prompt cache)、环境信息(cwd/平台/shell/模型名/git 状态)、面向内部员工的 "Ant overrides"、隐藏模型身份的 "undercover mode"、worktree 变体、`--append-system-prompt` 追加等。

行为约束(泄露全文与工具描述,wong2 Gist):回答不超过 4 行、不加注释除非要求、禁止 emoji、代码引用必须 `file_path:line_number`、不猜测 URL;git 规范细致——diff/status/log 并行批查、HEREDOC 写提交信息并附 "Generated with Claude Code" 署名、禁用交互式 flag、不主动 push;安全规则包括拒绝"教育目的"的恶意代码、永不暴露秘钥。

Prompt 工程要点(官方工程博客):找"正确海拔"(介于脆弱的 if-else 与空泛指导之间)、用 XML/Markdown 分节、用少而精的典型示例替代穷举边缘情况。

## 3. 工具集设计:细节即护栏

- **Read**:输出 `cat -n` 式行号前缀,默认 2000 行、单行截断 2000 字符;**编辑前必须先 Read**(状态校验);支持图片多模态。
- **Edit**:`old_string` 必须**唯一匹配否则整体失败**(防止改错位置),支持 `replace_all`;提示词强调剥离行号前缀、保留精确缩进;MultiEdit 顺序应用多条编辑、原子化 all-or-nothing。
- **Write**:覆盖式写,已存在文件需先 Read;提示词禁止主动创建文档/README。
- **Bash**:`timeout` 默认 120s、上限 600s;输出截断 30000 字符;要求 5-10 词 description;**明令避免 cat/head/tail/grep/find**,引导用专用工具(需 grep 时用 `rg`)。
- **Task**:无状态子代理,`description` 限 3-5 词,只回传最终报告,可在同一消息并发多个。
- **WebFetch**:URL+prompt,转 Markdown 后交小模型处理,15 分钟缓存,强制 HTTPS 升级。
- **TodoWrite**:同一时刻仅一个 in_progress、测试不过不得标 completed——把任务管理变成硬约束。
- **exit_plan_mode**:以 markdown 提交计划供用户批准,是 Plan Mode 的出口。

## 4. 上下文管理:多级压缩级联

官方描述 auto-compact 在接近窗口上限时由模型总结历史,保留架构决策、未解决 bug、实现细节与**最近访问的 5 个文件**;压缩由一个专职子代理生成摘要块作为新会话种子。社区逆向进一步还原出**渐进压缩级联**:预算削减 → snip(LRU 归档最旧消息)→ **microcompact**(约 80% 用量触发,不调用 LLM,仅清理陈旧大体积工具输出并重排以命中缓存)→ 完整 auto-compact(约 92%)→ 被动 compact。

记忆体系为 CLAUDE.md 层级注入:企业 → 用户(`~/.claude/CLAUDE.md`)→ 项目 → 子目录,支持 `@path` 导入与 `/init` 生成;检索采用 just-in-time 策略——预载 CLAUDE.md 但依赖 glob/grep 按需探索,不维护易过期索引。

## 5. 权限模型与 Hooks

权限模式:`default` / `acceptEdits` / `plan` / `bypassPermissions`(新版本另有 `auto`)。Hooks 是最细粒度的治理层:生命周期覆盖 **PreToolUse / PostToolUse / PermissionRequest / UserPromptSubmit / Notification / Stop / SubagentStop / SubagentStart / PreCompact / PostCompact / SessionStart / SessionEnd / EnterPlanMode / ExitPlanMode / WorktreeCreate** 等二十余事件;以 stdin JSON 传上下文,退出码语义为 0(成功)/2(阻断,stderr 反馈给模型)/其他(非阻断错误);`permissionDecision` 遵循 **deny > defer > ask > allow** 优先级,且 **bypassPermissions 下 PreToolUse 的 deny 依然生效**——钩子优先于放行。settings 层级:企业 managed > CLI 参数 > 项目 local > 项目 shared > 用户级;managed hooks 不可被下级关闭。多钩子按 priority 排序,失败默认不阻断(`failOpen: true`)。

## 6. 子代理与 Skills

Task/Agent 工具把子任务连上下文一起"切出去",主线程只收最终报告,实现**脏上下文隔离**;官方称子代理以干净窗口(数万 token)探索、回传 1,000-2,000 token 浓缩摘要。子代理默认独立上下文、无用户交互、转录存于嵌套 `subagents/` 目录,支持后台运行与 `resume backgroundSubagents` 续跑;内建 Explore/Plan 等专用 agent。

**Skills**(2025 年 10 月推出)以 `SKILL.md` 为核心:YAML frontmatter(name+description)随系统提示词常驻,正文按需加载,捆绑脚本/模板文件真正用到才读——三级渐进披露使附带上下文"事实上无边界",并与 MCP 互补(MCP 连接工具,Skills 教工作流);2025 年 12 月开放为标准(agentskills.io)。

## 7. MCP 集成

支持 8 种传输(stdio、Streamable HTTP、SSE、WebSocket、claudeai-proxy、sdk 进程内、两种 IDE 变体);MCP 工具经四段包装后**与内建工具共用同一 Tool 接口**——命名规范化为 `mcp__{server}__{tool}`、description 截断至 2048 字符(防止 OpenAI 风格服务器塞 15-60KB 说明)、schema 透传、annotation 映射(`readOnlyHint` 允许并发、`destructiveHint` 触发额外权限检查)。OAuth 2.0 + PKCE 懒启动(收到 401 才发起),发现链 RFC 9728 → RFC 8414;token 自动刷新并处理并发竞态。配置有 7 个 scope,按内容签名去重;本地服务器以 3 个一批、远程 20 个一批连接。优先级上,提示词明确"有 MCP 专用工具时优先于通用 WebFetch"。

## 8. 会话与协作

每个会话以 JSONL 逐事件持久化于 `~/.claude/projects/<project>/<session-id>.jsonl`,支持 `--continue`/`--resume [id]`/`--fork-session`。**Checkpointing**:每次用户 prompt 自动快照(对话状态+文件状态),`Esc Esc` 唤起 `/rewind` 可回退代码与对话任一维度,快照默认保留 30 天。并行协作通过 `--worktree` 为每个会话自动创建 git worktree 隔离工作区,`WorktreeCreate` 钩子可替换默认实现。

## 9. 官方披露的设计原则

核心是 **context engineering**:"寻找能最大化目标达成概率的最小高信号 token 集",警惕 context rot(token 越多注意力越稀疏);长时程任务三板斧——压缩、结构化笔记(agentic memory)、子代理;工具设计要求自包含、容错、token 高效,**避免功能重叠的臃肿工具集**;姿态上"做最简单可行的事"。最佳实践工作流为 "explore → plan → code → commit",善用 `/clear`、CLAUDE.md、headless 模式与多 worktree 并行。

## 10. 社区逆向资源推荐

- Yuyz0112/claude-code-reverse:monkey-patch 抓包式分析,含可视化工具
- AfterPack: "Claude Code's Source Didn't Leak":sourcemap 事件与 AST 提取
- Drew Breunig: How Claude Code Builds a System Prompt:系统提示词拼装解剖
- Piebald-AI/claude-code-system-prompts 与 AgiFlow/claude-code-prompt-analysis:提示词版本存档与机制分析
- claude-code-from-source(alejandrobalderas):基于泄漏源码的逐章开源书
- wong2 的工具+提示词 Gist、Pete 的工具解析(blog.thepete.net)
- vrungta 逆向架构、Karan Prasad 512K 行分析

## 结论

Claude Code 的核心竞争力不在单个功能,而在于**把 prompt、工具协议、权限治理与上下文经营做成一个自洽系统**:系统提示词的动态拼装+缓存边界设计、Edit 的唯一匹配校验、microcompact 级联、hooks 的 deny 优先、Skills 的三级渐进披露,均是可直接借鉴的工程范式。

## 参考链接

1. https://www.afterpack.dev/blog/claude-code-source-leak
2. https://github.com/Yuyz0112/claude-code-reverse
3. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
4. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
5. https://code.claude.com/docs/en/hooks
6. https://code.claude.com/docs/en/memory
7. https://code.claude.com/docs/en/sessions
8. https://code.claude.com/docs/en/checkpointing
9. https://code.claude.com/docs/en/best-practices
10. https://gist.github.com/wong2/e0f34aac66caf890a332f7b6f9e2ba8f
11. https://blog.thepete.net/claude-code-tools/
12. https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html
13. https://github.com/Piebald-AI/claude-code-system-prompts
14. https://github.com/AgiFlow/claude-code-prompt-analysis
15. https://github.com/alejandrobalderas/claude-code-from-source/blob/main/book/ch15-mcp.md
16. https://www.wisebuilder.dev/tutorial/system-design/ai-infrastructure/claude-code-patterns
17. https://y-agent.github.io/inside-claude-code/04-context-compaction.html
18. https://newsletter.victordibia.com/p/inside-claude-code
19. https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html
20. https://claudefa.st/blog/guide/development/permission-management
21. https://github.com/anthropics/claude-code/issues/23711
22. https://github.com/anthropics/claude-code/issues/1229
23. https://vrungta.substack.com/p/claude-code-architecture-reverse
24. https://karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines
25. https://x.com/_catwu/status/1955694117264261609
