# Agent Note: v0.19 集成纠正——验证已解析的组合，而非包

Status: proposed

[English](2026-08-28-v019-integration-correction-audit.md) | 中文

## Problem

对 v0.19 评估路径的独立源码审计发现，实际运行时组合与评估声称测量的架构不匹配。单个包包含真实的安全机制——持久路由、规范记账、故障闭合子进程沙箱、修复决策逻辑——但 v0.19 评估器的 Cordis 组合并未将所有模型能力一致地路由通过这些机制。结果是当前 Batch A 的结果无法支持关于工作区隔离、未见过的留出测试、真实仓库、生产 RepairRuntime 性能的声明。

核心教训：验证已解析的执行组合，而非包。包级测试可以通过，而实际评估器绕过了该包提供的保证。

### 已验证发现

每项发现均已对照当前源码确认。

**S0-01：fs-local 仍在 v0.19 评估器中挂载。** `scripts/v019-trajectory-collector.ts` 中的 `generateRepoConfig` 将 `bash-local` 替换为 `sandbox-local` + `sandbox-policy` + `bash-sandbox`，但未将 `fs-local` 替换为 `fs-sandbox`。模型面向的文件工具通过 `fs-local` 路由，该包记录 `cwd` 是解析默认值，而非隔离边界。挂载的 `sandbox-policy` 不约束 `fs-local`。Bash 平台已沙箱化；文件系统工具平台未沙箱化。

**S0-02：fs-sandbox 不隔离读取。** `packages/fs/fs-sandbox/src/index.ts` 第 6–8 行声明："此包仅在两次变更上添加逐调用策略围栏。读取不受影响地通过：每种模式都允许读取。" 即使组合将 `fs-local` 换为 `fs-sandbox`，读取仍不受限制。仅隔离写入对工作区隔离评估不足。

**S0-03：V3 留出测试对模型可见。** `scripts/v019-batch-a-repos.sh` 在调用 `init_repo` 之前将留出测试文件创建在 `tests/*.holdout.test.ts` 下，因此它们被提交到呈现给模型的基准仓库中。模型可以读取它们。

**S0-04：诊断发现包含留出测试。** 每个生成的仓库的 Vitest 配置使用 `include: ['tests/**/*.test.ts']`。留出测试文件匹配 `tests/**/*.test.ts`。所有 15 个 V3 任务使用 `npm test` 作为诊断命令。诊断运行执行留出测试，然后测试框架再次运行相同的留出测试。V3 标识无效：留出测试不是未见的。

**S0-05：Batch A 是合成的，非真实仓库。** 语料库头部声明"25 个真实仓库基准测试任务"，但每个清单都有 `source: 'synthetic'` 且 `REPO_BASE` 为 `file:///tmp/v019-batch-a-repos`。仓库由 `scripts/v019-batch-a-repos.sh` 生成。Batch A 是合成多仓库编码基准测试，非历史真实世界任务程序。

**S0-06：任务复现可能假通过。** 每个合成仓库在一个共享基准提交上包含多个故意损坏的函数，一个共享修复提交修复其中几个或全部。验证门询问 `npm test` 是否在基准处失败并在修复处通过，但一个不相关的损坏函数可能导致基准失败，一个不相关的修复可能使其通过。该门不证明任务特定复现。

**S1-01：v0.19 评估器使用 v018 脚本循环，非生产 RepairRuntime。** `scripts/v019-trajectory-collector.ts` 从 `./v018-repair-loop.ts` 导入 `runRepairLoop` 并直接调用。生产 `RepairRuntime` 包未在 `packages/bundle/base/cordis.patch.yml` 中挂载。Batch A 验证的是围绕 `decideRepair()` 的实验脚本循环，非生产持久执行管道。

**S1-02/S1-03：回滚和来源是可选的。** `RepairRuntime` 仅在 `deps.rollbackProvider !== undefined` 时运行回滚。v019 轨迹收集器无条件设置 `rollbackUsed: false`。实验修复提示说"上一次尝试的工作区状态被保留。" Batch A 无法提供回滚正确性、事务性修复或回滚经济性的证据。

