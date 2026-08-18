# arXiv 论文综述 + Harbor 评测框架调研

## Part A:arXiv 上 Agent Harness / Coding Agent 关键论文综述(2023–2026)

### 一、Agent 框架 / 接口设计

**1. SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering(arXiv:2405.15793,NeurIPS 2024)**
核心思想:提出"Agent-Computer Interface(ACI)"概念——类比 HCI,agent 与计算机的接口应专门为 LLM 的使用方式设计。ACI 设计原则:观察要简洁且信息量足、动作格式要简单鲁棒、内置防止常见错误的护栏、编辑后自动 lint 反馈。
借鉴点:harness 设计的奠基性论文。工具接口是一等设计对象:窗口化文件浏览、带行号上下文的 edit、编辑后自动语法检查、搜索结果截断——这些细节比换模型更能提升成功率。

**2. Agentless: Demystifying LLM-based Software Engineering Agents(arXiv:2407.01489)**
核心思想:不用自主 agent,用固定三阶段流水线(定位→修复→补丁验证),LLM 从不决定下一步动作。以约 $0.34/issue 的成本取得当时 SWE-bench Lite 最优。
借鉴点:不是所有环节都值得自主;可确定性化的环节硬编码进 harness,把模型自主决策留给真正需要判断的地方;分层定位 + 多候选补丁 + 测试过滤是高性价比默认架构。

**3. CodeAct: Executable Code Actions Elicit Better LLM Agents(arXiv:2402.01030,ICML 2024)**
核心思想:把 agent 的全部动作统一为"可执行代码",配合解释器执行并根据观察动态修订。MINT 基准绝对成功率高出 20%。
借鉴点:工具调用协议不必是 JSON function calling——让模型直接写代码调用工具库,天然获得组合、复用、循环、错误处理能力(OpenHands、dsh Code Mode 的底层范式)。

**4. OpenHands: An Open Platform for AI Software Developers(arXiv:2407.16741;SDK 论文 arXiv:2511.03690)**
核心思想:事件流架构统一记录动作/观察、沙箱化代码执行、AgentSkill 技能库、浏览器工具、多 agent 委托。
借鉴点:"事件流 + 沙箱 + 技能库 + 委托代理"四件套是成熟参考架构;把一切交互记为不可变事件流,可回放、可评估、可转训练数据。

**5. Magma: A Foundation Model for Multimodal AI Agents(arXiv:2502.13130,CVPR 2025)**
统一数字世界(UI 导航/工具调用)与物理世界的多模态 agent 基础模型(Set-of-Mark / Trace-of-Mark 预训练)。浏览器/GUI 自动化的 grounding 循环可借鉴。

### 二、Harness 设计空间研究

**6. SWE-agent 的 ACI 消融(同 2405.15793)**:系统消融文件查看窗口大小、行号显示、编辑失败反馈形式等,证明接口细节带来数个百分点的差异。harness 必须自带消融评测能力,接口设计要数据驱动。

**7. AutoCodeRover(arXiv:2404.05527)**:以程序结构(AST)为中心做上下文检索,结构化查询而非纯 grep。代码搜索策略(结构感知 vs 文本 grep vs LSP 索引)是 harness 的核心设计变量。

**8. MemGPT: Towards LLMs as Operating Systems(arXiv:2310.08560)**:上下文窗口类比为内存 hierarchy,分页换入换出 + 函数调用自主管理记忆。长任务 harness 需要 OS 式记忆分层 + compaction。

**9. Context Rot: The Impact of Long Contexts on LLM Reasoning(arXiv:2507.06223)**:实证上下文越长噪声越多,推理性能系统性下降,reasoning 模型受害更深。compaction、选择性保留、子代理隔离是正确率问题不只是成本问题。

**10. ACE: Agentic Context Engineering(arXiv:2510.04618,Stanford/Berkeley 等)**:把上下文当作"可演化的 playbook",增量式管理、积累、精炼策略,避免全量重写的"简短偏差"与"上下文腐烂"。system prompt/记忆应设计为带增删改语义、可被 agent 自身维护的数据结构。

**11. 2026 年 harness 形式化**:《Toward Executable, Verifiable, and Stateful Agent Systems》(arXiv:2605.18747)研究 harness 接口如何连接推理、动作与环境建模;《Recursive Agent Harnesses》(arXiv:2606.13643)提出 harness 递归(agent 自身作为子 harness 载体);《Harness Engineering for LLM Agents: A Survey》(preprints.org 202606.2203)主张 harness 是决定规模化可靠性的第一研究对象。趋势共识:模型越强,scaffold 应越薄、越可删除。

