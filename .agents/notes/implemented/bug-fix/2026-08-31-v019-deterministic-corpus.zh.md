# Agent Note: 确定性语料库生成和冻结依赖

Status: implemented

[English](2026-08-31-v019-deterministic-corpus.md) | 中文

## 问题

合成语料库生成器每次运行产生不同的 Git 提交哈希，因为提交元数据（作者、提交者、时间戳）依赖于机器 Git 配置和墙上时钟时间。依赖版本使用浮动范围（`^5.4.0`、`^2.0.0`）且无锁文件，因此同一提交随时间可能安装不同的依赖图。

## 决策

**Git 身份：** 固定 `GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、`GIT_COMMITTER_NAME`、`GIT_COMMITTER_EMAIL` 为 `DSH Benchmark` / `benchmark@local.invalid`。设置仓库本地 `git config user.name` 和 `user.email`，使生成器零依赖于机器 Git 配置。

**Git 时间戳：** 每个仓库基于其序号（0–6）从 `GIT_BASE_EPOCH=1735689600`（2025-01-01T00:00:00Z）开始获得确定性纪元。基线提交使用 `base_ts = epoch + ordinal * 3600`。修复提交使用 `fix_ts = base_ts + 60`。

**依赖固定：** 所有合成仓库现在使用精确版本（`typescript: "5.4.5"`、`vitest: "2.1.9"`）而非浮动范围。`npm install` 在 `init_repo` 期间运行以生成 `package-lock.json`，该文件提交到基线提交中。`make_fix_commit` 在 `package.json` 变更时重新生成锁文件。

**安装命令：** `detectInstallCommand` 现在在 `package-lock.json` 存在时返回 `npm ci`，而非回退到 `npm install`。

**锁哈希：** 生成器生成机器可读 JSON 收据，包含每个仓库的 `baseCommit`、`referenceFixCommit` 和 `lockHash`（`package-lock.json` 的 SHA-256）。`TaskManifest.repository` 接口现在包含 `dependencyLockHash`，它是 `taskManifestHash` 的一部分，因此也是 `corpusManifestHash` 和 `experimentManifestHash` 的一部分。

**语料库版本：** 从 v3 升级到 v4（`v019-synthetic-multirepo-v4`、`v019-synthetic-multirepo-validation-v4`）。

**确定性测试：** `scripts/v019-corpus-determinism.spec.ts` 将生成器运行两次到隔离目录中，并断言所有提交哈希和锁哈希逐字节匹配。

## 验证

类型检查通过。评估测试（31）和 repair-runtime 测试（149）通过。语料库确定性测试通过——两次独立运行对所有 7 个仓库产生相同的提交哈希和锁哈希。

## 考虑过的替代方案

- **仅内容寻址提交** — 否决：Git 提交哈希包含作者/提交者/时间戳元数据，因此冻结该元数据是可重现性所必需的。
- **仅锁文件不固定** — 否决：使用锁文件但浮动 `package.json` 范围的 `npm install` 在锁文件重新生成时仍可能漂移。在 `package.json` 中固定精确版本加提交锁文件是标准的冻结依赖方法。

## 后果

v4 语料库与 v3 轨迹不兼容。之前的 v3 探索性结果作为探索性证据仍然有效，但无法与 v4 结果比较。`dependencyLockHash` 字段更改 `taskManifestHash`，因此从 v4 任务派生的所有实验身份与 v3 不同。
