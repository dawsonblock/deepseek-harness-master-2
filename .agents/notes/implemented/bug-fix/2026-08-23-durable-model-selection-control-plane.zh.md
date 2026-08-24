# Agent Note: Durable model-selection control plane correctness

Status: implemented

[English](2026-08-23-durable-model-selection-control-plane.md) | 中文

## 问题

v0.15.4 引入了 `ModelSelectionState` 作为会话模型选择权的持久化权威（手动 vs 自动、哪个授权方、哪条路由）。设计本身正确，但系统之间的三个接缝是坏的：

1. **授权事件被标记为 ignorable。** `model/selection-authority` 追加时带了 `{ ignorable: true }`，与会话日志契约（`dsh-session/types.ts`）矛盾：`ignorable: true` 意为"纯信息性，不影响重建"，旧读取方可以跳过该事件。但 `model/selection-authority` 就是重建本身——它决定手动还是自动、谁拥有选择、哪个手动模型生效。不认识该类型的旧运行时会静默丢弃手动 Pro 选择，并将会话重建为该选择从未发生。

2. **Auto 在重启后可以复活过期模型。** Host 解析器（`api-proxy.ts` 的 `selectionFor`）尊重持久化手动状态但忽略持久化自动状态，回退到请求头。在手动外部选择 → 请求 → Auto → 重启后，持久化状态说是自动，但请求头仍携带外部路由，于是过期的外部模型回来了。

3. **模型选择在存储层不是崩溃持久化的。** `selectModel` 追加授权事件后未刷新持久化就返回 RPC 成功。在写缓冲（`DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`）下，该窗口内的 SIGKILL 会从磁盘丢失选择。RPC 响应不是提交边界。

## 决策

**P0-1：`model/selection-authority` 是必需事件。** 从 `dsh-agent/authority.ts` 的追加中移除了 `{ ignorable: true }`。持久化读取路径（`session-persistence/coordinator.ts` 的 `assertEventsSupported`）已经拒绝包含未知非 ignorable 事件类型的日志，因此不认识 `model/selection-authority` 的旧运行时现在会拒绝会话，而非静默丢弃选择。一个静态门控（`verify-model-state-events-not-ignorable`）机械地防止未来回归。

`model/routing-decision` 保持 ignorable。它携带路由优化连续性（上次选了哪个模型），而非所有权。丢失一个只会让路由器在下一轮重新开始；它不会覆盖用户所有权。所有权保护完全来自 `model/selection-authority`。`reconstructRoutingState` 先调用 `reconstructSelectionState`，在手动授权状态存在时立即返回——routing-decision 事件仅在旧兼容（v0.15.3 前会话）或自动模式下的当前策略路由连续性时才被扫描。

**P0-2：持久化 Auto 是权威的。** Host 解析器现在将持久化 `ModelSelectionState` 视为唯一权威源（一旦任何支持的状态事件存在）。手动 → 精确持久化选择。自动 → 部署默认值（路由器中间件在其上覆盖）。不可判定（未来 schema 或畸形）→ 硬错误（fail closed）。请求头仅在不存在 `model/selection-authority` 事件时作为旧兼容回退。一旦任何支持的状态存在，请求头不再是权威源——消除了过期模型复活。

**P0-3：RPC 响应是提交边界，flush 失败隔离会话。** `selectModel` 现在在返回成功前调用 `ctx.sessions.flush(session)`，使授权事件在调用方被告知成功之前到达持久化存储。如果 flush 失败，RPC 返回 `session-persistence-failed` 错误并隔离会话：api-proxy 闭包中的 `persistenceFailed` 集合跟踪持久化屏障失败的会话，`agentFor` 守卫拒绝对其的所有后续操作。内存会话保留该事件——事件已在日志中，拆卸 flush 可能仍会持久化它——但调用方知道选择未持久化提交，且不会有后续执行在调用方被告知未提交的模型选择下进行。恢复是进程重启：下次冷恢复从持久化存储读取，事件要么存在（选择是真实的），要么不存在（应用变更前状态）。隔离不是事务性回滚；它是一个 fail-closed 条件，防止脑裂窗口导致不安全执行。

## 测试

