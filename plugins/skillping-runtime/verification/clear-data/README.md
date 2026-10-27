# 清空数据验证

从仓库根目录运行：

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/clear-data/run.mjs
~~~

需要 Windows x64、Node.js 24+ 和 Runtime 已安装的开发依赖。首次运行从固定的官方 GitHub 发布地址下载 TLC 1.7.2 和 Temurin JRE 21.0.9+10，先验证 SHA-256，再解压执行。工具保存在仓库忽略的 .scratch/formal-tools 中，不改变系统 Java 或 PATH。版本、校验值和覆盖源码指纹以 [verification.json](verification.json) 为准。

命令退出 0 表示模型基线、真实代码场景、四个模型反例、四个可编译的源码错误及最终干净基线均符合预期。输出会给出 report.json 的绝对路径。报告、编译副本和反例保存在本目录忽略的 .work 中，便于复核和重放。源码变化导致 SOURCE_MAPPING_STALE 时，需要先核对模型与代码，不可只更新指纹。

## 代码中的状态流转

~~~mermaid
stateDiagram-v2
    [*] --> 正常
    正常 --> 等待确认: request_clear
    等待确认 --> 拒绝: 无效、替换、跨会话或过期令牌
    等待确认 --> 本地停写: 有效 confirm_clear，消费令牌并失效旧操作
    本地停写 --> 等待活动操作结束
    等待活动操作结束 --> 持有清理所有权: clear-owner.sqlite
    持有清理所有权 --> 第一次独占门禁: clear-lock.sqlite
    第一次独占门禁 --> 持久暂停: 校验代次，写 clear_pending
    持久暂停 --> 第一次逐文件删除: 释放门禁，删除 DB、WAL、SHM
    第一次逐文件删除 --> 第二次独占门禁
    第二次独占门禁 --> 最终逐文件清理: 复查代次，清理 DB 和附属文件
    最终逐文件清理 --> 发布新代次: 代次加一，clear_pending=false
    发布新代次 --> 正常: 释放门禁和所有权，返回 ok
    本地停写 --> 失败返回: 操作错误
    第一次独占门禁 --> 失败返回: 锁、校验或配置写入错误
    第一次逐文件删除 --> 失败返回: 删除错误
    最终逐文件清理 --> 失败返回: 删除或配置写入错误
    发布新代次 --> 失败返回: 后续解锁错误
    失败返回 --> 等待确认: 新的清空请求
    失败返回 --> 正常: 刷新配置且 clear_pending=false
~~~

清空不是数据库事务中的一次 reset。JSON、文件和 SQLite 协调锁有不同提交边界。模型将每次 unlink 或 rmdir 分开，包括两轮 DB、WAL、SHM 删除、一个工作目录的两个子文件及目录、密钥、进度和两份诊断文件。

失败返回时本进程设置 blocked。持久暂停只保证在已写入 clear_pending、尚未发布新代次的阶段存在。首次暂停写入前失败，或发布新代次后解锁失败，均可能看到 clear_pending=false。syncStorageGeneration 会据此重算本地阻塞。错误返回也不能解释成文件删除已被回滚。

## 需要守住的业务规则

| 规则 | 断言 | 代码与模型对应 |
| --- | --- | --- |
| AUTHORIZATION | 删除必须由新鲜、当前且属于同一会话的确认授权；旧快照不能授权新的清空。 | engine.control 的 request_clear、confirm_clear；config.clearData 的两次快照检查。Request、Confirm、StaleSnapshot、DeleteFile。 |
| NO_STALE_WRITE | 成功清空后，捕获旧代次的受保护回调不能重新写入旧数据库证据。 | config.withDataAccess；engine.withDataGeneration、syncStorageGeneration、track。CaptureCallback、CheckCallback、WriteCallback、Return。 |
| FAILURE_SAFE | 清理失败不能报告成功；已有删除但尚未发布新代次时，持久暂停必须保持；暂停期间回调不能进入写入阶段。 | engine.control 的错误返回；config.clearData、atomicJsonWrite。Fail、CleanupAfterError、Return、partialDeletion 观察变量及 CheckCallback。 |
| SETTINGS_RETAINED | 清空保留检测和推荐开关、档位、介绍偏好及模型连接设置，包括 API Key。 | config.clearData 最终配置更新；PublishFinal。真实代码检查比较完整连接配置，报告只记录是否相等。 |

