# 当前推荐链路验证

从仓库根目录运行以下命令。需要 Node 24+ 和 Runtime 的现有开发依赖，不使用在线模型，也不读取本机 SkillPing 数据或凭据。

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/recommendation/run.mjs
~~~

日常检查使用 `scripts/check-recommendation-lifecycle.mjs` 中的九项 node:test 检查。完整入口会额外编译干净源码副本，运行前后两遍真实场景、六个可编译源码错误和六个模型反例。每次运行在本目录忽略的 `.work/run-*/report.json` 保存报告、事件、源位置、精确补丁、编译日志和重放命令。只有退出 0 且 `status=pass`、`source_unchanged=true` 才算完成。编译失败、模块加载失败、无关异常、存活变体或超时均属于验证未完成，不能当作检测到业务错误。

## 生产调用路径

当前 MCP 的 `observe_turn` 使用提取 v6 和复核 v3。`createHandlers.observe_turn` 在 accepted 后调用 `engine.claimDispatch(stop_hook_active=false)`，由后者调用 `storage.claimDispatch(recommendation="web")`。推荐包放在该次工具结果的 `recommendation_instructions`，通过公开的 `finish_recommendation` 完成。

公开 MCP 工具 `claim_dispatch` 是 Stop 清理入口。它强制 `stop_hook_active=true`，中断未完成的 web 请求并返回空对象。把这个公开工具当作主动领取入口，会测到已经退役的运输方式。本验证保持现行契约。

`completeDispatch`、`blockDispatch` 和 `dispatch_search_receipts` 保留给旧调用。当前 web 请求使用 `recommendation_requests`；`retry_unverified_dispatch` 只为没有完成凭据的旧 dispatched 结果补搜。本验证检查成功的 web 回执不能进入该重试入口，不把旧完成路径当作 web 完成替代品。

## 状态图和业务规则

~~~mermaid
stateDiagram-v2
    [*] --> pending: 已确认且达到两维门槛，当前轮有证据
    blocked --> dispatching: 领取满足当前规则
    pending --> dispatching: SQLite 事务领取并写轮次凭据和请求 UUID
    dispatching --> dispatched: accepted completed，原子写回执和 30 天 cooldown
    dispatching --> dispatched: accepted no_improvement，原子写零计数回执和 baseline silence
    dispatching --> failed: accepted unavailable，记录具体失败原因
    dispatching --> failed: Stop 或请求年龄大于等于 10 分钟
    dispatching --> cancelled: 当前证据、原型、门槛、作用域或开关已不允许
    dispatched --> dispatched: 重复和迟到完成返回 ignored
    failed --> failed: 重复和迟到完成返回 ignored
    cancelled --> cancelled: 重复和迟到完成返回 ignored
    failed --> pending: 后续有效观察可重新排队，领取受退避与次数限制
~~~

同一 task/turn 的持久 `dispatch_turn_receipts` 只允许领取一个 Workflow。领取失败、查询失败或中断都不释放该轮凭据。独立 SQLite 连接竞争领取也必须遵守这个限制。

Web 超时从 `claimed_at` 开始，年龄等于 600,000ms 已过期。它不会被旧路径的 30,000ms 超时提前回收。完成和数据库重新打开或懒清理都要守住该边界。迟到的 no_improvement 不能静默能力。

`completed` 接受 0 至 3 的整数。即使为 0，也原子提交 dispatched、完成时间、计数和 `finished_at + 30天` 的 cooldown。`no_improvement` 必须使用允许格式的 `baseline_skill`，不允许附带 count；成功时记录零计数和该能力及作用域的永久静默，继续积累观察。软件只能验证回执形状，实际应用了核心 Skill、搜索和比较是否充分仍是宿主遵守推荐包的责任。

`unavailable` 只接受 `tools_missing`、`guide_unreadable`、`lookup_failed` 和 `query_unsafe`。这些失败没有成功回执、cooldown 或永久静默。失败后的 300,000ms 内不能再次领取；等于该边界允许。最近 3,600,000ms 内最多三次此类失败或中断；恰好一小时前的失败不占次数。重试还需要新的可领取轮次及其证据，同轮重试被轮次凭据禁止。

成功完成前在同一 SQLite 写事务内重新检查 Workflow 状态、原型版本、实时两维门槛、抑制及静默、cooldown、作用域、当前轮有效证据和冻结原型。检测与推荐两个开关都必须仍允许推荐。DB_BUSY 只重试一次，第二次必须重新读取实时开关。错误回执、未知 UUID 和重复完成不会制造成功凭据。

