# Agent Note: v019 组合运行时资格认证门

Status: implemented

[English](2026-08-29-v019-composed-runtime-qualification.md) | 中文

> 隔离机制可以通过测试，但依赖注入、配置解析、插件排序或注册可能导致付费评估图使用错误的实现。

## Problem

现有的安全资格认证（`v019-security-qualification-v2`）检查源字符串并使用合成会话调用各个 API。它无法检测由依赖注入、配置解析、插件排序或服务注册引起的缺陷——这正是之前在 `fs-local`/`fs-sandbox` 组合中看到的同类缺陷，其中隔离机制通过测试，但付费评估图使用了错误的实现。需要一个更强的门，启动由 `generateRepoConfig()` 生成的确切配置，从 Cordis 上下文中解析实际运行的服务，检查有效图，执行真实的面向模型的能力路径，并持久化绑定到确切源和配置输入的工件。

## Decision

添加了 `v019-composed-runtime-qualification-v1`（`scripts/v019-composed-runtime-qualification.ts`）。资格认证脚本重用 `generateRepoConfig()` 生成确切的 Batch A `.v019-cordis.yml`，通过真实的 Loader 启动它，挂载生产 `RepairRuntime` 插件，并运行 15 项检查：

- **C1**：有效组合身份——查询 `ctx.get()` 获取 `fs`、`shell`、`sandboxPolicy`、`goals` 和 `repairController`，断言构造函数名称和策略模式。
- **C2**：文件工具隔离——通过工作区读/写（通过）、外部读/写（拒绝）和父目录遍历（拒绝）执行已注册的文件系统。
- **C3**：Bash 隔离——通过工作区读取（通过）、外部路径读取（拒绝）、DNS 查找（拒绝）、HTTP 连接（拒绝）和 git fetch（拒绝）执行已注册的 shell。
- **C4**：模型工作区不包含 Git 历史。
- **C5**：保留秘密——代理无法找到或读取保留文件；验证器可以读取它们。
- **C6**：一次性生命周期——`handleVerificationPass` 与通过的保留验证器产生 `verified` 结果，恰好 1 次 flash 尝试。
- **C7**：一次性保留失败——`handleVerificationPass` 与失败的保留验证器产生 `qualification-failed` 结果，无修复事件。
- **C8**：带回滚的修复成功——flash 失败 → 回滚 → flash 通过，断言回滚事件和终止完成。
- **C9**：Pro 升级——两次相同的 flash 失败产生 `pro-escalate` 决策，带有真实路由决策 ID。
- **C10**：回滚失败停止修复——失败的回滚提供者产生 `stop`/`rollback-failed`，无后续路由决策。
- **C11**：权限歧义——未来模式的权限事件导致 `releaseToAuto` 抛出异常。
- **C12**：工作区绑定验证——工作区变更更改来源哈希。
- **C13**：账本秘密清理——验证失败后持久事件不包含原始秘密。
- **C14**：未定价使用——`handleVerificationPass` 对未知模型抛出 `UNPRICED_USAGE`，无 $0 回退。
- **C15**：轨迹重建——`reconstructRepairState` 从组合会话历史中恢复尝试、模型和路由 ID。

Batch A 运行器（`scripts/run-v019-batch-a-evaluation.ts`）在验证器完整性检查之后调用 `runComposedRuntimeQualification()`，如果工件未就绪则退出并失败。`generateRepoConfig()` 从 `scripts/v019-trajectory-collector.ts` 导出以供资格认证重用。

`ComposedQualificationRecord` 工件绑定：`qualificationId`、`sourceCommit`（git HEAD）、`timestamp`、每项检查结果、`passedCount`/`failedCount`/`skipCount`/`passed`、`backend`（执行和网络拒绝）、`filesystem`（读/写围栏）、`holdout`（模型可读性）、`repair`（生产运行时、回滚、来源要求）和 `ready`（仅在所有检查通过时为 true）。

## Consequences

- Batch A 在组合运行时资格认证通过之前无法开始付费执行，关闭了隔离机制测试与真实组合图之间的差距。
- 资格认证重用确切的 Batch A 配置生成器，因此未来对 `generateRepoConfig()` 的任何破坏组合保真度的更改将在付费执行之前失败。
- 工件记录探测的后端执行状态（来自实际 shell 运行的 `sandbox.enforcement`），而非静态平台偏好——从 bwrap 回退到 Landlock 的 Linux 机器将报告 `partial` 执行，而非 `full`。
- C3 使用 `result.exitCode` 和 `result.sandbox?.denied`（而非 try/catch）检测沙箱拒绝，因为 `shell.run()` 在拒绝时解析为 `ShellRunResult`——异常仅代表基础设施故障。
- C3 使用工作区外的测试密钥文件（而非 `/etc/passwd`，bwrap/Landlock 有意允许只读）和 `git ls-remote`（而非 `git fetch --dry-run`，后者无论网络状态如何都会因"not a git repository"失败）。
- C5 使用实际沙箱 fs 和 bash 作为代理端，主机端 Node 作为验证器端，建立非对称访问属性。
- C8 检查 `passResult.verified` 和状态计数（而非 `repair/completed` 事件），因为 `handleVerificationPass()` 不发射 `repair/completed`——插件监听器拥有该事件。
- C12 将 `changedFiles` 传递给 `handleVerificationPass()` 并包含 `tool/call` 事件，使 `changedFilesInTurn()` 能找到它们，从而来源提供者哈希实际文件内容。
- 组合上下文在资格认证返回前被释放（`ctx.fiber.dispose()`），fail-loud 处理器被卸载，因此门不会将事件处理器或插件泄漏到 Batch A 进程中。
- 资格认证使用回滚提供者启动（与 Batch A 相同），因此"确切配置"声明在插件级别为真。
- 检查 C6-C15 标记为"helper-level"，因为它们使用合成会话调用导出的 repair-runtime 辅助函数，而非完整的插件→GoalService→completeVerified 管道。计划后续组合评估器场景层通过运行中的代理测试完整生命周期。
- 源修复：`handleVerificationPass()` 现在接受 `changedFiles` 并将其传递给来源提供者，来源失败现在是致命的（fail-closed）而非被静默吞没。
- 向 Batch A 组合添加新的安全关键能力需要扩展资格认证以添加相应的检查。

