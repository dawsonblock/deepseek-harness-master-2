# Agent Note: v0.18 修复运行时加固

Status: proposed

[English](2026-08-26-v018-repair-runtime-hardening.md) | 中文

## 问题

[v0.18 RepairController](../../implemented/feature/2026-08-26-v018-repair-controller-service.zh.md) 已发布正确的、确定性的决策逻辑：`decideRepair`、`classifyProgress`、`computeProgressMetrics`、`computeFailureFingerprint`、`computeFailurePackageId` 以及 Flash #1→#2→#3→Pro 升级策略均为纯函数、已测试且重放稳定。[v0.17.4 实验](../../implemented/feature/2026-08-25-v0174-flash-failure-pro-repair.zh.md)已证明该策略的经济价值。

该控制器与真实执行之间的运行时集成边界存在问题。控制器做出正确的决策；运行时未通过持久路由权威执行这些决策，未记录真实执行历史，在重启后未重建完整状态，且未区分诊断验证与保留验证。结果是修复决策、模型路由、验证、重放、计费与会话日志描述了不同的历史。

经当前源码验证的具体缺陷：

1. **伪造路由身份。** `handleVerificationFailure` 构造 `toRoutingDecisionId: \`pro-${state.repairId}-${state.proAttempts}\``，而非通过 `llm-model-router` 创建真实路由决策。`pro-escalate` 和 `flash-repair` 均调用 `agent.followup()` 而未绑定路由权威。持久事件链引用的 ID 没有任何 `model/routing-decision` 事件产生过。

2. **PASS 时缺失完成事件。** 插件在 `goal/verification` PASS 时提前返回，从不发出 `repair/completed`。完成事件仅在 `handleVerificationFailure` 内发出，而该函数仅在 FAIL 时调用。集成测试手动追加 `repair/completed` 以绕过此问题。

3. **重放修改尝试身份。** `reconstructRepairState` 在遇到后续 `pro-escalate` 决策时将先前 Flash 尝试的模型改为 `proModel`。修复决策不是模型执行尝试；重放必须从 `model/routing-decision` → `model/request` → `model/usage` → `goal/verification` 重建尝试，并将修复事件作为注释叠加。

4. **时间戳派生的 `repairId`。** `repairId` 为 `repair-${goal.id}-${Date.now()}`，因此崩溃/重放会产生不同 ID，无法匹配先前持久事件。`failurePackageId` 已为确定性（SHA256 of session+turn+routingDecisionId）并经集成测试验证重放稳定。

5. **不完整的重放状态。** `reconstructRepairState` 重建尝试时缺少 `failurePackage` 字段。重启后 `lastAttempt?.failurePackage` 为 `undefined`，因此 `classifyProgress(priorFailure, failure)` 通过 `priorEvidence === undefined` 分支返回 `'none'`。进度感知的 Flash #3 策略在重放时失效，尽管实时路径正常工作。

6. **无规范用量计费。** `handleVerificationFailure` 硬编码 `costUsd: 0, latencyMs: 0`；`state.totalCostUsd` 从不递增。`decideRepair` 中的 `RepairLimits.maxTaskCostUsd` 和 `maxElapsedMs` 检查存在但不可达，因为预算始终为零。

7. **运行时无保留验证分离。** 资格脚本分离了诊断验证与保留验证（`verifyWorkspace` vs `holdoutVerify`，`diagnosticPass`/`holdoutPass`）。生产运行时插件将所有 `goal/verification` FAIL 同等对待。保留验证失败可能将证据馈入修复提示。

8. **模型权威未接线。** `decideRepair` 通过 `isPro(a.model, input.currentModel)` 推断 Pro。运行时硬编码 `manualModelSelection: false` 和 `proModelAvailable: true`，从不读取路由器的 `ModelSelectionAuthority` 或 `markExplicitModelSelection`。手动 Flash 任务可能静默升级到 Pro。

9. **重建关键事件标记为可忽略。** 所有四个修复事件均以 `{ ignorable: true }` 发出，包括 `repair/evidence` 和 `repair/decision`，而 `reconstructRepairState` 读取它们以恢复正确执行。