- `authority.spec.ts`：回归测试断言 `claimModelSelection`/`releaseToAuto` 追加的 `model/selection-authority` 事件从不携带 `ignorable: true`，证明使旧运行时拒绝日志的契约。
- `coordinator-contract.ts`：持久化兼容性测试追加真实的 `model/selection-authority` 事件（不带 `ignorable`），持久化、重载，并验证加载的事件没有 `ignorable` 字段——证明磁盘上的形状是 `assertEventsSupported` 在旧运行时上拒绝的必需事件形状。
- `api-proxy-models.spec.ts`：两个重启模拟测试证明持久化 Auto 在过期外部请求头下存活（外部模型透传），并在无路由器插件时解析到部署默认值。一个 flush 失败测试证明 `selectModel` 返回 `session-persistence-failed` 错误并隔离会话（后续操作被拒绝）。一个执行阻断测试证明被隔离的会话无法 `prompt`——守卫在任何 `agent/request` 或 `llm/request` 触发前拒绝。一个拆卸存活测试证明隔离不会被 agent teardown/HMR 清除。
- `rpc-schemas.spec.ts`：schema 测试证明 Zod 判别联合接受带 `{ sessionId }` 详情的 `session-persistence-failed`，并在详情缺失时拒绝。
- `model-router.spec.ts`：完整请求瀑布测试证明手动 ForeignModel → request/header → Auto → 路由器重启 → 过期外部路由永远不会到达 `llm/request`；路由器选择快速路由，外部模型永远不会出现在任何 LLM 请求中。
- `jsonl.spec.ts` 和 `sqlite.spec.ts`：针对两个官方持久化后端的真实双进程持久化测试。每个夹具进程挂载后端、执行模型选择变更、刷新、打印成功标记，然后在标记后立即被 SIGKILL——无任意成功后睡眠。第二个进程挂载同一存储位置并从磁盘验证持久状态。覆盖手动选择、Auto 释放、手动重选、外部路由复活，以及刷新失败后 SIGKILL 再重载（重载状态是有效的完整状态，旧或新，永不畸形）。JSONL：5/5 场景通过。SQLite：5/5 场景通过。合计：10/10。
- `verify-model-state-events-not-ignorable`：扫描 1,254 个源文件的静态门控，已验证能捕获原始缺陷并在修复后通过。

## 考虑过的替代方案

**也将 `model/routing-decision` 设为必需。** 拒绝：它携带路由优化连续性，而非所有权。`reconstructRoutingState` 先调用 `reconstructSelectionState`，在手动状态下立即返回；routing-decision 事件仅在自动模式下（当前策略路由连续性）或旧会话时才有贡献。将每个路由决策设为必需会话格式事件意味着旧运行时仅因不认识较新的路由器遥测就无法打开会话——使设计倒退。所有权完全来自 `model/selection-authority`。

**通用的"重建关键事件不可 ignorable"门控。** 拒绝：试图推断某个 `reconstruct*` 函数是否读取某事件类型的门控是脆弱的。门控使用语义状态事件类型的显式允许集（今天只有 `model/selection-authority`），重命名为 `verify-model-state-events-not-ignorable` 以保持集合诚实。长期解决方案是事件元数据（`semantics: 'state' | 'modelVisible' | 'telemetry' | 'observation'`），使规则无需硬编码集合即可强制执行。

**flush 失败时事务性回滚。** 拒绝：事件在追加后已在内存日志中；`flush()` 不提供事务性回滚。响应契约（RPC 失败 → 调用方知道选择未持久化）是正确的边界。内存会话保留事件供拆卸 flush——一个有文档的脑裂窗口，而非静默不一致。

## 后果

模型选择状态在重启间权威、持久化和 fail-closed。不认识 `model/selection-authority` 事件的旧运行时会拒绝会话，而非静默丢弃用户授权。持久化 Auto 覆盖过期请求头。成功的 `selectModel` RPC 响应意味着选择在立即进程死亡后存活。失败的持久化屏障隔离会话——不会有后续执行在调用方被告知未提交的选择下进行。

flush 屏障为每次 `selectModel` 调用增加一次等待的持久化排空。写缓冲仍适用于非选择事件；只有模型选择变更支付同步屏障成本，这对于低频用户操作是可接受的。

隔离是进程范围的 fail-closed 条件，而非事务性回滚。内存会话保留已追加的事件，但会话在进程重启前不可用。未来的 v0.16 如果该窗口在运维中代价高昂，可以引入具有更强提交语义的存储原语。

P0 实现已代码完成并通过发布资格。目标行为测试、RPC schema 测试、隔离执行阻断和拆卸存活测试、静态门控、翻译对验证，以及真实双进程 SIGKILL 持久化测试（JSONL 和 SQLite，10/10 场景）均通过。完整 TypeScript 构建产生零错误。快照刷新通过 128/128；快照重放通过 124/128，其中 4 个预存非确定性失败（并行 `tool/settled` 事件排序和 `durationMs` 计时差异）与这些变更无关。
