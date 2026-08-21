# CodeSaber 技术方案 v2:TS-Native Coding Agent

> 日期:2026-08-21。状态:重新设计(v1 Rust 实现已移除,安全设计经 6 轮 review 验证后保留为不变量)。
> 调研基础:`docs/research/`(6 agent 源码深读 + Claude Code 逆向 + 论文 + Harbor)。
> v1 教训:直接翻译 Rust→TS 产生 21 项缺陷;TS 需要自己的惯用法,不是 Rust 的语法糖。

## 0. 一页结论

1. **全栈 TypeScript/Bun**,Effect-TS 运行时(opencode 同款),pnpm monorepo。
2. **Web-first**(zcode 模式):Fastify server + 浏览器即 App,PWA 可选,原生壳最后加。
3. **生态优先**:execa 替代手写 spawn、fast-glob 替代 find、fast-diff 替代手写匹配、zod 替代手写校验——**只手写性能热点和差异化逻辑**。
4. **安全不变量从 Rust 版继承**(路径策略/Edit 容错/WAL/沙箱),但用 TS 惯用法实现。
5. **核心+CLI 先行**,Web UI 在核心可用后加(M1.5 门槛不变)。

## 1. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Bun(开发)/ Node 22(生产) | Bun 快;Node 22 LTS 部署稳定 |
| 语言 | TypeScript 5.9 strict | 结构类型+判别联合+泛型推断 |
| 效果系统 | **Effect-TS** | Layer 依赖注入/Schema 运行时校验/Stream 组合式流处理(opencode 验证过) |
| HTTP | Fastify 5 | 性能+插件生态+WebSocket 内置 |
| 校验 | **Zod**(工具参数/配置) | 运行时类型安全,坏参数直接拒绝 |
| 子进程 | **execa** | 超时/取消/env 清洗/进程组杀,内置(须设 `extendEnv:false` + `killDescendants:true`) |
| 文件搜索 | **fast-glob** | 比 find 快 10x;⚠️ gitignore 需手动传入 `ignore` 数组(非内置) |
| Diff | **fast-diff**(编辑匹配) | Unicode 安全,字符级偏移 |
| 路径 | **pathe** | 跨平台 normalize/resolve 语义正确 |
| 测试 | **Vitest** | 快、ESM 原生、与 Vite 生态一致 |
| 分发 | npm / bunx | README 原始承诺兑现 |

## 2. 包结构

```
packages/
├── core/               # Effect 运行时 + 安全不变量
│   ├── src/
│   │   ├── layer/      # Effect Layer:依赖注入容器
│   │   │   ├── provider.ts   # ProviderLayer(可替换 AI 后端)
│   │   │   ├── tools.ts      # ToolRegistryLayer(六工具注册)
│   │   │   ├── policy.ts     # PathPolicyLayer(路径策略)
│   │   │   └── session.ts    # SessionLayer(WAL JSONL)
│   │   ├── schema/     # Zod schemas:所有边界类型的运行时定义
│   │   │   ├── tools.ts      # 每个工具的参数 schema
│   │   │   ├── events.ts     # 引擎事件 schema
│   │   │   └── config.ts     # 配置 schema
│   │   ├── engine/     # turn/step loop(三防线)
│   │   ├── edit/       # 编辑容错(fast-diff + 匹配策略)
│   │   └── policy/     # 路径策略(pathe + 安全边界)
├── ai/                 # LLM 接入(SSE 手写——性能热点)
│   ├── src/
│   │   ├── sse.ts            # SSE 解析(~80 行,保留手写)
│   │   ├── providers/
│   │   │   ├── openai.ts     # OpenAI 兼容
│   │   │   ├── anthropic.ts  # Anthropic Messages
│   │   │   └── mock.ts       # 测试用
│   │   └── retry.ts          # 指数退避
├── server/             # Fastify + WebSocket
│   └── src/main.ts
├── cli/                # saber 命令
│   └── src/main.ts
├── web/                # Web UI(M1)
└── sandbox/            # Seatbelt(macOS)
    └── src/profile.ts
```

## 3. 安全不变量(从 Rust 版继承,TS 实现)

### 3.1 统一路径策略(PathPolicyLayer)

```typescript
// Effect Layer:所有工具共享的唯一路径判定
import { resolve, relative, sep } from "pathe";
import { z } from "zod";

const SECRET_SUFFIXES = [
  ".env", ".env.local", ".pem", "id_rsa", "id_ed25519",
  ".npmrc", ".netrc", ".git-credentials",
] as const;

// Zod schema:坏参数在运行时直接拒绝
export const ReadParams = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

// 安全的写边界检查:路径组件级 + symlink canonicalization
import { relative, resolve, sep } from "pathe";
import { realpathSync } from "node:fs";

function isInside(root: string, target: string): boolean {
  // 1. Canonicalize both sides (handles symlinks)
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(resolve(target));
  // 2. Component-level containment (NOT startsWith — prefix bypass;
  //    NOT startsWith("..") — false-positives on `..cache/`)
  const rel = relative(realRoot, realTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !resolve(rel).startsWith(".."));
}
```

**关键改进**:Rust 版用 `starts_with`(有前缀绕过),TS 版用 `path.relative`(路径组件级精确)。

### 3.2 编辑容错链(fast-diff + 策略)

```typescript
import * as diff from "fast-diff";

// 不手写偏移映射,用 fast-diff 的字符级 diff 结果
// 六级容错变为:精确→空白归一→缩进灵活→行级→模糊→放弃
export function findEditSpans(
  content: string,
  oldString: string,
): Array<[number, number]> | null {
  // 1. 精确匹配
  let idx = content.indexOf(oldString);
  if (idx !== -1) return [[idx, idx + oldString.length]];

  // 2. 空白归一(fast-diff 自动处理 Unicode)
  const normalized = normalizeWhitespace(content);
  const normalizedOld = normalizeWhitespace(oldString);
  // ... 每级用不同的 normalize 策略

  return null;
}
```

