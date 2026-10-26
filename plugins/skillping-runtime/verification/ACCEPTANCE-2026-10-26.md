# 2026-10-26 完整验收

结论：**本地与隔离安装验收通过**。最初冻结的 `d55802f8ebdd4319a4a746c88332b90f26c9ba98` 存在发布产物无法逐字节复现的问题，已修复。最终候选为 `463e7c7a7d939bc2bb4970568d131ab03269a69f`。在线模型效果、真实宿主 Hook 事件等外部边界仍未验证，具体范围见下表。

环境为 Windows、Node `v24.18.0`。在独立 Git worktree 中重新安装依赖，所有记录、清空操作、配置和 Key 均使用新建夹具数据。没有读取真实历史记录、调用付费模型、修改全局 Codex 配置或推送发布。

## 本次发现与修复

Windows 的默认文本检出规则使七个源文件变成 CRLF，构建脚本按原始字节复制这些文件；已提交的发布版 `SOURCE.md` 又保留了另一种换行。干净检出重建后，八个发布载荷文件及 receipt 与提交内容不同，bundle 本身相同。原始差异保存在 `.scratch/acceptance-2026-10-26/artifacts/artifact-comparison.json` 和 `.scratch/acceptance-2026-10-26/artifacts/rebuild-before.patch`。

修复提交 `8c64b54f6f9d17abf21fc83f8b459ee1131a2244` 将默认文本检出设为 LF，保留 PowerShell 的 CRLF 与 `distribution/** -text`，并统一发布版 `SOURCE.md` 及其 receipt SHA。只修改三个文件。独立工位上的原修复提交 `13c4bc280ab24ad8e26e32bbebb912ac2f11edcd` 与该提交的 Git tree 均为 `17a559bb25b72680ff3c0ce051da69148d04c832`。

验收同时发现日常入口缺少对五种反馈控制的直接回归。提交 `463e7c7a7d939bc2bb4970568d131ab03269a69f` 复用已有 engine/SQLite 夹具，增加一组行为检查与一个指定源码错误。它覆盖 30 组无效引用拒绝、冷却保留、明确拒绝优先，以及失效后取消推荐但保留证据。产品 TypeScript 源码与依赖锁相对最初冻结提交没有变化。

## 功能与证据

以下路径均从仓库根目录计算；`.scratch` 和 `.work` 是本次保留的本地原始证据，不随 Git 提交。测试、模型状态数和 MCP 调用数代表不同层面的覆盖，不能相加作为功能数量。

| 范围 | 结果 | 实际验证与证据 |
| --- | --- | --- |
| 默认日常入口 | PASS | 干净依赖安装后执行 `rtk npm test`：143/143，失败、跳过均为 0；四个验证器全部通过，共捕获 20 个成功编译的指定源码错误。日志：`.scratch/acceptance-2026-10-26/final-test.log`。 |
| Windows 配置原子写入 | PASS | 原生独立进程共享拒绝、瞬时/永久错误及恢复通过；移除重试的编译副本失败，前后干净副本通过。原独立进程更新场景另重复 50 次，50/50 通过；该场景所测配置源码与最终候选相同。 |
| 清空数据 | PASS | 同 session 二次确认、错误/替换/过期/重放 token、部分删除失败、原生协调锁和晚到结果通过；六组真实代码场景前后通过。TLC 前后干净模型各穷尽 20,639 个不同状态；四个源码错误均编译后被指定断言捕获。 |
| 提取、复核与证据展开 | PASS，受控答案 | 当前 v6 提取、v3 复核、渐进证据读取、重复提交、退役协议拒绝、超时与晚到结果检查通过。发布 bundle 的正常流程通过公开 MCP 工具创建工作与推荐，没有通过数据库写入制造正常流程结果。 |
| 可选在线决策适配 | PASS，夹具范围 | 禁用/缺 Key 不发送请求，Key 重载、概率及响应约束、请求/响应体限制、超时、取消、隐私拦截和宿主回退通过。网络响应由夹具注入；付费提供商可用性与真实判断质量未验证。 |
| 计数、档位和 scope | PASS | 三档的 episode/task 双门槛、198 个有限阈值组合、30 天边界、重复提交、项目/全局范围和开关恢复通过。计数验证器前后各 11 组通过，八个指定源码错误全部被捕获。 |
| 推荐完成和沉默规则 | PASS，受控搜索回执 | 完成数量、零结果、重复/相反回执、领取竞争、过期、重试、冷却及 baseline silence 通过。八组真实代码场景前后通过；有界模型穷尽 4,064 状态、21,664 转移；七个源码错误被捕获。真实外部 Skill 搜索质量和应用效果未验证。 |
| 帮助、首次介绍和偏好 | PASS | 已安装缓存经实际 MCP 验证三档、两个开关及重启持久化；额外四次调用确认帮助不消耗首次介绍，介绍只返回一次且重启后不再返回。见 `.scratch/acceptance-2026-10-26/mcp/onboarding-T83kGk/report.json`。 |
| 五种反馈控制 | PASS | 冷却、永久拒绝、失效、已有 Skill 覆盖及重开均经公开工具验证；缺失、不存在、跨 task 和歧义引用不改动记录，重开保留冷却，明确拒绝优先。新增日常回归及 `M_REOPEN_DROPS_COOLDOWN → COUNT_FEEDBACK` 同时通过。 |
| 保留与存储 | PASS，实际存储约定 | 时间窗口和逻辑过期规则通过，物理清理失败也不能使过期证据重新符合条件。当前接受的提示和摘要、连接 Key 均为本地明文；没有活动的加密存储保证，`key.dpapi` 仅作为旧文件清除。 |
| 内部历史导入 | PASS，合成子进程 | 实际 engine、JSONL 客户端、存储及锁通过四组补充重放：未确认不启动、分页/截止/显式 Skill 排除与去重、失败后新 engine 恢复游标、另一进程清空时终止旧代工作且不复活记录。当前发布 Skill 不向用户提供历史导入，也没有 `cancel_import` 命令。见 `.scratch/acceptance-2026-10-26/source/history-run-oZUaiP/report.json`。 |
| 安装、产物和依赖 | PASS，本地安装范围 | 安装检查 14/14；真实 Codex CLI 在隔离 `CODEX_HOME` 中执行六条命令，安装两个 0.1.2 插件并解析 MCP 配置。43 项发布清单、含 receipt 的 26 文件、八个 bundled 依赖 notices 均匹配；18 个安装缓存文件逐字节匹配最终 distribution。两种依赖审计的已知告警均为 0。 |