### 三、评测基准

**12. SWE-bench(arXiv:2310.06770)**:2294 个真实 GitHub issue + fail-to-pass 测试自动判定。变体:SWE-bench Verified(OpenAI 人工校验 500 题)、Multimodal(arXiv:2410.03859)。启示:评测对象是"patch + 测试";规格噪声要求"多 attempt + 抽样"统计口径。

**13. Terminal-Bench(arXiv:2601.11868)**:终端环境困难任务基准。2.0 为 89 个高难任务(内核编译、git 服务器搭建、破解哈希等),每题独立 Docker 环境与人写参考解;发表时前沿 agent 不足 65%。启示:"终端 + Docker + 可执行验证器"评测范式已成行业标配。

**14. Aider Polyglot**(非论文但影响巨大):225 题 Exercism 练习,考察模型在特定 edit format 下的改码能力,揭示"模型 × 编辑格式"显著交互。harness 的编辑格式要针对模型做适配与消融。

**15. LiveCodeBench(arXiv:2403.07974)**:持续收集训练截止后的新题免污染;评 self-repair、代码执行、测试输出预测。评测集要滚动更新;执行-观察-修复循环本身是被测能力。

**16. MLE-bench(arXiv:2410.07095,OpenAI)**:75 个 Kaggle 竞赛的长时程 ML 工程。启示:长时间沙箱、中间产物保存与评估、成本与时间预算控制。

**17. TheAgentCompany(arXiv:2412.14161)**:模拟软件公司中的 175 个有后果任务,含跨系统依赖;最好模型只完成约 24-30%。启示:真实工作流是多工具、有状态、有副作用的,需要跨应用状态跟踪与检查点。

**18. SWE-Lancer(arXiv:2502.12115,OpenAI)**:1400+ 真实 Upwork 任务总价值 $100 万,用真实 payout 计价。经济价值可作为效用度量。

**19. KernelBench(arXiv:2502.10517,Stanford)**:250 个 PyTorch workload,评"正确性 + 性能"双维度(加速比),验证器需防作弊(如缓存结果)。

**20. RE-Bench(arXiv:2411.15114,METR)**:7 个开放式 ML 研究工程环境,与人类专家等时对比,报告 score-vs-time 曲线。时间预算是一等评测维度。

**21. R2E-Gym(arXiv:2504.07164)**:8.1K+ 程序化生成的 SWE 训练环境 + 混合验证器(运行时检查 + 测试),开源权重 agent 在 SWE-bench Verified 达 51%,展示 test-time scaling(best-of-N)收益。评测基建可反哺训练;混合 verifier 是解决"测试不充分"的关键。

### 四、Agent 自我改进 / 技能学习

**22. Voyager(arXiv:2305.16291)**:自动课程 + 可执行代码技能库(嵌入索引检索)+ 迭代提示机制,技能可跨环境迁移。成功方案沉淀为带描述的 skill library 是复利式进化核心机制(与 Claude Code Skills / OpenHands AgentSkill 同构)。

**23. Reflexion(arXiv:2303.11366)**:失败后生成语言化反思存入 episodic memory 指导下次尝试。**24. Self-Refine(arXiv:2303.17651)**:单次生成内的迭代自反馈精炼。借鉴点:记录失败轨迹并结构化沉淀"教训"跨会话传递(rules 文件自动进化);单轮内 self-critique 需谨慎。

### 五、多智能体 / 子代理

**25. CodeR(arXiv:2406.01304)**:管理者 + 4 类执行 agent,预定义 task graph。**26. ChatDev(arXiv:2307.07924)/ MetaGPT(arXiv:2308.00352)**:角色分工与 SOP 流水线。**27. Why Do Multi-Agent LLM Systems Fail?(arXiv:2503.13657)**:MAST 失败分类学,实证多智能体普遍逊于好的单 agent 基线。**28. Anthropic 多智能体研究系统报告**:多智能体的本质价值是"上下文工程"——子代理各自独立窗口并行探索,只回传压缩结论。

借鉴点:引入子代理的正当理由是上下文隔离与并行;主从结构要保持信息流最小化与任务描述完备。

### 六、安全:注入攻击与沙箱

**29. 间接提示注入(arXiv:2302.12173)**:奠基性指出 agent 读到的网页/文档/代码中可携带恶意指令。**30. AgentDojo(arXiv:2406.13352)**:同时评 utility 与对抗鲁棒性。**31. InjecAgent(arXiv:2403.02691)**:工具集成 agent 的注入攻击基准。

借鉴点:harness 必须默认敌视"读到的内容"——命令/文件/网页属不可信输入;权限分级、沙箱隔离、危险命令确认、审计日志,并把注入鲁棒性纳入回归评测。

