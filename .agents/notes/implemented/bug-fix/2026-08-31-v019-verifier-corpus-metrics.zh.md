# Agent Note: 验证器不可变性、语料库腐烂和指标分解

Status: implemented

[English](2026-08-31-v019-verifier-corpus-metrics.md) | 中文

## 问题

对探索性 Batch A 运行的 6 个模型侧失败进行取证检查，揭示了三个不同的根因：

1. **验证器不可变性误拒（6 个失败中的 4 个）：** `hashVerifierControlledFiles` 对基线时不存在的测试文件记录 `:absent`。多文件特性任务要求模型创建新测试文件（如 `tests/Stack.test.ts`），因此执行后的哈希发现新文件并与基线哈希不同，在诊断验证器运行之前就触发了"验证器控制的文件被模型修改"。这导致每个多文件特性任务无论模型输出质量如何都被拒绝。

2. **快照污染（1 个失败）：** `.tmp/node-compile-cache/` 中的 Node.js 编译缓存文件被包含在工作区哈希和变更文件列表中，用数百个无关缓存文件污染了 slugify 任务的轨迹。

3. **语料库腐烂（3 个基础设施失败）：** ts-http 仓库的基线提交固定了 `typescript@5.0.0`，该版本在 npm 注册表中已不存在。`npm install` 在设置期间失败，因此没有模型被评估。`batch-a-ts-http-deps-001` 任务要求模型修复此问题，但设置本身在模型运行之前就失败了。

## 决策

**验证器不可变性：** 通过遍历测试目录发现的测试文件仅在基线时存在时才被哈希。配置文件（`package.json`、`tsconfig.json` 等）和测试设置文件（`tests/setup.ts`、`conftest.py`）仍然记录 `:absent`，因为模型创建这些文件是可疑的。模型创建的新测试文件被允许；诊断验证器仍然运行实际测试，因此不测试正确内容的新测试文件将无法通过验证。

**快照污染：** 将 `.tmp` 添加到 `SNAPSHOT_EXCLUDED_DIRS` 并将排除集版本从 `v1` 升级到 `v2`。`getChangedFiles` 回退也排除 `.tmp`。

**语料库腐烂：** 更新 ts-http 基线提交以使用 `typescript: "^5.4.0"`（有效），并将 `vitest` 放在 `dependencies` 中（模型可以修复而不破坏 `npm install` 的真实问题）。将语料库版本从 `v019-synthetic-multirepo-v2` 升级到 `v019-synthetic-multirepo-v3`，实验 ID 从 `v019-synthetic-multirepo-validation-v2` 升级到 `v019-synthetic-multirepo-validation-v3`。

**指标分解：** 向 `MetricsReport` 添加了 `latencyByAttemptType`（一次性 Flash、Flash 修复、Pro 初始、Pro 救援、失败）、`costByOutcome`（验证一次性、验证救援、最终失败）和 `cacheSemantics`（总计数和每任务缓存读取/未命中令牌）以实现跨运行可比性。

## 验证

类型检查通过。评估测试（31）和 repair-runtime 测试（149）通过。22 个已评估 Batch A 轨迹现在一致：22 Flash + 6 Pro = 28 总 attempts。

## 考虑过的替代方案

- **阻止所有新测试文件** — 否决：多文件特性任务明确要求创建新测试文件。诊断验证器是测试质量的正确门控，不是文件存在性。
- **移除 ts-http-deps 任务** — 否决：用户指定重新运行所有 25 个任务而非静默替换三个。任务已更新为修复依赖分类而非版本冲突。

## 后果

语料库身份变更（v2 → v3）需要重新鉴定和完整重跑。快照排除变更（v1 → v2）需要重新鉴定组合运行时。之前的 v2 轨迹作为探索性证据仍然有效，但与 v3 结果不可比较。