**关键改进**:fast-diff 处理了 Unicode 代理对/组合字符，手写版本在多字节字符上偏移错误。

### 3.3 WAL 会话日志

```typescript
// JSONL append-only, intent 先于副作用, fsync
import { appendFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";

export class SessionLog {
  append(type: string, payload: unknown, sync = false): number {
    const envelope = { ts: Date.now(), seq: this.seq++, session_id: this.id, type, payload };
    const line = JSON.stringify(envelope) + "\n";
    if (sync) {
      const fd = openSync(this.path, "a");
      writeSync(fd, line);
      fsyncSync(fd);  // WAL:intent 必须落盘才能执行副作用
      closeSync(fd);
    } else {
      appendFileSync(this.path, line);
    }
    return envelope.seq;
  }
}
```

### 3.4 三防线(Engine loop)

1. **length 拒执行**:`finish_reason === "length"` 时拒绝执行工具调用
2. **doom-loop**:同一工具+相同参数连续 3 次 → 终止
3. **WAL**:副作用前 fsync intent,恢复时 intent-无-result 标记未完成

### 3.5 bash 沙箱(execa + Seatbelt)

```typescript
import { execa } from "execa";

const result = await execa("bash", ["-c", command], {
  cwd,
  timeout: timeoutMs,
  env: allowlistEnv(),       // 只传 PATH/HOME/LANG/TMPDIR
  extendEnv: false,           // ★ 必须 false — 否则 process.env 会合并进来,密钥泄露
  killSignal: "SIGKILL",
  killDescendants: true,      // ★ 必须 true — 否则超时只杀直接子进程,孙进程残留
});
```

**⚠️ execa 安全要点**(review 发现,容易遗漏):
- `extendEnv` 默认 `true`——不设 `false` 时 `process.env` 的 API key 会传给 bash
- `killDescendants` 默认 `false`——不设 `true` 时超时后后台孙进程继续运行

## 4. 架构分层

```
┌─ 用户层:AGENTS.md / 用户 skills / MCP
├─ 默认工作流包(可换可删):draw/strike/sheathe
├─ 基座机制层(零意见):
│   Effect Layer 注入 → Engine(loop) → Tools(6) → Policy(路径)
│   → Session(WAL) → Providers(AI) → Sandbox(Seatbelt)
└─ 纪律:Zod 运行时校验 · 错误进流不抛异常 · 只手写性能热点
```

## 5. 前端策略

**Web-first(zcode 模式)**:
- Fastify server 在 localhost:3080
- 浏览器打开即是 App(远程/本地同一体验)
- PWA manifest(可添加到 Dock)
- 原生壳(Tauri/SwiftUI)是 M3+ 的打磨项,不是 MVP 需求

## 6. 测试策略

- **Vitest**:单元+集成
- **Zod schema 校验**:每个工具的参数在运行时校验(坏参数直接拒绝,不是 catch 后 Null)
- **Effect Layer mock**:测试时 `Layer.succeed` 一行替换真实 provider
- **安全边界测试**:路径逃逸/symlink/秘钥读取/沙箱越界(从 Rust 版 119 个测试继承断言)
- **CI**:GitHub Actions(ubuntu + macOS for sandbox tests)

## 7. 里程碑(重新定义)

- **M0**:TS monorepo + Effect 骨架 + 核心安全不变量(路径策略/Edit/WAL/沙箱)+ CLI `saber exec` headless + 测试
- **M1**:TUI(可选)/ 完整 CLI + compaction + steering + Harbor 基线
- **M1.5**:核心打磨(dogfooding 一周 + TB2.0 ≥40%)
- **M2**:Web UI + server(远程操作)
- **M3**:工作流包 + MCP + Skills + jobs

## 8. 从 Rust 版学到的(保留为设计约束)

| Rust 验证的教训 | TS 设计约束 |
|---|---|
| `startsWith` 有前缀绕过(`/tmp/work-escape`) | 必须用 `path.relative` 或路径组件比较 |
| `unwrap_or(Null)` 静默执行坏参数 | Zod schema 校验,坏参数直接拒绝 |
| 多工具调用只保留最后一个 | `Map<callId, {name, args}>` + 调用顺序表 |
| WAL intent/result 字段不一致导致恢复误判 | 统一 schema:`{call_id, name, arguments}` |
| Provider 流异常越过事件边界 | AsyncGenerator 内 try-catch 全覆盖,错误变终止事件 |
| bash 超时不杀进程组 | execa 内置 `killSignal: "SIGKILL"` + 进程组 |
| edit 多行 fallback 偏移错误 | fast-diff 库处理字符级偏移,不手写 |
| grep/glob 绕过秘钥策略 | 所有工具统一走 PathPolicyLayer |

## 9. 与 v1(Rust)的差异总结

| 维度 | v1 Rust | v2 TS |
|---|---|---|
| 语言 | Rust 2024 | TypeScript 5.9 strict |
| 运行时 | tokio | Bun/Node 22 + Effect-TS |
| 依赖注入 | trait object | Effect Layer |
| 参数校验 | serde 编译期 | Zod 运行时 |
| 子进程 | 手写 spawn+进程组 | execa |
| 文件搜索 | find 命令包装 | fast-glob |
| 编辑匹配 | 手写归一化+偏移映射 | fast-diff |
| 路径安全 | starts_with | path.relative |
| 前端 | SwiftUI 原生优先 | Web-first(zcode 模式) |
| 分发 | brew/cargo | npm/bunx |
| 测试数量 | 119 | 目标:从 119 继承断言 |