### 七、2025–2026 最新趋势

1. **Reasoning model 与 harness 协同设计**:harness 从"重编排"转向"薄接口"(mini-swe-agent、Terminus 等极简 harness 证明把推理还给模型、把接口做稳即可逼近复杂框架)。
2. **Test-time compute**:并行采样、验证器打分、结果选择正进入 harness 标配(R2E-Gym、OpenAI ARA)。
3. **Agentic context engineering**:从"写好 prompt"转向"管理持续演进的上下文系统"(ACE playbook、MemGPT 分层、Anthropic compaction/结构化笔记)。

---

## Part B:Harbor 评测框架

> 原地址 terminal-bench/harbor 已迁移到独立组织 harbor-framework/harbor(早期为 laude-institute/harbor)。

### 1. 定位与核心理念

Harbor 是 Terminal-Bench 团队(Stanford × Laude Institute)开源(Apache-2.0,Python)的"评测与优化 agents 和语言模型"的模块化框架。与 lm-eval-harness、HELM 的本质区别在于**评测对象**:lm-eval-harness/HELM 评"模型"(静态数据集 + 固定 prompt,按标准答案比对);Harbor 评"agent 系统(harness × 模型)"——被测对象是 Claude Code、Codex 这类完整 agent,在每题独立的 Docker 环境里自由行动数十分钟,由可执行验证器打分。此外还面向"优化":导出 RL 训练 rollout(ATIF 轨迹格式)、并行云端执行、参数扫描(sweeps)。

### 2. 架构

四个核心概念:**Task / Agent / Environment / Verifier**,外加 Job/Trial 执行模型(一次 run = agents × tasks × attempts 的笛卡尔积)。

- **Task 定义(task.toml 而非 yaml)**:
```
my-task/
├── task.toml          # 元数据、[verifier]/[agent] timeout、[environment](cpus/memory/gpus/allow_internet/docker_image、MCP servers)
├── instruction.md     # 自然语言任务指令
├── environment/Dockerfile   # 任务环境(必须含 bash)
├── tests/test.sh (+ test_state.py)  # 验证脚本
└── solution/solve.sh  # 可选参考解(oracle,验证任务可解)
```
- **Environment**:每题一个隔离 Docker 容器;支持 Daytona、Modal、e2b、LangSmith、Blaxel 云端沙箱。
- **Harness Adapter**:所有 agent 实现抽象类 `BaseAgent`(`src/harbor/agents/base.py`),四个必需方法:`name()`、`version()`、`setup(environment)`(Jinja2 模板脚本安装/鉴权/配 MCP/skills)、`run(instruction, environment, context)`(执行并填充 AgentContext:token 计数、成本、ATIF rollout、metadata)。已内置 adapter:claude-code、codex、opencode、goose、openhands、aider、gemini-cli、cursor-cli、cline、qwen-coder、mini-swe-agent/swe-agent,及内部用途的 terminus(-1/-2,官方默认 harness)、oracle、nop。接入方式是 CLI 黑盒,自建 agent 只需子类化 `BaseInstalledAgent` + install 脚本模板。

### 3. 指标与 Judge

默认**可执行验证器而非 LLM judge**:Verifier 把 `tests/` 上传进容器执行,脚本把分数写到 `/logs/verifier/reward.txt`(单数值)或 `reward.json`(多维指标);超时默认 600s。LLM judge 也支持:测试脚本内嵌调用打分 API 写 reward 文件,文档提醒成本与非确定性。多维 reward + 多 attempt 聚合由 Metrics 层完成;`solution/` 配 oracle agent 用于任务自检(保证"可解且测试能判对")。

### 4. 编写自定义 task 与跑 benchmark

- 脚手架:`harbor tasks create my-task`;本地调试推荐 `--max-tasks 10` 子集验证。
- 运行:
```bash
harbor run --dataset terminal-bench@2.0 \
  --agent claude-code --model anthropic/claude-opus-4-1 \
  --n-concurrent 4            # 云端:--env daytona --n-concurrent 100
```
常用项:`--attempts 3`、`--agent-timeout-multiplier`、`--ae KEY=VAL`。结果 `harbor view jobs/<job-id>`;`harbor traces` 导出轨迹;`harbor sweeps` 参数扫描。

### 5. Task 集合与 Leaderboard