10. **模型可见证据无净化。** `renderRepairPrompt` 和 `renderProEscalationPrompt` 将原始失败证据直接倾入提示，未剥离密钥、绝对路径、凭据或保留材料。

## 提案

加固运行时边界，使执行真相、重放真相、计费真相与事件日志真相一致。将工作分为 P0（步骤 1–5）、P1（步骤 6–15）和 P2（步骤 16–24）。先执行 P0，作为一个 PR。

### 不要重新实现

以下内容已正确且已测试。实现不得复制或替换它们：

- `computeFailurePackageId` — 确定性、重放稳定、集成测试覆盖
- `classifyProgress` — 实现 resolved/partial/regression/none 优先级
- `computeProgressMetrics` — 计算 Jaccard 相似度及已解决/新增失败计数
- `decideRepair` Flash 进度感知升级策略 — Flash #1→#2，#2 进度→#3，#2 重复→Pro
- `RepairLimits` 成本/时间字段 — `maxTaskCostUsd`、`maxElapsedMs`、`maxOutputTokens`
- `decideRepair` 成本/时间预算检查
- 资格脚本诊断/保留类型 — `VerifyResult.diagnosticPass`/`holdoutPass`

工作位于运行时、重放和集成边界，不在控制器中。

### P0 — 执行权威、完成、尝试、身份、重放状态

**步骤 1：修复执行权威。** `pro-escalate` 和 `flash-repair` 必须在调用 `agent.followup()` 之前通过 `llm-model-router` 创建真实路由决策。`model/escalation` 事件的 `toRoutingDecisionId` 必须引用该决策的实际 `routingDecisionId`，而非构造的字符串。手动模型选择（`markExplicitModelSelection`、`reconstructSelectionState`）必须保持权威，除非策略明确允许升级。集成测试必须断言 `repair/decision = pro-escalate` 产生真实 Pro `model/request`，`flash-repair` 产生真实 Flash `model/request`。

**步骤 2：PASS 时修复完成。** 当存在活跃修复且 `goal/verification` PASS 到达时，插件必须发出 `repair/completed`，包含最终路由决策、总尝试次数、Flash/Pro 计数、最终验证状态和累计成本。然后清除内存中修复状态。测试正常完成、Flash 修复完成、Pro 接管完成及重启后完成。

**步骤 3：将尝试与决策分离。** `reconstructRepairState` 必须从真实执行事件（`model/routing-decision` → `model/request` → `model/usage` → `goal/verification`）重建尝试，将 `repair/evidence`、`repair/decision` 和 `model/escalation` 作为注释叠加。移除根据后续 `pro-escalate` 决策修改先前 Flash 尝试模型的逻辑。

**步骤 4：确定性 `repairId`。** 将 `repair-${goal.id}-${Date.now()}` 替换为从稳定执行身份派生的确定性 ID：`repair:v1:<sha256(sessionId + goalId + goalRevision + originatingRoutingDecisionId)>`。版本前缀防止未来标识符方案冲突。保留现有确定性 `failurePackageId`。不创建单独的 `escalationId`；通过引用步骤 1 创建的真实目标路由决策来修复升级来源。

**步骤 5：完整重放状态。** `reconstructRepairState` 必须在每个失败尝试上重建完整 `FailurePackage`，而非仅指纹。进度感知的 Flash #3 决策在重启前后必须一致。关键测试：Flash #1 失败 {A,B,C,D}，Flash #2 失败 {A,B}（部分进度），崩溃，重启，Flash #3 决策必须与未中断执行的决策一致。

### P1 — 保留、计费、预算、权威、证据、来源、回滚、事件、排序、幂等

**步骤 6：运行时保留分离。** 将诊断/保留区分从 `scripts/v018-repair-loop.ts` 移植到生产运行时插件。诊断 FAIL 可创建 `repair/evidence` 并调用 `RepairController`。诊断 PASS + 保留 PASS 完成任务。诊断 PASS + 保留 FAIL 为终局资格失败：不调用 `RepairController`，零后续提供者调用，保留结果永不成为模型可见证据。回归测试：保留失败后 `providerCallsBeforeHoldout === providerCallsAfterHoldout`，且该转换的 `repair/evidence`、`repair/decision`、`model/escalation` 事件为零。