| 性质 | 模型动作及源码对应 | 真实场景 |
| --- | --- | --- |
| ONE_CLAIM_PER_TURN | Claim；storage.claimOnce 的 BEGIN IMMEDIATE、轮次凭据读写。 | 两个独立连接竞争两个 Workflow；失败后同轮再次领取。 |
| FINAL_ELIGIBILITY | InvalidateEvidence、ChangePrototype、Disable、Finish；finallyEligible、currentEvidence、completeOnce 的冻结原型比较。 | 领取后分别修改证据、原型、门槛、作用域、抑制、状态、版本、cooldown、静默和两个开关。 |
| WEB_EXPIRY | Expire、Finish；WEB_RECOMMENDATION_TIMEOUT_MS、recoverDispatches、finishRecommendation 和 completeOnce。 | 30秒、599999ms、600000ms、600001ms，以及重新打开和懒回收。 |
| COMPLETION_ATOMICITY | Finish(completed)；completeOnce 的一次事务内完成回执与 cooldown 写入。 | completed(0/3)、重复及相反回执、竞争完成、拒绝 legacy 补搜。 |
| BASELINE_SILENCE | Finish(baseline)；completeOnce 的回执和 recommendation_silenced_by 写入。 | no_improvement、重复完成、超过30天继续观察仍不自动搜。 |

另外，真实代码检查覆盖严格的回执分支验证、Stop 中断、四种明确失败及退避/次数相等边界，以及持有实际 SQLite 写锁产生 DB_BUSY 后刷新开关。数据库仅在新建的系统临时目录内创建，退出时检查目录前缀并清理。

## 验证能发现什么错误

六个变体只修改编译副本的 `src/storage.ts`，不会修改产品源码、模型或断言。

| 变体 | 故意改坏的代码 | 必须触发的实际反例 |
| --- | --- | --- |
| M_TURN_RECEIPT | 让轮次凭据查询永远不命中。 | 同轮两连接分别领取了两个 Workflow；ONE_CLAIM_PER_TURN。 |
| M_CURRENT_EVIDENCE | 跳过当前轮证据检查。 | 旧轮次仍达门槛，但该请求当前轮证据已撤回，完成仍成功；FINAL_ELIGIBILITY。 |
| M_FROZEN_PROTOTYPE | 跳过领取时原型比较。 | 原型内容已经改变，旧推荐仍写入成功回执；FINAL_ELIGIBILITY。 |
| M_WEB_EXPIRY | 将 web 超时由10分钟改成11分钟。 | 请求在600000ms仍授权 no_improvement；WEB_EXPIRY。 |
| M_COOLDOWN | 成功完成时写入 NULL cooldown。 | 成功回执和冷却状态不一致；COMPLETION_ATOMICITY。 |
| M_BASELINE_SILENCE | no_improvement 写入 NULL baseline。 | 接受了静默回执却未保存静默；BASELINE_SILENCE。 |

模型对同名边界分别引入错误动作，保存最短广度优先反例。真实变体必须先编译成功，运行时由指定性质失败。完整报告记录唯一源锚点的当前行号、前后 SHA-256、补丁和具体事件，避免把编译错误当作测试敏感性证据。这些是故意构造的错误，不代表干净产品有相同缺陷。

首次干净运行在基准提交 `41149ac1ec3c6be830a87e153eafb04220b257e4` 的源码上通过，未发现需要修复的推荐产品缺陷。原始模型穷举4,064个状态和21,664次转移；这些数字描述该有限模型，不是覆盖全部运行时调度的比例。

反例复核发现并修正了一处模型错误。原模型允许 ChangePrototype 发生在 Claim 之前，却仍把该次领取标为使用旧原型。真实 Claim 冻结当时的最新原型，因此模型现在在 Claim 重设冻结快照。修正后的原型反例必须按 Claim、ChangePrototype、Finish 的顺序发生。真实 SQLite 用例始终在领取后改变原型。这项修正属于验证基础设施，不是产品缺陷，也没有放宽最终资格性质。

## 边界与维护

显式状态模型有两个 Workflow、两个 task/turn 标识，每个 Workflow 最多一个请求。请求年龄抽象为新鲜或过期，完成结果抽象为 unavailable、completed 和 baseline，事务按 SQLite 原子提交建模。模型允许交错切换开关、撤回证据、改变原型、超时和 Stop。只有成功当时的资格进入性质判断，之后的设置变化不会把合法历史回执误判为违规。

模型不穷举重复请求、真实时钟、30天计数、5分钟退避、每小时次数、任意异常、断电、SQLite 故障或无限进程。相关具体数值和竞争连接由真实代码场景检查；计数与档位由单独验证负责。UUID 随机性、宿主搜索质量、回执真实性和在线模型语义不在证明范围。没有公平性、活性或 TypeScript 对状态模型的形式化精化证明。

`verification.json` 的源指纹和 sync commit 是模型对应关系的变更提醒。出现 SOURCE_MAPPING_STALE 时，先用代码图审阅变动函数及调用者，核对状态图、守卫、事务边界、回执写入及场景；必要时修正模型和用例，再更新实际审核过的指纹和 sync commit。不能只刷新哈希使检查变绿。完成维护后完整运行本入口，包括所有源码变体和最终干净场景。
