# Windows 配置原子替换验证

`atomicJsonWrite` 原先只尝试一次 `rename`。Windows 的独立进程持有目标文件、未允许 `FileShare.Delete` 时，原生替换返回 `EPERM`。写入者的 SQLite 锁不能阻止这种文件句柄。因此短暂的操作系统拒绝会直接变成 `CONFIG_WRITE_FAILED`，即使并发修改已经正确串行化。

独立进程健康计数夹具在未修改的 `41149ac1ec3c6be830a87e153eafb04220b257e4` 上复现 6 次相同的 `EPERM`，25 次运行中 19 次通过。尚未捕获这 6 次失败中实际持有冲突句柄的进程，不能据此断言是另一个 Node 进程或杀毒软件。原生句柄回归证明的是同类 Windows 拒绝及恢复机制。

修复保留临时文件和 `rename` 原子替换，只在 Windows 上为 `EPERM`、`EACCES`、`EBUSY` 增加有限重试。最多尝试 6 次，等待 5 次、每次 20ms。已有配置写入锁继续覆盖整个操作。目标文件不会先被删除。其他错误立即失败，重试耗尽仍保留原始 `cause`、降级健康状态及临时文件清理。

共享调用处是首次配置创建、`updateConfigNow` 和 `writeImportProgressNow`。`recordFailure`、`recordSuccess`、设置修改及清空配置发布沿这些调用执行。没有新增生产参数、依赖或配置项。

## 复跑

在 Runtime 目录运行日常检查。新增回归已经放入原有 `check-architecture.mjs`，无需增加另一份默认测试入口。

~~~powershell
rtk npm test
~~~

从仓库根目录重复原有并发夹具。先在 Runtime 目录运行 `rtk npm run prebuild`。每个样本启动新的 Node 测试进程，其内部同时启动两个进程，各记录 6 次 storage 或 history 失败。每次都新建隔离数据并断言两个计数均为 6。

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/config-write/repeat.mjs 25
~~~

运行原生 Windows 错误敏感性检查。

~~~powershell
rtk proxy node plugins/skillping-runtime/verification/config-write/red-green.mjs
~~~

该检查复制当前源码，分别编译干净副本、移除重试的临时副本和最终干净副本。每个副本运行同一个原生句柄回归。PowerShell 子进程打开不允许删除共享的真实句柄，父进程观察原生 `rename` 的 `EPERM` 后才通知子进程关闭句柄。没有依赖定时释放的偶然调度。移除重试的副本必须先编译成功，再以 `CONFIG_WRITE_FAILED` 及原生 `EPERM` 触发指定业务测试失败。干净副本前后均须通过，生产源码指纹必须未变。

报告、原始输出和编译副本写入忽略的 `.work`。编译失败、超时和其他断言失败不算错误检测成功。`red-green.mjs` 需要 Windows 和可用的 PowerShell，其他平台不宣称检查通过。

## 本次实测

Node 为 `v24.18.0`，平台为 Windows。

| 检查 | 未修复 | 修复后 |
| --- | --- | --- |
| 原有并发夹具，25 个独立样本 | 19 通过，6 个原生 EPERM | 25 通过 |
| 新增 9 个控制场景 | 1 通过，8 失败，包括原生句柄场景 | 9 通过 |
| 原有加新增 architecture 场景 | 未作为整体结论 | 19 通过 |
| 默认四份检查 | 交接中曾为 112/113 | 122/122 通过 |
| 隔离编译的原生错误敏感性 | 移除重试后指定场景失败 | 干净副本前后通过 |

控制场景检查瞬时的三种 Windows 错误、真实独立进程句柄、持续错误耗尽、非重试错误立即失败、旧 JSON 完整可见、设置保留、错误原因、锁释放及导入进度共用操作。

重试不保证任意长时间的句柄占用都能成功。持续权限或共享错误仍报告失败。样本说明本次调度下的行为，不是所有 Windows 文件系统或系统负载的证明。所有数据和连接 Key 都是新建隔离夹具。
