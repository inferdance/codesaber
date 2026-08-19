# 技术栈最佳实践补充调研(2025-2026 联网核实)

> 日期:2026-08-19。目的:为 CodeSaber 技术栈(Rust 引擎 + SwiftUI App + ratatui + UDS JSON-RPC + Seatbelt)核实当前生态选型。标注 ⚠️ 的为"与我们原设想有差异/需要修正"项。

## 0. 速查表

| 领域 | 选型(2026-08 核实) |
|---|---|
| 运行时 | Rust edition 2024 + tokio 1.5x(LTS 1.47/1.51) |
| HTTP/SSE | reqwest 0.13(⚠️ 默认已切 rustls)+ eventsource-stream 或自研 SSE 解析(⚠️ reqwest-eventsource 已停维护) |
| RPC | ⚠️ 不用 jsonrpsee(IPC 支持已移除);自研 line-delimited JSON-RPC(tokio LinesCodec)——与 codex app-server 同路线 |
| 错误 | crate 层 thiserror 2.x + serde(错误要能进事件流),bin 层 anyhow |
| CLI/配置 | clap 4.6 + figment(toml/env/CLI 分层)+ directories + ⚠️ keyring 4.x(架构重构:core + 平台 store) |
| 类型生成 | ⚠️ schemars 1.0 已稳定(单一事实源)→ quicktype 生成 Swift Codable(schema 入库 + CI 生成 + diff 审查) |
| TUI | ⚠️ ratatui 0.30(模块化重构)+ crossterm 0.29;流式关键:scrolling-regions feature + `insert_before` |
| 测试 | cargo-nextest + insta 1.48(用 `cargo insta test` 驱动)+ wiremock 0.6.5(JSONL fixture 回放) |
| 质量门禁 | ⚠️ 只用 cargo-deny(advisories+bans+licenses+sources 四合一,cargo-audit 维护者已退出)+ cargo-shear |
| 搜索/遍历 | ⚠️ globwalk 已进维护模式 → `ignore`+`walkdir`+`globset`(白送 gitignore);grep 用 `grep-searcher/grep-regex` |
| bash 解析 | `tree-sitter` + `tree-sitter-bash`(⚠️ 调研证实无 "tree-borer" 这类 crate) |
| 分发 | dist(原 cargo-dist,存活且合并 Astral fork)→ GitHub Releases + homebrew-tap 自动化 + cargo-binstall 元数据 |
| App 架构 | SwiftUI @Observable(macOS 14+)+ 轻 MV;@Entry 注入;Swift Charts(成本看板零新依赖) |
| App↔引擎 | ⚠️ NWConnection(UDS);JSON-RPC 库选 ChimeHQ/JSONRPC(传输无关,actor 化);MCP swift-sdk 可"抄作业" |
| Markdown 渲染 | ⚠️ MarkdownUI 已进维护模式且有长文性能 issue → 段落级缓存/增量解析策略,先压测 |
| App 更新 | Sparkle 2.9.x(标准,EdDSA + delta 增量);Developer ID + notarytool 直发(不走 App Store,与沙盒模型冲突) |
| 沙箱 | ✅ Seatbelt 仍是正解(deprecated 标记十年未变,所有主流 agent 在用);M0 全禁网即可(LLM 调用在沙箱外主进程) |

## 1. Rust 引擎侧要点

### 1.1 与我们方案直接相关的修正

