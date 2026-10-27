# 推荐计数与控制规则验证

本目录验证当前提取 v6、复核 v3，以及 Runtime 的计数和控制行为。快速检查使用真实 SQLite 和实际 engine，不发送在线模型请求。

从仓库根目录运行完整验证。

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/counting/run.mjs
~~~

已有编译输出时，可以从 Runtime 目录运行十一组实际代码检查。

~~~powershell
rtk proxy node --test scripts/check-counting-rules.mjs
~~~

`run.mjs` 将当前 `src` 复制到隔离目录，调用项目 TypeScript 编译器，先运行干净基线，再运行八个成功编译的临时源码错误，最后重跑干净基线。每个错误必须触发指定的 `COUNT_*` 业务断言。编译错误、超时、无关异常、错误存活均报告 `incomplete`。干净基线触发 `COUNT_*` 业务断言时报告 `code-finding`，夹具或执行异常仍报告 `incomplete`。

每次运行的 `report.json`、编译日志、TAP 反例和准确的源码替换保存在忽略的 `.work/run-*` 中。报告包含源码行号、指纹和隔离副本的重放命令。`verification.json` 保存已核对源码的指纹和提交。出现 `SOURCE_MAPPING_STALE` 后，需要重新核对下面的规则及场景，再更新对应记录。

## 计数状态

~~~mermaid
stateDiagram-v2
    [*] --> 提取v6
    提取v6 --> 无计数变化: skip，包括续问和同项工作重试
    提取v6 --> 已有请求: 相同 task、turn、message
    提取v6 --> 已有请求: 同 task、规范化同工作区、相同文本
    提取v6 --> 独立episode: analyze 的新请求
    独立episode --> 累积证据: 匹配当前 capability
    累积证据 --> 等待更多证据: episode 或 task 任一门槛不足
    累积证据 --> 复核v3: forming 且两个门槛均满足
    复核v3 --> 已确认: 当前证据页已读取且 verdict=same
    已确认 --> 待推荐: 新的当前证据、两开关开启、scope及其他限制允许
    待推荐 --> 已取消: 关闭检测或关闭推荐
    已取消 --> 等待新工作: 重新开启
    等待新工作 --> 待推荐: 后续独立工作仍符合当前门槛
~~~

`episode_workflows` 以 episode 与 workflow 组成唯一关联。计数使用 `COUNT(DISTINCT e.id)` 和 `COUNT(DISTINCT e.codex_task_id)`，两个门槛以 AND 连接。episode 多次出现在同一 task 中会增加 episode 数，不会增加 task 数。

| 档位 | 独立 episode | 不同 task |
| --- | ---: | ---: |
| eager | 3 | 2 |
| balanced | 5 | 3 |
| cautious | 8 | 4 |

“会话”在该计数中对应 `codex_task_id`，当前 v6 入口通过 `session_id` 提供这个标识。它不是模型 HTTP 会话，也不是消息数。

## 规则与源码对应

| 规则 | 源码 | 实际检查 |
| --- | --- | --- |
| 双维门槛及档位 | `config.RECOMMENDATION_PACES`，`storage.meetsThreshold`、`countsFor`、`meetsCurrentThreshold`、`queue` | 三档分别验证 episode 下界和 task 下界。有限矩阵枚举 episode=0..10、task=0..episode，共198个组合。SQLite 和 v6 engine 均验证达到门槛才排队。 |
| 复核后确认 | `recordOnce`、`requestReviews`、`resolveReview` | 三档的 forming 工作流达到门槛后要求 v3 复核。读取当前证据后提交 same，只产生一次待推荐。 |
| 重复去重 | `recordOnce` 的请求身份查询及同 task 文本查询 | 并发同 turn 提交只写一次。规范化同路径的同文本重试不新增 episode。另一工作区或另一 task 可以独立计数。 |
| 续问与纠错 | `prompts/extract-v6.md`，`engine.observeTurn` | 当前协议的 skip 不保存工作。一次无效提取可纠正，纠正成功后重复提交 ignored。五次续问 skip 和纠错仍只有一个 episode。 |
| 30天窗口 | `countsFor`、`currentEvidence`、`claimOnce`、`cleanup` | episode.started_at 和相关 prompt.occurred_at 都必须位于 `(now−30天, now]`，且 expires_at 严格大于 now。检查等于下界、下界前后1ms、未来 episode、未来 prompt、过期相等和相等后1ms。 |
| scope | `reviewRows`、`controlled`、`claimOnce`，`matcher.workspaceKey` | global 证据可以跨工作区汇总。project 的候选和领取限制在规范化同工作区。Windows 大小写及斜杠别名等价。 |
| 两个开关 | `engine.stagePrompt`、`observeTurn`、`control`，`storage.queue` | 四种开关组合。关闭检测不保存提取。关闭推荐继续计数但不排队。关闭会取消待推荐，重开需要新的符合条件工作。一个开关保留另一个偏好。 |
| 档位持久化 | `engine.control` 的 `set_recommendation_pace` | 每档命令返回 ok，磁盘及新 config store 一致，新 engine 读取最后的 cautious。旧集成测试也检查该现行命令成功和持久化，同时保留 Key 不泄漏断言。 |
| Workflow 反馈 | `engine.control`，`storage.relevantWorkflowIds`、`applyFeedbackOnce` | 五种反馈命令拒绝缺失、不存在、跨 task 和歧义引用，数据库保持不变。绑定引用可冷却、覆盖、重开、拒绝和失效。重开保留冷却，明确拒绝优先于覆盖或重开，失效取消已领取推荐并保留证据。 |