官方数据集:terminal-bench@2.0(89 高难任务)、2.1(社区 verified 修订)、Terminal-Bench 3(frontierbench.ai)、Science/Challenges。tbench.ai 维护 leaderboard;Artificial Analysis 的 TB v2.1 榜首为 GPT-5.6 Sol (xhigh) 89.5%、Claude Opus 5 (Adaptive) 89.1%、Grok 4.6 (high) 88.4%——均为 Terminus 2 harness + e2b 沙箱、pass@1 三次均值。"同一 harness 下比模型"与"同一模型下比 harness"两种读法都成立。

### 6. 对自建 coding agent 的启示:用 Harbor 做 CI 回归

1. **接入**:为自己的 agent 写一个 `BaseAgent` 子类(包装 CLI 进容器执行),即可跑 terminal-bench@2.0 等公共基准获得外部锚点。
2. **私有回归集**:团队真实工单做成 task 目录(instruction.md + Dockerfile + test.sh),存 Git 仓库用 GitTaskId 引用;每题配 `solution/` 并用 oracle agent 验证可解性。
3. **CI 策略**:PR 触发 `--max-tasks N` 冒烟;夜间全量 + `--attempts 3` 降方差;`reward.json` 多维指标观察退化面;traces 留档失败轨迹供复盘。
4. **A/B 与调参**:矩阵(agent × model × 参数)+ sweeps 量化 prompt/工具接口改动(呼应 ACI 消融方法论);成本由 AgentContext 自动记账。
5. **延伸**:Verifier 加"运行时间/资源/风格"维度;轨迹导出为 RL 或失败分析供给数据。

## 参考链接

**Part A**
- SWE-agent: https://arxiv.org/abs/2405.15793 ｜ Agentless: https://arxiv.org/abs/2407.01489 ｜ CodeAct: https://arxiv.org/abs/2402.01030
- OpenHands: https://arxiv.org/abs/2407.16741 ｜ Magma: https://arxiv.org/abs/2502.13130 ｜ AutoCodeRover: https://arxiv.org/abs/2404.05527
- MemGPT: https://arxiv.org/abs/2310.08560 ｜ Context Rot: https://arxiv.org/abs/2507.06223 ｜ ACE: https://arxiv.org/abs/2510.04618
- Executable/Verifiable/Stateful: https://arxiv.org/abs/2605.18747 ｜ Recursive Harnesses: https://www.alphaxiv.org/abs/2606.13643 ｜ Harness Survey: https://www.preprints.org/manuscript/202606.2203
- SWE-bench: https://arxiv.org/abs/2310.06770 ｜ Verified: https://www.swebench.com/verified.html ｜ Multimodal: https://arxiv.org/abs/2410.03859
- Terminal-Bench: https://arxiv.org/abs/2601.11868 ｜ https://www.tbench.ai/ ｜ Aider Polyglot: https://aider.chat/docs/leaderboards/
- LiveCodeBench: https://arxiv.org/abs/2403.07974 ｜ MLE-bench: https://arxiv.org/abs/2410.07095 ｜ TheAgentCompany: https://arxiv.org/abs/2412.14161
- SWE-Lancer: https://arxiv.org/abs/2502.12115 ｜ KernelBench: https://arxiv.org/abs/2502.10517 ｜ RE-Bench: https://arxiv.org/abs/2411.15114 ｜ R2E-Gym: https://arxiv.org/abs/2504.07164
- Voyager: https://arxiv.org/abs/2305.16291 ｜ Reflexion: https://arxiv.org/abs/2303.11366 ｜ Self-Refine: https://arxiv.org/abs/2303.17651
- CodeR: https://arxiv.org/abs/2406.01304 ｜ ChatDev: https://arxiv.org/abs/2307.07924 ｜ MetaGPT: https://arxiv.org/abs/2308.00352 ｜ MAST: https://arxiv.org/abs/2503.13657
- Anthropic 多智能体: https://www.anthropic.com/engineering/multi-agent-research-system ｜ 上下文工程: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- 间接注入: https://arxiv.org/abs/2302.12173 ｜ AgentDojo: https://arxiv.org/abs/2406.13352 ｜ InjecAgent: https://arxiv.org/abs/2403.02691

**Part B**
- 仓库: https://github.com/harbor-framework/harbor ｜ 文档: https://harbor-framework-harbor.mintlify.app/introduction
- Tasks: https://harbor-framework-harbor.mintlify.app/concepts/tasks ｜ Verifiers: https://harbor-framework-harbor.mintlify.app/concepts/verifiers
- TB 2.0 数据集: https://huggingface.co/datasets/harborframework/terminal-bench-2.0
- TB v2.1 榜单: https://artificialanalysis.ai/evaluations/terminalbench-v2-1
- Snorkel 解读: https://snorkel.ai/blog/terminal-bench-2-0-raising-the-bar-for-ai-agent-evaluation/