源码在 [config.ts](../../src/config.ts)、[engine.ts](../../src/engine.ts)、[storage.ts](../../src/storage.ts) 和 [domain.ts](../../src/domain.ts)。报告用唯一代码片段计算当前行号，并记录验证过的 SHA-256。文件指纹是变更提醒，不表示整份文件均已证明。

AcquireOwner 对应清空所有权的 BEGIN IMMEDIATE。AcquireFirstGate 和 AcquireFinalGate 对应 BEGIN EXCLUSIVE。回调从共享门禁获取、检查到释放期间始终持有读锁。PublishPause 和 PublishFinal 各对应一次成功的原子 JSON 替换；该替换也有失败分支，已提交的 JSON 不随 SQLite 回滚。

## 真实代码与错误敏感性

检查复制当前 src，使用项目已安装的 TypeScript 编译，再执行副本中的实际 createScoutEngine、openConfigStore 和 openStorage。相对模块导入必须留在副本内。生产源码、断言和模型均不因源码错误注入而改变。

真实场景包括确认拒绝与令牌消费、完整清理和设置保留、旧代次回调拒绝、部分删除失败及新确认重试、独立进程的原生 SQLite 门禁和进程退出后锁释放，以及在途匹配响应清空后的迟到返回。部分失败通过把临时数据目录中的 key.dpapi 设置为目录触发真实文件类型检查；它发生在数据库删除之后。

| 临时源码错误 | 必须出现的实际反例 |
| --- | --- |
| M_AUTH_SESSION 删除会话比较 | 会话 B 使用会话 A 的令牌，实际清空成功。AUTHORIZATION 报错。 |
| M_OLD_GENERATION 删除代次比较 | 旧回调进入并创建真实 SQLite 证据。NO_STALE_WRITE 报错。 |
| M_FALSE_SUCCESS 将清空错误返回改为 ok | 已发生部分删除、仍处于暂停的清空被报告成功。FAILURE_SAFE 报错。 |
| M_RESET_CONNECTION 清空保留的连接 Key | 成功清空改变原有连接设置。SETTINGS_RETAINED 报错。 |

每个变体都必须先通过 TypeScript 编译和模块加载，再由指定业务断言判错。编译失败、无关异常、进程超时或其他断言失败不能算检测成功。每条记录保留改动前后指纹、准确替换片段、事件顺序及重放命令。模型也分别运行对应的四个错误动作，要求触发同名不变量。

这些反例属于故意变坏的副本，不是对当前产品存在相同缺陷的声称。检查最后再次运行干净模型和六组真实场景，并比较原始产品源码指纹。

## 验证范围

TLC 穷举两个运行进程、两个会话标识、每进程一个控制流程和一个活动回调、最多两次确认签发、代次 0 至 2。两次签发也限制清空次数；替换令牌会消耗此模型预算。回调可在这些有限状态内重复捕获和提交。包含一个具有两个文件的工作目录，文件内容用存在性和数据库证据代次表示。

错误切点覆盖暂停前、逐文件删除之间、最终配置发布之后及解锁阶段。Crash 表示进程退出后私有状态和 SQLite 锁释放，已提交文件和 JSON 保留；真实进程终止场景检查本机的 SQLite 锁释放。崩溃中的操作系统锁释放顺序、断电持久性和文件系统损坏属于模型假设。

有效会话与令牌只抽象为两个标识和有效或无效状态。模型不证明随机令牌不可预测性，不证明实时时钟单调，也不穷举任意令牌字节。过期相等边界由真实代码场景检查。