1. **JSON-RPC over UDS**:jsonrpsee 0.26 已移除 IPC transport;codex app-server 的实际形态 = stdio 上 newline-delimited JSON-RPC(线上省略 `"jsonrpc"` 字段)+ 有界队列背载(过载返回 -32001)。**结论:自研 line-delimited JSON-RPC(tokio LinesCodec + serde 手写分发,几百行),零依赖且可加 `SO_PEERCRED` 对端校验**——spec 的"换行分隔 JSON"决策被验证。
2. **SSE 解析**:reqwest-eventsource 官方停维护且把流结束当错误(对 `[DONE]` 有害);eventsource-stream 冻结在 0.2.3 但稳定。**LLM SSE 只是 `data:` 行 + `[DONE]`,推荐自研 ~100 行解析器**(可控性最好),或 eventsource-stream 过渡。
3. **reqwest 0.13**(2025-12)默认 rustls、builder 方法加 `tls_` 前缀——macOS 单二进制免 OpenSSL 链接,正合适;feature 列表迁移要过一遍。
4. **cargo-deny 取代 cargo-audit**:audit 原维护者退出,CI 只跑 cargo-deny 一站式门禁。
5. **schemars 1.0 稳定**(2025-06):nullable 语义变化,但作为 JSON Schema 单一事实源可放心锁定;Swift 侧 quicktype(累计生成 100 亿行代码的事实标准);**不需要 ts-rs 与 FFI 方案**(swift-bridge 仍 0.1.x,sidecar+IPC 架构无需 FFI)。
6. **ratatui 0.30**:模块化拆分(Alignment→HorizontalAlignment 等 breaking);**0.29 起的 `scrolling-regions` feature + `insert_before` 是流式 scrollback 的官方关键特性**——正是我们"codex 原生 scrollback 手法"的落地路径。
7. **globwalk 维护模式** → `ignore`/`walkdir`/`globset`(还自带 gitignore 语义,grep/glob 工具正好需要)。
8. **keyring 4.x** 拆成 core + `apple-native-keyring-store`;macOS 15 有"返回成功但未落盘"个案 → 写后回读校验。
9. **dist(cargo-dist)活着**:2025 年"死亡→Astral fork→原作者回归合并"折腾后继续演进;标准管线 = dist 生成 GH Actions → tag 触发多平台构建 → Releases + installer.sh → homebrew-tap 自动更新 → cargo binstall 支持。
10. **opentelemetry-rust 仍 0.x 快速演进**(0.32,多次 breaking):核心链路用 tracing + 我们已有的事件溯源 JSONL,OTLP 导出做成可选 feature、锁版本季度升级——比全量接 otel 更稳。
11. **tiktoken-rs 对新模型滞后**:预算控制维持"provider usage 权威 + chars/4 估算"双轨,不引入重 tokenizer 依赖。

### 1.2 工程化细节

- workspace lints(RFC 3389)每成员须显式 `[lints] workspace = true`;MSRV 用 `rust-version` + cargo-msrv 校验。
- cargo-nextest 进程级隔离快 ~3×;insta 与 nextest 的历史兼容问题用 `cargo insta test` 驱动。
- wiremock 模拟 SSE 需自己处理逐 chunk + 延迟(原子交付倾向);录制回放无事实标准 crate → 我们的事件溯源 JSONL 天然就是回放源(架构优势)。
- 错误分层:库 crate 全部 thiserror + serde(错误要序列化进事件流给前端),顶层 bin 用 anyhow。

## 2. SwiftUI App 侧要点

### 2.1 与我们方案直接相关的确认/修正