**S1-04：验证未绑定工作区内容。** `GoalService.completeVerified()` 要求最新的持久事件是 `goal/verification` 且目标修订和验证器注册指纹匹配，但验证回执不包含工作区内容哈希。不发出会话事件的外部文件系统变更使验证回执保持有效。

**S1-05：持久证据存储原始验证器输出。** 生产 `RepairRuntime` 构建原始 `FailurePackage`，持久化 `repair/evidence` 包含原始 `failedCriteria`/`failingTests`/`typeErrors`/`buildErrors`，仅在生成下一个模型提示时通过 `projectFailureForModel()` 清理。会话账本、检查点和导出可以保留未清理的验证器输出。

**S1-06：Seatbelt 的 workspace-isolated 不是工作区隔离。** `packages/sandbox/sandbox-local/src/profiles.ts` 记录 Seatbelt 使用 `allow-all-reads` 加显式受保护路径拒绝列表，而非允许列表。`packages/sandbox/sandbox-policy/src/index.ts` 默认 `protectedReadPaths: []`。默认 macOS workspace-isolated 组合可以等同于允许所有主机读取，而系统提示说"进程只能在会话工作区内读写。"

**S1-07：releaseToAuto 覆盖不可判定的权限。** `reconstructSelectionState()` 对未来权限模式返回 `{ undecidable: true }`。`releaseToAuto()` 检查 `prior === undefined || (!('undecidable' in prior) && prior.mode === 'auto')`；不可判定状态不满足两个条件，落入 `appendState`，用 auto 覆盖未知状态。

**S1-08：未知定价变为 $0。** 轮次运行器执行 `pricing === undefined ? 0 : calculateCost(...)`。未知模型别名或定价注册错误使经济指标看起来人为地更好。

**S1-09：指标不过滤 benchmarkEligible。** `computeMetrics()` 记录"仅 `benchmarkEligible` 轨迹贡献"，但仅按 `modelCapabilityStatus !== 'NOT_EVALUATED'` 过滤。B0/基准分离是操作性的，未在指标函数中强制执行。

**S1-10：replayMismatchRate 硬编码为零。** `v019-metrics.ts` 返回 `replayMismatchRate: 0` 而不从轨迹证据推导。报告的零不意味着重放已测试。

**S2-01：每次尝试的 changedFiles 不准确。** 轨迹收集器在映射时为每次尝试调用 `getChangedFiles(workspace)`，因此每次尝试接收最终工作区差异而非自己的差异。

**S2-02：延迟排除验证。** 轮次运行器仅计时 `runFixtureTurn`；验证单独运行。`totalLatencyMs` 测量模型执行，非挂钟任务延迟，但修复预算将其用作经过时间。

**S2-03：沙箱验证跳过计为通过。** `scripts/verify-sandbox-read-isolation.ts` 中的符号链接测试捕获错误并推送 `{ passed: true }`，将跳过计为通过并中止套件的其余部分。

**S2-04：源清单过期。** `FULL_FILE_MANIFEST.sha256` 相对于当前存档有 2 个校验和不匹配和 29 个未列出文件，主要是 v0.19 工作。

## Proposal

暂停 Batch A。在花费更多提供商资金或收集基准数据之前，执行专用的集成纠正里程碑。目标是使实际运行时组合与声称和测量的架构匹配。

### 阶段 0：冻结和分类

记录这些发现（本笔记）。将 Batch A 重新分类为 `v019-synthetic-multirepo-validation-v1`，非真实仓库基准测试。使当前 V3 留出测试声明无效。不修改控制器策略。

### 阶段 1：文件系统安全平面

在合格评估组合中将 `fs-local` 替换为 `fs-sandbox`。在 `fs-sandbox` 中实现读取围栏：`authorizeRead(path, context)` 和 `authorizeWrite(path, context)`，使用规范路径解析（规范化、解析、realpath、符号链接链、与允许根比较）。对于 `workspace-isolated`：读取允许在工作区和显式不可变运行时根内；写入允许在工作区和私有临时目录内；其他一切拒绝。添加对抗性进程内文件系统测试，覆盖工作区读/写、父级遍历、绝对外部路径、符号链接逃逸和多跳符号链接链。通过 `tool-fs/read`、`tool-fs/write`、`tool-fs/edit` 测试，而非仅低级辅助函数。

### 阶段 2：诚实的子进程隔离

