# DSH Host Capability 实现边界

> Change: `add-dsh-host-capability-foundation`。本文档记录本 change 全部后续任务（Task 1-13）的只读边界、路径规则和双发行版测试基线的获取约束。后续任务在偏离本文档时必须先更新本文档。

## 1. 仓库与工作区边界

| 仓库 | 路径 | 角色 | 允许的操作 |
| --- | --- | --- | --- |
| AIO Hub（主仓） | `E:\workspace\projects\aio-hub` | 宿主应用 | **只读**（Host Gate / 回归脚本除外，且仅 Task 13 涉及）。严禁推送到 `origin`（miaotouy/aio-hub）；只允许 aobo-validation 远端 |
| AIO Hub 链接 worktree | `E:\workspace\projects\aio-hub\.worktrees\aiohub-plugin-dsh-host-capability-foundation` | 插件仓的链接 worktree，本 change 的唯一工作根 | 所有代码改动在此提交，分支 `codex/add-dsh-host-capability-foundation`，基准 `14c7648` |
| 插件仓（主 checkout） | `E:\workspace\projects\aiohub-plugin-dsh-workspace` | 插件仓主工作区（dev 分支） | **只读**。本 change 不在主 checkout 提交任何内容 |
| DSH 源码（deepseek-harness） | 本机各 audit/build checkout | 上游源码参考 | **只读**，且禁止把其本机绝对路径写入任何产物（代码、lock、生成物、报告） |

规则：

- 所有命令在链接 worktree 根下运行。
- 后续任务读取的上游事实（tag、commit、wheel SHA-256）必须来自 lock 与本文件第 3 节，不得在运行时访问本机 DSH checkout 或用绝对路径引用它们。
- 产物（ZIP、SBOM、报告）中不得出现 `E:\workspace\...` 一类本机绝对路径。

## 2. 双发行版测试基线

`runtime-lock/dsh-runtime.json` 是 `schemaVersion: 1` 的 release catalog（`releases[]`），为后续 Adapter 任务提供两个不可变 fixture：

| 基线 | tag | commit | wheel 身份 |
| --- | --- | --- | --- |
| v0.1.2-rc.1（runtime-core 验收固定） | `dsh-v0.1.2-rc.1` | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` | PyPI `deepseek_harness_runtime_bin-0.1.2rc1-py3-none-win_amd64.whl`，SHA-256 `390bd8cd5f8700fc609c58e1ccb78091d5c8c6e11c21656e284e0f68da0e148f` |
| v0.1.3-alpha.2（host-capability 基线） | `dsh-v0.1.3-alpha.2` | `82a5fd61a7cf5c293cec4bdff68f455398d685e9` | `acquisition-pending`（见第 4 节） |

约束：

- production 解析（`loadRuntimeLock` / `resolveRuntime` / `acquireOfficialWheel`）始终解析 `releases[0]`（0.1.2-rc.1）；`releases[1]` 只是测试 fixture，**不得**被打入正式插件 ZIP。
- 两条 entry 的 tag/commit/wheel hash/license/SBOM/platform 结构都是不可变的；修正身份必须走新的 lock 变更，不得就地改写已固化的值。
- 选择器 `selectRuntimeByEvidence` 只接受 capability/schema evidence（`schemaVersion: 1` + capability tokens，如 `"dsh"` 基础能力或精确 tag）。禁止任何 `startsWith("0.1.3")` 一类版本前缀猜测；selector 输入中出现版本前缀时必须返回 `undefined`。

## 3. v0.1.3-alpha.2 wheel 获取现状

- PyPI `deepseek-harness-runtime-bin` 当前最新为 `0.1.2rc1`；发行版列表为 `0.0.0.dev0 / 0.1.0rc6 / 0.1.0rc7 / 0.1.1rc1 / 0.1.2a3 / 0.1.2rc1`，**不存在 `0.1.3a2`**。
- GitHub release `dsh-v0.1.3-alpha.2`（2026-09-07 发布）没有附带任何二进制 assets。
- 因此 lock 中该 entry 以 `officialWheel.status = "acquisition-pending"`、占位全零 SHA-256、win32 `artifactState = not-built (wheel-acquisition-pending)` 落地。占位 hash 不是有效身份，任何脚本都不得把它当作可验证的 wheel hash 使用。
- 待上游发布 `0.1.3a2` wheel 后，后续任务应把该 entry 更新为真实 PyPI URL 与 SHA-256 并翻转状态；这一步必须走 lock 变更并保持 rc.1 entry 不动。

## 4. 禁止事项

- 禁止把两套 runtime 同时打入正式插件 ZIP（`package:platform` 只消费 `releases[0]`）。
- 禁止在解析器、打包器、release verifier、Supervisor 中写入 DSH 版本常量或按版本名推断 capability。
- 禁止在产物中包含本机 DSH checkout 路径或任何本机绝对路径。
- 禁止修改 `releases[0]`（0.1.2-rc.1）已验收固化的身份字段。
