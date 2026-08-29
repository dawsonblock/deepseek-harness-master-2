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
- 工件记录平台执行状态，因此 macOS（部分 Seatbelt）和 Linux（完整 bwrap/landlock）运行是可区分的。
- 向 Batch A 组合添加新的安全关键能力需要扩展资格认证以添加相应的检查。

## Alternatives considered

- **扩展现有安全资格认证以包含行为检查。** 拒绝：安全资格认证专注于源组合，会超出其范围。单独的组合运行时门保持两个关注点分离。
- **运行完整 Batch A 语料库作为资格认证。** 拒绝：付费执行不能是资格认证门——该门必须在付费执行开始之前通过。
- **仅源字符串检查。** 拒绝：源字符串检查无法检测依赖注入或注册缺陷，这是激励性失败类别。

<!-- agent-note-format: alternatives-recorded -->