1. **@Observable 是 2026 共识**(macOS 14+):属性级依赖追踪对流式消息流是最大收益(只有读到变化属性的消息视图重绘);持模型用 `@State`、外部引用用 `@Bindable`;**轻 MV 即可,不教条 MVVM**。@Entry 宏注入主题/连接/审批路由。
2. **UDS 直连为主**:WWDC25 的 `NetworkConnection`/`Coder`/`TLV` 原生并发 API 未覆盖 UDS → 仍走 NWConnection 自己做 JSON-RPC 分帧;**JSON-RPC 库选 ChimeHQ/JSONRPC**(actor 化、传输无关);MCP 官方 swift-sdk(0.11.0)是最成熟的"抄作业"对象(传输抽象 + JSON-RPC 引擎双端)。
3. **Apple 仍无一等 SSE API**(`URLSession.bytesEventOrder` 不存在;SOAR-0010 提案中)——再次支持我们"前端协议统一 JSON-RPC notification、不用 SSE"的决策;若未来远程模式需要,用 LaunchDarkly swift-eventsource。
4. **⚠️ MarkdownUI 进入维护模式**且有长文冻结 issue:流式渲染策略 = 按段落切分、只重解析新增段落、已完成段落缓存为不可变视图;或自研 `AttributedString(markdown:)` + 自绘。**M2 前必须对 MarkdownUI 做流式压测再定**。
5. **长列表虚拟化**:ScrollView+LazyVStack 只懒加载不回收;数据层分页窗口化(首屏 50-100 条)+ `onScrollGeometryChange`(macOS 15+)触底加载;流式 token 只更新最后一条消息的 model 属性。
6. **MenuBarExtra 是二等公民**(.menu 样式阻塞 runloop;.window 样式有 ScrollView 布局 bug,需 MenuBarExtraAccess 补齐);**全局快捷键 2026 仍只有 Carbon RegisterEventHotKey**(soffes/HotKey 包装);菜单栏 App 防 App Nap 用 `beginActivity` 断言,空闲时断开 socket、前台重连。
7. **sidecar 管理**:App 内嵌 spawn(Foundation Process + terminationHandler 区分崩溃/正常 + 指数退避重启)优于 launchd(免 plist 安装/版本同步);⚠️ 管道 stdin/stdout 有缓冲死锁坑 → 引擎日志走文件 + UDS 双通道;Xcode 集成用 build phase 脚本(cargo build --release + 拷到 Contents/MacOS/,bundle 内二进制同样签名 hardened runtime)。
8. **分发**:notarytool 流程 2026 无变化;Sparkle 2.9.x + EdDSA + `generate_appcast` delta 增量;**Developer ID 直发**(App Store 沙盒与 spawn 子进程/任意路径访问/UDS 冲突,社区共识)。
9. **Keychain**:直接用 Security framework(零依赖)或 evgenyneu/keychain-swift;KeychainAccess 低强度维护,不新采。
10. **测试**:Swift Testing 与 XCTest 官方姿态是长期共存;新测试全用 Swift Testing(参数化 @Test 适合协议解码/重连状态机)。
11. 文件变更展示由 Rust 引擎(notify crate)推事件,客户端只渲染,不做 FSEvents 双份实现。

## 3. 沙箱专题(验证 M0 决策)

**核心结论:M0 用 Seatbelt 是正确的,且 M0 直接全禁网即可**——LLM API 调用由沙箱外的引擎主进程发起,沙箱内 bash/测试子进程根本不需要网络。codex 的 network-proxy(127.0.0.1:3128 域名白名单代理)是 M1+ 需求(装依赖场景)。

1. **deprecated 标记十年未变**:"Still deprecated. Still in use by everyone"——Codex/Claude Code(2025-10 `/sandbox` beta,权限弹窗减少 84%)/Homebrew/Bazel/Chrome 都在用;macOS 27 的 `es_new_descendants_client` 是潜在后端但覆盖面不完整且需 entitlement,2026 不可用。真正风险:策略随 OS 更新静默失效。
2. **codex 的 .sbpl 模板要点**(直接抄):`(deny default)` 起步;放行 `process-exec/fork`、约 40 个 sysctl-read(含 `hw.optional.arm.*`)、PTY、cfprefs;**可写根必须 canonicalize**(`/var`→`/private/var`);排除子路径要 `require-not (literal)` + `(subpath)` 双条;`.git`/`.codex` 等元数据目录在可写根内挖成只读。
3. **读侧防护**(写限制不够):显式 `(deny file-read* (subpath "~/.ssh"))` + workspace 内 `**/.env` glob deny;TCC 不救场(子进程继承终端的 Full Disk Access 授权)。
4. **环境变量**:codex 子进程清空 env 按白名单重建并打 `*_SANDBOX_NETWORK_DISABLED=1` 标记——与我们的环境白名单设计一致。
5. **常见坑**:unix-socket 不属于 ip 规则要单独放行;Mach 服务不默认放行会废掉 TLS 校验(trustd);deny 网络时误加任何 `allow network*` 即全开;调试用 `codex debug seatbelt` 同款思路给 `saber debug seatbelt`。

