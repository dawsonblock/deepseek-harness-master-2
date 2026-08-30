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
- 工作区验证哈希已统一：验证和完成时使用相同的完整工作区 SHA-256 算法。来源提供程序现在计算 `computeWorkspaceHash(workspace)` 而非仅哈希更改的文件，后者之前产生与验证时哈希不同的摘要，导致 `completeVerified()` 拒绝每次合法完成。
- `verifyCompletion()` 现在接受 `workspaceSnapshotProvider` 函数而非预计算哈希。哈希在所有验证器运行后计算，因此绑定实际测试的工作区状态。诊断命令（测试运行器、类型检查器）可能在执行期间创建或修改文件；验证前哈希不会反映已验证状态。
- `completeVerified()` 现在在验证事件携带工作区哈希时要求提供当前工作区哈希。缺少当前哈希将拒绝完成，而非静默绕过工作区绑定。
- `completeVerified()` 抛出的 `GOAL_WORKSPACE_MUTATED` 现在在 RepairRuntime 插件的通过处理程序中被捕获，并显式终态化为 `workspace-provenance-failed` 结果，附带 `repair/completed` 和目标阻塞，而非作为未处理的 Promise 拒绝逃逸。
- 回滚现在通过将 `node_modules`、`sessions`、`.git` 和 `dist` 目录移动到临时位置，然后从基础提交恢复源代码，再将它们移回来保留这些目录。之前的实现删除整个工作区并从 git archive 重新提取，破坏了已安装的依赖项和线束状态，可能导致第二次修复尝试因基础设施原因失败而被误分类为模型失败。
- Batch A 轨迹收集器现在通过 `finally` 块中的 `ctx.fiber.dispose()` 在每个任务后处置其 Cordis 上下文 fiber，防止事件处理程序、插件效果和会话基础设施泄漏到同一进程中的后续任务。
- C5 和 S4（保留秘密检查）现在在 `fs.readText()` 之前调用 `fs.resolve()`，与 C2 模式匹配。之前的实现将原始路径字符串传递给 `readText()`，可能仅因参数形状无效而抛出异常，产生沙箱正确拒绝保留访问的假阳性。
- 组合后端资格认证现在绑定环境。资格记录包含 `environment: { platform, arch, nodeVersion, runner }`。持久化记录仅在源提交和环境都匹配时才重用。仅源匹配检查可能在从有 bwrap 的机器回退到 Landlock 的机器上重用资格，使后端资格失效。
- C3 网络测试现在使用 `127.0.0.1` 上的确定性线束拥有的本地 TCP 监听器，而非公共互联网 DNS/HTTP/git 测试。沙箱子进程尝试连接到本地监听器；网络隔离沙箱（bwrap `--unshare-net`、Seatbelt `deny network*`）拒绝连接。这是确定性的，不依赖外部互联网可用性、DNS 或代理状态。
- S2 现在通过启动带有失败保留验证器的新组合上下文来测试诊断 PASS → 保留 FAIL → 资格失败，而非测试诊断 FAIL → 修复证据（这是不同的场景）。目标必须以 `qualification-failed` 结果被阻塞，且无修复证据或决策事件。
- S3 现在在验证和完成之间真正修改工作区，在验证后写入 `src.ts`，然后使用当前（不匹配的）哈希调用 `completeVerified()`。之前的实现测试幂等性（两次调用 `completeVerified`），而非验证后修改拒绝。
- S6 现在启动带有失败回滚提供程序的新组合上下文，以测试回滚失败 → 终态 `rollback-failed` → 无新付费调用。之前的实现使用主上下文的成功回滚提供程序，仅检查 `repair/decision` 是否触发。
- S8（新增）通过启动带有诊断验证器（失败两次后通过）的新组合上下文来测试两次 Flash 失败 → 真实 Pro 路由 → Pro PASS，验证发出 `pro-escalate` 动作的 `repair/decision`、发生 `model/escalation`，且目标在 Pro 尝试后完成。
- 验证器控制文件哈希现在包括锁文件（`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`）、测试设置文件（`tests/setup.ts` 等）和标准测试目录（`tests/`、`test/`、`__tests__/`、`src/__tests__/`）中的所有测试文件。之前的实现仅哈希 `package.json`、`tsconfig.json` 和 vitest/vite 配置，允许模型篡改测试文件或设置而不被发现。
- `buildFailurePackage` 现在在 `failedCriteria` 和 `failingTests` 中包含 `check.evidence`（捕获的 stdout/stderr），不仅是 `typeErrors` 和 `buildErrors`。对于名称不包含 'test'、'type' 或 'build' 的诊断验证器（如 `v019-diagnostic`），证据内容通过模式匹配分类（测试运行器输出、TypeScript 错误、构建失败），因此修复模型无论验证器命名如何都能接收真实诊断输出。
- 每请求使用对账：每个 `repair/evidence` 事件现在通过 `routingDecisionId`（或回退到 turn）检查对应的 `model/usage` 事件。没有匹配使用的修复证据事件抛出 `MISSING_USAGE_EVIDENCE`，包含特定路由决策和 turn，而非仅检查聚合计数。
- 轨迹连接现在使用 `routingDecisionId` 作为模型查找和修复证据/决策关联的主连接键，仅对缺少 `routingDecisionId` 的遗留事件回退到尝试序号。之前的实现使用基于 turn 的匹配作为主连接，当同一 turn 发生多个路由决策时可能不匹配。
- `RepairCompletedEventData` 现在声明可选的 `workspaceHash` 字段，使绑定到终态事件的工作区内容哈希成为类型化事件模式的一部分。
- 失败分类现在有 F2（repo-context：参考修复文件未检查，无更改）、F3（wrong-file：更改不重叠参考修复）、F7（dependency：进度提及模块解析错误）和 F12（timeout-latency：终态结果或中止原因指示超时）的检测路径。F4、F5、F15 和 F16 通过 `MANUAL_ONLY_CATEGORIES` 标记为仅手动，因为它们无法从轨迹证据自动检测。
- `CategoryMetric` 现在在 `count`（所有任务）和 `evaluated`（合格 + 已评估）旁边包含 `eligibleCount`（基准合格任务）。之前的实现仅暴露 `count`（原始）和 `evaluated`，使 `count` 是否包含非基准任务变得模糊。
- 组合资格认证的来源提供程序现在使用 `computeWorkspaceHashForDir(workspace)`（完整工作区 SHA-256），与实时评估器的 `createProvenanceProvider` 完全匹配。之前的组合认证提供程序仅哈希 `context.changedFiles`，永远无法匹配完整工作区验证哈希，导致 S5 因错误原因失败。
- 环境身份现在通过探测平台特定二进制文件检测实际沙箱运行器（`bwrap`、`landlock`、`seatbelt` 或 `none`），而非硬编码 `sandbox-local`。`environmentMatches()` 现在除了比较 `platform`、`arch` 和 `nodeVersion` 外还比较 `runner`，防止跨不同沙箱后端重用资格认证。
- `PRESERVE_DIRS` 不再包含 `dist`。`dist` 目录是模型/构建生成的输出，而非线束状态。在回滚间保留它可能污染下一次尝试或最终资格认证。仅保留 `node_modules`、`sessions` 和 `.git`。
- 验证器控制文件哈希现在包含 `node_modules` 完整性：顶级包目录列表和锁文件元数据（`.package-lock.json`、`.modules.yaml`、`.pnpm/lock.yaml`）。修改已安装依赖项（如修补 vitest 内部）的模型将被检测到。`node_modules` 的完整内容哈希不切实际；这检测结构性篡改。
- S3 现在在快照提供程序内部修改工作区（在计算修改前哈希之后但在返回之前），因此修改发生在验证和第一次完成授权之间——而非目标已经终态之后。测试断言 `outcome === 'workspace-provenance-failed'` 和 `goalPhase === 'blocked'`，证明特定的 `GOAL_WORKSPACE_MUTATED` 路径被执行，而非仅 `completeVerified` 因任何原因抛出。
- 使用对账现在使用 `model/routing-decision` 事件作为会计人口，而非 `repair/evidence`。每个路由决策代表一个付费请求，必须有匹配的 `model/usage`。这捕获一次性成功和最终成功修复尝试的缺失使用，这些有路由决策但无修复证据。
- F7-dependency 分类现在检查实际错误证据（`repair/evidence` 事件中的 `failedCriteria`、`failingTests`、`typeErrors`、`buildErrors`），而非 `progress`（即 `ProgressClass` 枚举：`none`/`partial`/`regression`/`resolved`）。之前的实现对 `progress` 匹配正则表达式，在生产中永远无法匹配，因为 `ProgressClass` 值是枚举字符串，而非自由文本错误消息。`AttemptTrajectory` 现在携带四个错误证据数组。
- F2-repo-context 和 F3-wrong-file 现在是仅手动分类。参考修复文件是取证证据，而非评分权威——有效的替代解决方案可以触及与历史维护者补丁完全不同的文件。之前的自动 F2/F3 路径从代理信号产生认识论上不安全的分类。
- 验证器控制文件发现现在是递归和语言感知的。测试目录（`tests/`、`test/`、`__tests__/`、`src/__tests__/`）递归遍历，模式覆盖 Python（`test_foo.py`、`foo_test.py`）、Go（`foo_test.go`）、Java（`FooTest.java`）和 Rust（`foo_test.rs`），除 JS/TS 外。之前的实现仅检查直接目录条目和以 JS/TS 为中心的模式。
- S8 现在断言确切路由链接：`model/escalation.toRoutingDecisionId` 必须等于实际 Pro `model/routing-decision.routingDecisionId`。之前的实现仅检查升级事件存在且目标完成，未验证路由链已链接。
- C3 网络隔离测试现在使用 Node 二进制文件（`process.execPath` 与 `net.connect`）而非 `nc`/`curl`/`python3`。Node 保证在此运行时存在；之前的实现如果三个外部命令都不可用，可能产生假阳性网络拒绝。
- `RepairRuntime` 现在在运行时内部强制缺失使用作为控制平面失败，而非仅在轨迹提取中。`computeAttemptAccounting` 接受 `failOnMissingUsage` 参数；启用时，没有匹配 `model/usage` 事件的付费路由决策抛出 `MISSING_USAGE` 而非静默坍缩为 `$0`/`0` token/`0` 延迟。`RepairRuntimeConfig.failOnMissingUsage` 和 `RepairHandlerDeps.failOnMissingUsage` 传播该标志。实时评估器和所有组合资格场景启用它；单元测试默认为 `false` 以避免为非会计场景注入使用事件。
- `ComposedQualificationRecord` 中的 `backend` 字段现在包含 `runner`——实际检测到的沙箱运行器（`bwrap`、`landlock`、`seatbelt`、`windows-acl`）——而非仅从 C3 测试成功推断强制。`enforcement` 和 `networkDenied` 字段仍从 C3 派生，但运行器身份现在是持久资格记录的一部分。
- `node_modules` 现在通过 `SandboxExecutionPolicy` 上的新 `readOnlyPaths` 字段对模型只读。进程内 FS 围栏（`dsh-fs-sandbox`）拒绝写入 `readOnlyPaths` 下的路径；bwrap 配置使用 `--ro-bind` 重新挂载；Seatbelt 配置添加 `(deny file-write* (subpath ...))` 规则；Landlock 配置将它们添加到 `readOnly` 授权。v019 评估配置 `readOnlyPaths: [workspace/node_modules]`。新的组合资格检查 C2b 验证模型无法写入 `node_modules` 但可以读取。这满足审计的 P0.3 要求：从工作区哈希中排除但能够影响验证的任何内容必须受到保护，防止模型突变。
- `ComposedQualificationRecord` 中的 `backend` 字段现在除了 `runner` 外还包含 `runnerPath`、`runnerVersion` 和 `networkIsolation`。`runnerPath` 是运行器二进制文件的绝对路径；`runnerVersion` 是运行器的版本字符串（或 seatbelt 的 macOS 产品版本）；`networkIsolation` 命名机制（bwrap 为 `netns`，seatbelt 为 `sandbox-denied`，landlock 为 `no-network-grant`）。`environmentMatches()` 现在除了平台、架构、Node 版本和运行器名称外，还比较运行器路径和版本，因此使用一个运行器二进制或版本生成的资格在选择不同运行器时不会被重用。
- repair-runtime 的 FAIL 处理程序现在延迟到微任务（`void Promise.resolve().then(...)`），以便 `goal/verification` 追加在失败处理程序追加 `repair/evidence`、`repair/decision`、`repair/rollback` 和 `repair/completed` 之前完成。在 `session/event` 发布周期内同步运行会导致 `session.append` 重入错误。PASS 处理程序已通过 `handleVerificationPass().then(...)` 延迟；现在将相同模式应用于 FAIL 分支和在 `model/routing-decision` 上触发的 `model/escalation` 处理程序。插件还在其 `inject` 数组中声明 `repairController` 并正确绑定 `decide`，以便 FAIL 处理程序可以调用修复控制器。
- 组合资格认证的 `waitForEvent` 辅助函数现在接受基线 `seq` 参数，以查找在给定序列号之后追加的事件，防止它返回同一共享上下文上先前场景的事件。场景 S5 和 S7 在创建自己的目标之前清除先前场景留下的阻塞目标。S8 在第 3 轮路由决策到达后重新扫描 `model/escalation`。C9 期望 `flashAttempts=1`/`proAttempts=1`（而非 `flashAttempts=2`），因为第二次 Flash 失败升级到 Pro。
- Batch A 运行器现在在每次启动时重新运行 `runComposedRuntimeQualification()`，而不是重用持久化记录。持久化记录保留为审计证据，但绝不替代新鲜的后端探测。持久化记录无法安全替代，因为后端行为取决于实际的沙箱运行器、网络隔离机制和环境——这些都不能保证在启动之间稳定。
- 基准合格任务要求 `backend.enforcement === 'full'` 和 `backend.networkDenied === true`。部分后端（例如没有网络隔离的 Landlock）可用于产品操作，但不能用于基准合格评估。当强制执行不足时，Batch A 门以 `process.exit(1)` 拒绝执行。
- `RepairAttempt`、`RepairEvidenceEventData`、`RepairDecisionEventData` 和 `RepairRollbackEventData` 现在携带显式 `attemptId` 字段（`${repairId}#attempt-${attemptNumber}`）。这为属于同一修复尝试的所有事件提供单一确定性连接键，补充现有的 `routingDecisionId` 和尝试编号。轨迹重建从 `repairId` 和尝试编号合成相同的 `attemptId`。
- `RepairRollbackEventData` 现在声明 `targetHash` 和 `resultHash` 字段，与为回滚收据验证添加的运行时发射匹配。该类型之前省略了这些字段，尽管运行时已发射它们。
- 工作区快照算法和排除集通过 `scripts/v019-repo-checkout.ts` 中的 `WORKSPACE_SNAPSHOT_ALGORITHM`（`sha256-tree-v2`）和 `WORKSPACE_SNAPSHOT_EXCLUSIONS`（`verifier-snapshot-exclusions-v1`）进行版本化。组合资格记录包含 `snapshot: { algorithm, exclusions }`，`environmentMatches()` 检查两个版本，因此哈希或排除的更改会使持久化记录失效。
- 实验清单（`ExperimentManifest`）现在绑定实际的沙箱后端（运行器、路径、版本、强制执行、网络拒绝）、快照算法和排除集版本，以及组合资格工件的 SHA-256 哈希。这些包含在清单哈希中，因此每个轨迹引用捕获确切测量系统的实验身份。通用评估运行器（`run-v019-evaluation.ts`）也在构建清单之前运行组合资格认证。

## Alternatives considered

- **扩展现有安全资格认证以包含行为检查。** 拒绝：安全资格认证专注于源组合，会超出其范围。单独的组合运行时门保持两个关注点分离。
- **运行完整 Batch A 语料库作为资格认证。** 拒绝：付费执行不能是资格认证门——该门必须在付费执行开始之前通过。
- **仅源字符串检查。** 拒绝：源字符串检查无法检测依赖注入或注册缺陷，这是激励性失败类别。

<!-- agent-note-format: alternatives-recorded -->