拆分后端保证：bwrap（读取允许列表、写入允许列表、私有临时、网络拒绝）、Landlock（读取允许列表、写入允许列表、修复私有临时）、Seatbelt（受保护读取拒绝列表，非仅工作区读取）。Seatbelt + workspace-isolated + 空 `protectedReadPaths` 必须是配置错误。为每次执行添加私有临时目录（`TMPDIR`、`TMP`、`TEMP`）。隔离评估工作器的默认网络拒绝；提供商 API 调用源自测试框架进程，非不受信任的子进程。

### 阶段 3：事务性修复

添加 `qualified` 修复模式，要求 `rollbackProvider`、`workspaceProvenanceProvider` 和 `holdoutVerifier`（用于 V3）。缺少必需依赖时启动失败。在评估中连接测试框架拥有的回滚实现（git worktree 或工作区内容快照）。持久化回滚来源：`workspaceBeforeHash`、`workspaceAfterHash`、`rollbackTargetHash`、`rollbackResultHash`。

### 阶段 4：工作区绑定验证

向验证回执添加 `workspaceHash`。完成要求 `currentWorkspaceHash == verification.workspaceHash`。SHA-256 覆盖确定性工作区快照，排除 `.git`、`node_modules`、`dist`、构建缓存、私有临时和会话工件。

### 阶段 5：持久化前清理证据

在原始验证器输出和 `repair/evidence` 持久化之间插入 `DurableEvidenceSanitizer`。清理 Authorization 头、Bearer 令牌、API 密钥、密码、含凭据的数据库 URL、AWS 凭据、cookie、JWT、私钥块和 `.env` 密钥赋值。使用不区分大小写的模式。原始证据仅可存在于特权非账本调试设施中。

### 阶段 6：修复权限变更

`releaseToAuto` 必须拒绝不可判定状态：` absent → 可创建 Auto；已知 Auto → 幂等；已知 Manual → 释放为 Auto；不可判定/未来 → 拒绝`。使用比较并设置（`releaseToAuto(expectedAuthorityVersion)`）以避免竞争。

### 阶段 7：评估架构

停止使用 `v018-repair-loop.ts` 作为基准运行时。评估应演练生产 `RepairRuntime` → `RepairController` → 持久模型权限 → 路由决策 → 提供商 → 验证器 → 回滚/来源 → 重放管道。在启动时通过解析 Cordis 组合生成有效运行时清单。验证将声明与此清单比较。不变式：声明 = 已解析组合 = 已执行路径。

### 阶段 8：留出测试架构

从模型工作区移除留出测试。将它们外部存储在 `qualification/holdouts/<task-id>/` 下，由测试框架拥有。从验证器拥有的位置运行留出测试。诊断命令不得发现留出测试：诊断包含使用 `tests/diagnostic/**/*.test.ts`，而非 `tests/**/*.test.ts`。添加预检断言留出测试文件在诊断发现中不存在。

### 阶段 9：替换 Batch A 语料库

将当前 Batch A 重命名为 `v019-synthetic-multirepo-validation-v1`。保留为系统基准测试。从历史开源任务构建真实 Batch A，使用任务特定复现门：特定任务回归在基准处失败并在参考修复处通过，而非仅 `npm test` 失败。

### 阶段 10：结构化诊断证据

捕获失败测试名称、断言差异、TypeScript 错误、构建错误、堆栈跟踪、退出码和相关 stdout/stderr。持久化前清理。生成包含实际信息的 `FailurePackage`，而非"验证命令未通过。"

### 阶段 11：记账纠正

未定价使用必须使验证失败（`UNPRICED_USAGE` → 控制平面失败），而非变为 $0。分离 `modelLatencyMs`、`diagnosticLatencyMs`、`holdoutLatencyMs`、`rollbackLatencyMs` 和 `totalWallClockMs`。修复时间预算使用 `totalWallClockMs`。

### 阶段 12：指标纠正

按 `benchmarkEligible === true && modelCapabilityStatus !== 'NOT_EVALUATED'` 过滤。用 `null` / `not-measured` 替换硬编码的 `replayMismatchRate: 0`，或由实际重放记录支撑。通过前后快照捕获每次尝试的文件系统差异，而非映射时的最终工作区差异。

