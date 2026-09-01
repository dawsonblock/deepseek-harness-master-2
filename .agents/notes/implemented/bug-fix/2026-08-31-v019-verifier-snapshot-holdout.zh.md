# Agent Note: 冻结 VerifierSnapshot 和 holdout 内容绑定

Status: implemented

[English](2026-08-31-v019-verifier-snapshot-holdout.md) | 中文

## 问题

验证器控制文件哈希在基线和验证时都使用动态发现。当模型创建新测试文件时（如多文件功能任务所要求），第二次发现会包含该文件，导致哈希不匹配和错误拒绝。此外，隐藏 holdout 文件未按内容绑定到任务身份——只知道 holdout 命令，不知道 holdout 字节。

## 决策

**VerifierSnapshot：** 用 `freezeVerifierSnapshot` 和 `verifyAgainstSnapshot` 替换了 `hashVerifierControlledFiles`。路径集在基线时发现一次，去重、排序并冻结。验证时只哈希这些路径——无动态重新发现。模型创建不在基线路径集中的新测试文件不会导致不匹配。模型修改或删除现有受控文件会触发不匹配。

**mustRemainAbsent：** `VerifierSnapshot` 接口包含 `mustRemainAbsent: readonly string[]`，用于验证时必须不存在的路径。

**Holdout 内容绑定：** 添加了 `VerifierArtifact` 接口，包含 `logicalName` 和 `sha256`。`TaskManifest.verification` 块现在包含 `holdoutArtifacts: readonly VerifierArtifact[]`。每个 holdout 文件的 SHA-256 在语料库冻结时计算，并包含在 `taskManifestHash` 中，因此在 `corpusManifestHash` 和 `experimentManifestHash` 中。`verifyHoldoutIntegrity` 函数在评估启动时检查当前 holdout 文件字节与清单哈希是否匹配。

**哈希排序：** 受控路径集在 `freezeVerifierSnapshot` 和 `verifyAgainstSnapshot` 中都先去重和排序再哈希，确保相同路径顺序产生相同哈希。

## 验证

`scripts/v019-verifier-snapshot.spec.ts` 中的六个回归测试：
- PASS：模型创建新测试文件而不修改现有测试。
- DENY：模型修改现有测试文件。
- DENY：模型修改 package.json。
- DENY：模型删除现有测试文件。
- PASS：相同工作空间的快照是确定性的。
- PASS：模型在 src/ 中创建文件而不触碰验证器控制文件。

全部 186 个评估和 repair-runtime 测试通过。

## 考虑过的替代方案

- **仅哈希现有文件，完全跳过缺失文件** — 否决：`package-lock.json` 等配置文件在模型创建时需要被检测到，因此缺失的配置文件以 `:absent` 哈希。
- **任务感知验证器策略与 glob 模式** — 推迟：冻结路径集已解决多文件 bug。任务感知策略可在此之上后续叠加。