**步骤 7：规范用量计费。** 每个逻辑尝试必须引用真实 `model/usage` 事件。聚合 `cacheReadTokens`、`cacheMissTokens`、`outputTokens`、时间戳、提供者/模型和定价版本。修复成本仅从规范用量派生。不变量：总尝试 = Flash + Pro；任务成本 = 用量事件成本之和；每笔付费用量恰好属于一个逻辑尝试。跨重放保留。

**步骤 8：预算可达性与权威排序。** 步骤 7 向现有 `RepairBudget` 提供真实 `totalCostUsd`/`elapsedMs`，使现有 `decideRepair` 预算检查可达。然后测试权威/模型可用性与现有硬预算门的交互。决策排序：已验证 → 硬任务级禁止 → 预算耗尽 → 尝试上限耗尽 → 确定候选动作 → 权威 + 模型可用性门控。手动权威控制哪个模型/动作可允许；预算控制是否允许任何进一步付费执行。手动 Pro 选择不使 `maxTaskCostUsd` 无关；`cost-limit` 优先于另一尝试，无论模型权威。

**步骤 9：模型权威规则。** 区分 `initialModel`、`flashModel`、`proModel`、`currentModel` 和手动/持久选择来源。不通过将尝试与 `currentModel` 比较来推断 Pro。从路由器的 `ModelSelectionAuthority` 接线 `manualModelSelection` 和 `proModelAvailable`。测试手动 Flash、手动 Pro、自动 Flash→Pro 升级、缺少 Pro 路由、提供者不可用和持久状态重放。手动 Flash 任务不得静默跳转到 Pro，除非策略明确允许。

**步骤 10：失败证据不可变与净化。** 一旦持久化，`FailurePackage` 永不修改；每个失败尝试获得新包。Pro 接收最新失败包，先前包单独引用。在证据成为模型可见之前添加净化：移除 API 密钥、Bearer 令牌、密码、数据库 URL、凭据、宿主绝对路径、内部 ID 和保留材料。保留完整持久证据记录和较小的净化模型可见投影。

**步骤 11：工作区来源。** 记录新增、修改和删除文件以及工作区根哈希前后值。不仅依赖编辑器工具调用；Bash 和脚本可在不出现于该列表的情况下修改文件。如支持回滚，恢复真实检查点并在继续前验证恢复的工作区哈希。

**步骤 12：回滚为运行时动作。** `ROLLBACK_AND_REDO` 意味着 Harness 自身恢复检查点。发出 `repair/rollback`，包含源/目标工作区哈希。仅在恢复成功后才运行下一个模型。不从模型输出推断回滚。

**步骤 13：事件语义。** 将事件分类为仅可观测与重建关键。`repair/evidence`、`repair/decision`、`model/escalation` 和 `repair/completed` 为重建关键，不得广泛可忽略。定义 `repair/rollback` 语义。在模式稳定后重新生成 `known-event-types.ts` 和持久化/目录衍生物。

**步骤 14：事件排序不变量。** 强制 `goal/verification` FAIL < `repair/evidence` < `repair/decision`。对于 Pro 接管，要求 `repair/decision` < 真实 `model/routing-decision` < `model/request`。`model/escalation.toRoutingDecisionId` 必须匹配真实 `model/routing-decision` 事件。检测缺失事件、重复决策、重复升级和模型层级不匹配。

**步骤 15：副作用边界的幂等性。** 证据后、决策后、升级后、请求/用量后、验证后崩溃 — 重启时恰好继续一次。关键测试：持久化的 Pro 升级加进程重启导致恰好一次 Pro 提供者调用（不是一个 `model/escalation` 事件，一次实际提供者调用）。

### P2 — 沙箱、验证加固、夹具、资格、冻结

步骤 16–24 涵盖沙箱资格语义（PASS/FAIL/SKIP 区分）、扩展对抗测试、验证反作弊、夹具冻结、持久资格持久化、预检门、五夹具实时资格、v0.18 冻结与清单重新生成，以及发布后真实仓库评估。这些在 P0 和 P1 落地后界定范围。

## 考虑的替代方案