### 阶段 13：沙箱验证

用跳过即未完成替换跳过即通过。必需验证报告：`required=9, executed=9, passed=9, skipped=0, failed=0`。添加缺失的进程内文件工具测试。完整沙箱验证需要子进程和进程内工具两个平面。

### 阶段 14：安全验证门

创建 `v019-security-qualification-v1`，覆盖文件系统工具平面、子进程平面、修复事务性、验证绑定、证据清理、权限语义、记账和组合清单生成。在安全验证门通过之前，不进行真实 Batch A。

### 阶段 15：v0.18 勘误

不移动 v0.18.0 标签。发布验证澄清：持久路由/记账/重放、子进程故障闭合包装器、修复决策逻辑和审批拒绝仍受支持。完整工作区读取隔离、默认事务性回滚、必需来源和集成 RepairRuntime 组合未由 v0.18.0 验证建立。

### 阶段 16：安全后冒烟和冻结

运行一个廉价 B0 任务以验证有效组合、fs-sandbox、读取围栏、网络拒绝、私有临时、RepairRuntime、回滚、来源、记账和验证哈希。冻结 `v019-secure-eval-v1`。然后构建 25 个历史真实任务并启动真实 Batch A。

## Alternatives considered

**继续 Batch A 并稍后修复问题。** 评估已在具有无效 V3 留出测试、无文件系统隔离和无生产 RepairRuntime 的路径上花费提供商资金。现在收集的数据无法追溯变为有效。暂停的成本低于无效基准数据的成本。

**仅修复文件系统平面并继续。** 留出测试可见性、宽泛复现门和脚本循环运行时是独立的验证缺陷。修复一个不解决其他缺陷。

**归档 v0.18 验证并重新开始。** v0.18 中真实的机制（路由、记账、重放、子进程故障闭合、修复决策）仍有价值。澄清范围的勘误比无效化更诚实，并保留已正确建立的证据。

## Acceptance criteria

- `scripts/v019-trajectory-collector.ts` 中的 `generateRepoConfig` 挂载 `fs-sandbox` 而非 `fs-local`，且组合级回归测试断言工作区隔离评估的文件系统提供者为 `fs-sandbox`。
- `fs-sandbox` 实现带规范路径解析的 `authorizeRead` 和 `authorizeWrite`；通过 `tool-fs/read`、`tool-fs/write`、`tool-fs/edit` 的对抗性进程内测试验证零文件系统逃逸，包括符号链接链。
- 留出测试文件不存在于模型工作区和诊断测试发现中；预检断言此条件。
- Batch A 重命名为 `v019-synthetic-multirepo-validation-v1`；移除真实仓库标签。
- 任务特定复现门验证特定任务回归在基准处失败并在参考修复处通过，而非仅 `npm test` 失败。
- v019 评估器使用生产 `RepairRuntime`，非 `v018-repair-loop.ts`；`rollbackUsed` 反映实际回滚事件。
- `releaseToAuto` 拒绝不可判定权限状态；测试验证未来模式事件后按 Auto 产生零新权限事件。
- `computeMetrics` 按 `benchmarkEligible === true && modelCapabilityStatus !== 'NOT_EVALUATED'` 过滤。
- `replayMismatchRate` 为 `null` 或由实际重放记录支撑，从不硬编码为零。
- 未知定价产生 `UNPRICED_USAGE` 控制平面失败，而非 $0 成本。
- 沙箱验证将 `skipped` 与 `passed` 分开报告；必需跳过意味着 `INCOMPLETE`。
- `v019-security-qualification-v1` 在文件系统、子进程、修复、验证、证据、权限和记账平面上通过。
- 发布 v0.18.0 验证勘误，澄清已建立和未建立的内容。
- 一个安全后 B0 冒烟任务在运行任何真实 Batch A 任务之前验证有效组合。

## Risks

纠正阶段延迟 75 任务基准程序。延迟是合理的：来自无效组合的基准数据比无数据更差。最大的实现风险是 fs-sandbox 读取围栏工作，需要针对符号链接链和 TOCTOU 竞争稳健的规范路径解析。Seatbelt 诚实纠正可能需要重命名下游配置引用的安全层级。RepairRuntime 挂载需要理解 v018 脚本循环绕过的生产组合路径。