清空、推荐和计数验证只覆盖各 README 中记录的有限边界与真实代码场景，不构成整个 TypeScript 实现的形式化证明。20 个指定源码错误是故意写入隔离副本的敏感性检查，它们均成功编译并被捕获，不是本次产品缺陷数量。

## 最终候选与重放

全量测试实际运行于独立工位提交 `a3b2a0dfad26819baa1f615dc5623a64c64301ae`，它与最终候选的 Git tree 完全相同：`bc5c7d620212193f303783e3f2fc505f8b184ccd`。两者差异仅为本地 cherry-pick 的提交身份。之后将该工位切至最终候选，重新构建 marketplace、执行 bundle smoke，并确认 `git diff --exit-code -- distribution` 返回 0。

最终四个验证器报告位于 `.scratch/lanes/acceptance-final/plugins/skillping-runtime/verification/`：

- `config-write/.work/red-green-Cbk7jO/report.json`。
- `clear-data/.work/run-mgeSFS/report.json`。
- `recommendation/.work/run-Rx1Dfh/report.json`。
- `counting/.work/run-JWSnME/report.json`。

四份报告均为 pass，且检查结束后产品源文件不变。50 次独立进程更新的原始报告为 `.scratch/lanes/acceptance-full/plugins/skillping-runtime/verification/config-write/.work/2026-10-26T11-22-15.470Z/report.json`。

从 `plugins/skillping-runtime` 可重放日常入口与构建：

~~~powershell
rtk npm ci --ignore-scripts
rtk npm test
rtk npm run build:marketplace
rtk proxy node scripts/smoke-runtime.mjs
rtk proxy npm audit --json
rtk proxy npm audit --omit=dev --json
~~~

父任务独立重放了同一冻结 MCP 驱动。发布目录和真实安装缓存分别通过四条完整流程、168 次公开调用，报告为 `.scratch/acceptance-2026-10-26/mcp/run-sZ6jac/report.json` 与 `.scratch/acceptance-2026-10-26/mcp/run-PGO6Gf/report.json`。驱动报告的 `commit` 字段保留最初冻结值 `d55802f`；对最终候选的适用性通过相同 bundle SHA 和安装缓存的逐文件比较建立，没有改写旧报告。

最终 bundle SHA-256 为 `7717124cc62ace35424eb88622aaa896dcd9a1270232c547b7a73d99f68f9177`。冻结 MCP 驱动 SHA-256 为 `d4ef1832552ffa25048ae38078550039ed18bf6f815fed37e7a1f5e08435c354`；历史驱动及假子进程分别为 `65f802cfb76c514464e97fdc888cea2503c9a59b39ce99e68a76592e2db3e477`、`3daf907b693f944409f8ba90267f7ca6bd0e4108308edf211459a9e06c9d5aa3`。

从仓库根目录可在保留的本地环境重放补充检查：

~~~powershell
rtk proxy node .scratch/acceptance-2026-10-26/mcp/run.mjs E:/work/skillping/distribution/skillping-runtime
rtk proxy node .scratch/acceptance-2026-10-26/mcp/onboarding.mjs E:/work/skillping/distribution/skillping-runtime
rtk proxy node .scratch/acceptance-2026-10-26/source/history-acceptance.mjs E:/work/skillping
rtk proxy powershell -NoProfile -File .scratch/acceptance-2026-10-26/check-processes.ps1
rtk proxy node .scratch/acceptance-2026-10-26/collect-results.mjs
~~~

聚合脚本读取本轮固定报告，核对哈希、断言、Git tree、发布清单和安装缓存，输出 `.scratch/acceptance-2026-10-26/final-summary.json`；它不是新的产品测试入口。原始安装、构建与 notices 证据在同目录的 `artifacts/final/`。MCP、历史及首次介绍检查的子进程均已退出，最终限定路径的进程检查未发现残留。

最初的夹具迭代中存在健康状态名称、未确认导入状态以及 TAP/spec 输出解析的预期错误；原失败报告与修正说明均保留，没有作为产品缺陷或成功结果隐藏。独立上下文复核已核对本轮六个修改文件、两个相同 Git tree、receipt、许可证、安装及 MCP 报告，未发现阻断项；复核使用继承的父会话模型。

预先存在的 `docs/technical-documentation.zh-CN.md` 保持未跟踪且未改动，SHA-256 仍为 `32dafff25e5614b2717ab887972acfd461033be7bf421789b82cbaa04b2d2e46`。审计的零告警描述执行时 registry 已知漏洞；本次没有增加加密或在线模型准确性保证。

未验收的外部边界：真实模型会话或 Desktop 中的 Hook 触发和信任 UI、在线模型/提供商权限与判断质量、实际外部 Skill 的发现及应用、远程 marketplace 下载发布及真实用户全局安装。安装夹具和原生 CLI 证明了本地包与 MCP 配置可用；这些外部边界不计入 PASS。