- **重新实现控制器。** 控制器的决策逻辑、进度分类和确定性 ID 派生已正确且已测试。重新实现它们会重复工作、引入回归风险，并掩盖真实缺陷位置：运行时边界。已拒绝。

- **为旧 `repairId` 格式添加兼容垫片。** AGENTS.md 中的预发布立场允许自由重命名和重新打包，无外部消费者。后端拒绝旧磁盘格式。垫片将为没有消费者保留一个损坏的身份方案。已拒绝。

- **在重建关键事件上保留 `ignorable: true`。** 这使重放依赖于构建对缺失事件的容忍度，而该容忍度因消费者而异。重建关键事件必须在读取时必需，除非因结构格式原因携带 `ignorable: true`。当前广泛的 `ignorable: true` 是缺陷，非设计选择。已拒绝。

- **将 `escalationId` 与路由决策身份分离。** 升级是路由转换；其身份是目标路由决策。单独的 ID 创建一个没有事件产生的连接，重放无法重建。已拒绝，改为引用真实 `toRoutingDecisionId`。

- **让手动权威绕过硬预算。** 手动权威控制模型可允许性，而非付费执行是否可允许。超过成本上限的任务无论用户选择了哪个模型都停止。已拒绝。

## 验收标准

### P0

- `repair/decision = pro-escalate` 产生真实 Pro `model/request`，其 `routingDecisionId` 匹配 `model/escalation.toRoutingDecisionId`。
- `repair/decision = flash-repair` 产生真实 Flash `model/request`。
- `goal/verification` PASS 且存在活跃修复时发出 `repair/completed` 并清除内存状态。
- `reconstructRepairState` 不根据后续决策修改尝试模型层级。
- `repairId` 确定性：相同会话、目标、修订和源路由决策在重启后产生相同 ID。
- `reconstructRepairState` 重建完整 `FailurePackage` 对象，而非仅指纹。
- 重启后 Flash #3 决策与未中断执行的决策一致（相同失败序列）。
- 手动模型选择受尊重：手动 Flash 不静默升级到 Pro，除非策略明确允许。

### P1

- 保留失败产生零后续提供者调用和零 `repair/evidence`/`repair/decision`/`model/escalation` 事件。
- `state.totalCostUsd` 反映真实 `model/usage` 成本；`cost-limit` 停止原因可达且已测试。
- `decideRepair` 排序将预算置于候选动作确定之前，权威门控在其之后。
- 模型可见证据已净化；持久证据保留完整内容。
- 重建关键修复事件不广泛可忽略。
- `model/escalation.toRoutingDecisionId` 匹配真实 `model/routing-decision` 事件。
- 持久化 Pro 升级 + 重启 = 恰好一次 Pro 提供者调用。

### P2

- 沙箱资格区分 PASS、FAIL 和 SKIP；跳过的强制测试不产生合格后端。
- 五夹具实时资格通过，零提供者错误、零循环违规、零事件排序违规、零重复逻辑执行、零保留泄漏、零沙箱违规、零计费违规、零未定价用量和完整轨迹。
- v0.18 仅在资格通过后冻结；`FULL_FILE_MANIFEST.sha256` 从最终源树重新生成。

## 风险

- **路由权威集成改变 agent loop 的请求路径。** 按 AGENTS.md，更改 `agent-loop` 需更新 `docs/architecture.md`。修复运行时挂载 `session/event`，不直接挂载 `agent-loop`，但通过路由权威绑定修复决策可能需要新扩展点而非直接 `agent.followup()` 调用。

- **事件模式更改提升 `SESSION_FORMAT_VERSION`。** 添加 `repair/rollback`、更改 `ignorable` 语义或使重建关键事件在读取时必需可能需要格式版本提升。TypeScript 和 Python SDK 预期输出必须在同一 PR 中更新。

- **确定性 `repairId` 改变磁盘身份。** 现有会话日志中的时间戳派生 `repairId` 值将不匹配重建 ID。预发布立场允许此情况：后端拒绝旧磁盘格式。任何进行中的修复会话必须在升级前完成。

- **保留分离需要验证器配合。** 运行时插件需要知道 `goal/verification` 检查是诊断还是保留。如果验证器未用此区分标记检查，运行时无法在没有新验证协议字段的情况下分离它们。