SQLite 共享及独占锁、同步事务和成功 rename 的可见性按平台语义建模，并允许操作返回错误。有限状态使用进程对称性约简。没有公平性、最终成功、无限进程数或所有运行时调度的证明。确认可能被拒绝和终端静止均是允许结果，因此不检查死锁或活性。

受保护写入遵循 withDataAccess 门禁是模型前提。直接绕过门禁的 openStorage 调用、多 owner 的全部同进程交互、任意外部配置修改、历史导入工作体及在线模型语义不在证明范围。真实场景是对实现的具体检查，不构成 TypeScript 与模型之间的形式化精化证明。

本入口已纳入 `npm test`。配置原子写入的重试及原生 Windows 句柄场景由 [配置写入验证](../config-write/README.md) 检查。

## 本次源码同步

从 `41149ac1ec3c6be830a87e153eafb04220b257e4` 到 `839522e57fc21bc0733eccbbba586f5f67fffb7a` 的覆盖源码差异只有 `atomicJsonWrite` 的有限重试。已经沿 `updateConfigNow`、首次配置创建、`writeImportProgressNow` 和清空的两次配置发布检查调用路径。`withDataAccess`、代次检查、确认授权、逐文件删除和保留设置的写入均未改变。

新代码在原有配置写锁和清空门禁内等待，再次尝试同一个临时文件的 `rename`。等待期间没有发布新的 JSON，也没有释放这些锁。因此模型中的等待是 stuttering，成功替换仍分别对应 `PublishPause` 或 `PublishFinal`。重试耗尽仍由原错误路径到达 `Fail`，已发布配置和已删除文件仍不会回滚。四条性质、执行动作、状态边界和六组场景均保持原义。

修改前基线完整通过。合入修复后，旧指纹按预期报 `SOURCE_MAPPING_STALE`，这是验证映射过期。完成上述核对后才更新 `verification.json`。模型注释使用符号名称和报告计算的位置，避免代码插入导致手写行号失效。完整复跑仍要求两个干净 TLC 基线、六组真实场景前后复测及四个模型和可编译源码反例，性质没有削弱。

前次同步提交为 `d153fcf1c18fb061f6cb78be7f9193bf4efb46b8`，后续两个集成提交仅增加验证文件和修正档位测试，覆盖的产品源码与上述修复提交一致。源码指纹与变体匹配统一按 UTF-8 LF 计算，兼容既有工作区混用的 LF、CRLF 和隔离换行检查。仓库新检出仍按 `.gitattributes` 使用 LF。每次运行仍单独比较原始源码字节及断言文件，工具下载校验仍使用原始字节。

随后依赖升级的边界行为核对和 lockfile 同步依据见 [依赖更新记录](../DEPENDENCY-UPDATE.md)。最新同步提交和指纹以 `verification.json` 为准，四条性质和原有状态边界保持不变。

## 分批匹配的源码同步

本次以 `343a9e4b9695f222e8b76427b2d8b28760402f75` 为基准审阅未提交差异。新 `recordDecisionObservation` 在门禁外等待最多五题一批的 HTTP，跨批沿用一个截止时间。`observeTurn` 的最终 `resolveReview` 也通过 `withDataGeneration`，只在该门禁内执行短事务。清空授权、两轮删除、持久暂停和配置保留的实现没有变化。

模型的受保护回调仍抽象为一次最终写入；网络扫描和内存中的暂定赢家不写入贡献，属于门禁外的等待。`late-response` 现在冻结七个候选，第一批完成后阻塞第二批，再清空并释放迟到响应，检查取消和新数据库零证据。TLC 的四条性质及状态边界不变，额外扫描行为由 [匹配验证](../matching/README.md) 检查。

先运行旧映射得到 `SOURCE_MAPPING_STALE`，沿调用路径完成上述核对后才更新指纹。`sync_commit` 是审阅基准，`sync_note` 明确本次代码尚未提交；实际对应关系由当前源码指纹及完整重跑报告给出。