## 4. 与 spec/M0 计划的落点差异(已同步合入)

| 差异 | 落点 |
|---|---|
| jsonrpsee 不可用于 UDS → 自研 line-delimited JSON-RPC | spec §2.2 已是此方向,补 crate 选择 |
| reqwest-eventsource 停维护 → 自研 SSE 解析器 | M0 计划 T3 |
| cargo-audit 退出 → cargo-deny 单门禁 | M0 计划 T1/DoD#3 |
| schemars 1.0 + quicktype 主线 | spec §2.1/M0 T2 |
| globwalk→ignore/globset;tree-sitter-bash | M0 计划 T4 |
| ratatui 0.30 + scrolling-regions | spec §4.1 |
| MarkdownUI 维护模式风险 | spec §4.2 加风险注记 |
| 沙箱读侧 deny(.ssh/.env)、canonicalize、双条排除 | M0 计划 T4b |
| dist + brew tap + binstall 分发管线 | spec §2.2/M0 T8 后的发布流程 |

## 5. 参考链接(精选)

- Rust:[reqwest 0.13 rustls 默认](https://seanmonstar.com/blog/reqwest-v013-rustls-default/) · [reqwest-eventsource 停维护](https://github.com/seanmonstar/reqwest/issues/2677) · [jsonrpsee IPC 移除](https://github.com/paritytech/jsonrpsee/issues/5) · [codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [schemars v1 发布](https://www.reddit.com/r/rust/comments/1lkcl0m/schemars_v1_is_now_released/) · [ratatui v0.30](https://ratatui.rs/highlights/v030/) · [v0.29 scrolling-regions](https://ratatui.rs/highlights/v029/) · [cargo-deny vs audit](https://github.com/EmbarkStudios/cargo-deny/issues/386) · [globwalk 维护模式](https://crates.io/crates/globwalk) · [dist not dead](https://www.reddit.com/r/rust/comments/1noozk7/psa_cargodist_is_not_dead/) · [keyring 4.x](https://crates.io/crates/keyring)
- Swift:[@Observable 迁移](https://developer.apple.com/documentation/swiftui/migrating-from-the-observable-object-protocol-to-the-observable-macro) · [WWDC25 Network 并发(无 UDS)](https://developer.apple.com/videos/play/wwdc2025/250/) · [ChimeHQ/JSONRPC](https://github.com/ChimeHQ/JSONRPC) · [MCP swift-sdk](https://github.com/modelcontextprotocol/swift-sdk) · [MarkdownUI 维护模式](https://github.com/gonzalezreal/swift-markdown-ui) · [steipete 公证+Sparkle 实战](https://steipete.me/posts/2025/code-signing-and-notarization-sparkle-and-tears) · [App 子进程管道坑](https://developer.apple.com/forums/thread/690310) · [HotKey](https://github.com/soffes/HotKey) · [Swift Testing 迁移](https://developer.apple.com/documentation/testing/migratingfromxctest)
- 沙箱:[codex seatbelt_base_policy.sbpl](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl) · [seatbelt.rs](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs) · [network-proxy README](https://github.com/openai/codex/blob/main/codex-rs/network-proxy/README.md) · [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) · [Anthropic 沙箱博客](https://www.anthropic.com/engineering/claude-code-sandboxing) · [Simon Willison 调查](https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/) · [HN sandbox-exec 现状](https://news.ycombinator.com/item?id=47101200) · [TCC 与沙箱](https://eclecticlight.co/2025/11/08/explainer-permissions-privacy-and-tcc/)