窗口场景在隔离数据库中保留过期哨兵请求，并用 DELETE trigger 使物理清理回滚。这样，领取必须依赖逻辑时间谓词，不能因为清理恰好删除了过期行而通过。这个场景对应源码中“物理删除失败时逻辑谓词仍具权威性”的约定。

## 临时源码错误及指定反例

| 临时错误 | 必须出现的业务反例 |
| --- | --- |
| `M_THRESHOLDS_OR` 把 AND 改为 OR | 未同时满足两个门槛时被允许，触发 `COUNT_THRESHOLDS`。 |
| `M_TASK_ROWCOUNT` 将不同 task 数改为行数 | 同一 task 的多次独立工作过早排队，触发 `COUNT_TASKS`。 |
| `M_RETRY_NEW_EPISODE` 绕过同文本重试去重 | 规范化同工作区重试新增 episode，触发 `COUNT_DEDUPE`。 |
| `M_WINDOW_INCLUSIVE` 将 episode 下界向前移1ms | 恰好30天前的 episode 仍被计数并领取，触发 `COUNT_WINDOW`。 |
| `M_PROJECT_CROSS_SCOPE` 放宽项目候选工作区过滤 | project 请求读到另一个工作区的候选，触发 `COUNT_SCOPE`。 |
| `M_RECOMMENDATION_OFF` 去掉 queue 的 enabled 检查 | 推荐开关关闭时仍然排队，触发 `COUNT_SWITCHES`。 |
| `M_PACE_NOT_PERSISTED` 忽略命令中的档位 | 返回和磁盘仍是原档位，触发 `COUNT_PACE_CONTROL`。 |
| `M_REOPEN_DROPS_COOLDOWN` 在重开覆盖状态时清空冷却 | 仍有效的冷却丢失，触发 `COUNT_FEEDBACK`。 |

上述错误只存在于隔离编译副本。它们验证检查能发现对应回归，不表示当前产品存在这些缺陷。生产代码和业务断言保持原样，结束时再次核对源码及断言文件指纹。

## 范围与限制

这组检查采用有限阈值矩阵和真实 SQLite，不新增 TLA+ 模型。两个计数维度没有需要额外穷举的并发状态机，重复写入由 SQLite 唯一键和事务承担，选定并发场景由实际代码检查。该选择不提供无限 task、任意调度或整个 TypeScript 实现的形式化证明。

v6 将续问、同项重试、格式或要求变更表达为 `skip`。验证向入口提交这个现行协议结果，不证明在线模型能正确识别所有自然语言续问。不同自然语言文本的语义去重仍依赖提取模型。测试没有恢复已退役的提取格式，也没有把内部旧的 continue/modify 运输字段作为现行入口。

推荐完成、web 超时、失败重试、完成后的 cooldown 和 baseline silence 的验证属于相邻的推荐生命周期检查。本目录另行检查反馈冷却及其与覆盖和拒绝的关系。这里的时间变化、Key、数据库和控制命令只作用于新建隔离目录，不读取本机真实 SkillPing 数据。

本次集成同步至 `d153fcf1c18fb061f6cb78be7f9193bf4efb46b8`。相对最初源码，只有配置原子替换的有限 Windows 重试发生变化。它仍在原有写锁内等待，不改变档位、开关、计数、scope 或模型配置内容。已核对上述调用与持久化断言，因此计数规则及七个指定反例保持原义。源码指纹和匹配统一按 UTF-8 LF 计算；每次运行另外比较原始源码及断言文件字节。它兼容既有 CRLF 文件和隔离换行检查，仓库新检出仍按 `.gitattributes` 使用 LF。

随后依赖升级的边界行为核对和 lockfile 同步依据见 [依赖更新记录](../DEPENDENCY-UPDATE.md)。最新同步提交和指纹以 `verification.json` 为准，计数规则、有限矩阵和原有七个指定源码错误保持原义。完整验收补充上述 Workflow 反馈检查和第八个指定源码错误，产品源码及其指纹保持不变。

## 分批匹配的源码同步

本次以 `343a9e4b9695f222e8b76427b2d8b28760402f75` 为基准核对未提交差异。实时 v6 先冻结全部候选，通过 Sqwish 完整扫描或主模型渐进复核，再完成所需终审，最后原子增加最多一个 Workflow 的贡献。中间工作记录可以存在，但没有 `episode_workflows` 关联，因此不增加 Workflow 的两个计数。forming 或旧原型版本达到门槛时，当前贡献先作为 proposed 参与复核。

distinct episode、distinct task、AND 门槛、时间窗口、scope 和推荐控制的定义不变。实际 v6 夹具现在用注入的确定性 `same` 回答完成主模型扫描及证据终审，再检查原有计数边界，禁止在线模型请求。反馈歧义夹具显式保留一条历史多关联记录；新路径不再接受多 ID 匹配结果。

单一归属、全集扫描和完整快照新增独立的 [匹配模型及源码变体](../matching/README.md)，本目录保留原有八个可编译错误及指定断言。`sync_commit` 是审阅基准，`sync_note` 说明当前源码含未提交修改，源码指纹锁定实际审阅版本。