### 已知限制

- 冻结记录和组合资格认证工件现在持久化到 `artifacts/evals/`。在后续 Batch A 运行中，加载持久化冻结记录并针对其 `verifierIntegrityHash` 验证当前源，加载持久化组合资格认证工件并匹配当前源提交。这将评估绑定到先前限定的源状态，而非在同一进程运行中生成并立即验证的哈希。
- 组合运行时场景检查（S1-S7）通过启动上下文的根代理上的真实 GoalService 和 RepairRuntime 插件监听器驱动 `verifyCompletion()`，测试完整的插件→GoalService→completeVerified 管道。S1 测试一次性 PASS→holdout PASS→目标完成。S2 测试诊断 FAIL→修复证据+决策。S3 测试验证后 `completeVerified` 被拒绝。S4 测试代理通过沙箱访问 holdout 被拒绝。S5 测试工作区绑定完成（无突变→完成）。S6 测试回滚失败停止修复且无新付费调用。S7 测试权限模糊拒绝模型转换。
- 冻结记录现在使用组合运行时资格认证的探测后端而非 `platformEnforcement()`。组合资格认证启动真实 Cordis 上下文，通过实际沙箱运行 shell 命令，并记录后端是否拒绝网络访问。冻结记录的 `backendEnforcement` 字段反映实际探测的运行器，而非静态平台偏好。
- 工作区绑定完成现在在 `completeVerified()` 中实现。验证事件携带绑定到验证时工作区状态的可选 `workspaceHash`。在完成时，插件重新计算工作区哈希并将其传递给 `completeVerified()`，后者以 `GOAL_WORKSPACE_MUTATED` 拒绝不匹配。修复提示现在正确说明工作区已回滚到可信基础状态。
- 验证器完整性文件集现在覆盖组合资格认证脚本、冻结生成器、Batch A 运行器、repair-controller 类型和 goal 领域——将完整的评估器源闭包绑定到冻结哈希。
- Landlock 不隔离网络。从 bwrap 回退到 Landlock 的 Linux 运行时具有文件系统隔离但没有网络隔离。探测的后端检查将此报告为 `partial` 执行，基准测试门要求 `full` 执行（网络拒绝的后端）。
- 诊断验证器现在捕获失败验证命令的真实 stdout/stderr 并将其作为证据传递给修复模型。修复模型接收实际的测试失败输出、断言差异和构建错误，而非通用的"诊断验证命令失败"消息。
- 轨迹重建按 `routingDecisionId` 分组 `model/usage` 事件，而非每个使用事件计为一次尝试。一个逻辑尝试内的提供者重试被聚合——其令牌和成本被汇总，尝试延迟从轮次开始到最后一个使用事件。这防止了重试对尝试计数、修复率和升级率的膨胀。
- 控制平面和模型能力状态现在正确区分基础设施故障和模型故障。`rollback-failed`、`workspace-provenance-failed` 和 `unknown` 结果产生 `controlPlaneStatus=FAIL` 和 `modelCapabilityStatus=NOT_EVALUATED`，因为线束未完成评估管道，模型能力无法评估。
- 分类指标现在应用与全局指标相同的 `benchmarkEligible` 过滤，防止非基准轨迹（如 B0 冒烟测试）污染分类结果。
- 失败分类优先级已修正：F8（修复证据不足——相同指纹重复）在 F1/F17（模型推理/跨文件一致性）之前检查，因为重复的指纹比"做了修改但仍然失败"更具信息量。`v019-failure-taxonomy.spec.ts` 中的确定性夹具验证每个分类路径和优先级排序。
- 当付费请求缺少规范使用证据时，轨迹收集器失败关闭：如果存在 `repair/evidence` 事件但未找到 `model/usage` 事件，收集器抛出 `MISSING_USAGE_EVIDENCE` 而非静默生成零成本尝试。
- 验证器控制的任务文件（package.json、tsconfig.json、vitest 配置）在模型执行前被哈希。诊断验证器在每次验证调用时重新哈希这些文件，如果模型篡改了它们则拒绝任务，防止模型在最终验证前更改测试配置或模块解析。

## Alternatives considered

- **扩展现有安全资格认证以包含行为检查。** 拒绝：安全资格认证专注于源组合，会超出其范围。单独的组合运行时门保持两个关注点分离。
- **运行完整 Batch A 语料库作为资格认证。** 拒绝：付费执行不能是资格认证门——该门必须在付费执行开始之前通过。
- **仅源字符串检查。** 拒绝：源字符串检查无法检测依赖注入或注册缺陷，这是激励性失败类别。

<!-- agent-note-format: alternatives-recorded -->
