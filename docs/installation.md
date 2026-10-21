# SkillPing 安装、配置与管理

需要 Windows、Node.js 24+（含 npm），以及支持原生插件 Hook 的 Codex。

## 从 GitHub 安装

在 Codex 中发送：

~~~text
帮我安装 SkillPing：https://github.com/Nightconch/skillping
~~~

也可以在 PowerShell 中运行：

~~~powershell
irm https://raw.githubusercontent.com/Nightconch/skillping/main/install.ps1 | iex
~~~

脚本会安装两个插件，并提示填写 Sqwish Key。输入隐藏，直接回车跳过；Key 只保存到 Runtime 本机的 `config.json`。

手动安装命令：

~~~powershell
codex plugin marketplace add Nightconch/skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
~~~

按提示审阅并信任 Hook，重启 Codex Desktop，在新对话中输入：

~~~text
$skillping-help
~~~

检测和推荐默认开启，推荐节奏为均衡。

## 从离线安装包安装

[下载离线安装包](https://github.com/Nightconch/skillping/releases/latest)，选择 `skillping-<版本号>-windows.zip`。完整解压后，在 `README.md` 所在目录打开 PowerShell：

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
~~~

安装后信任 Hook，重启 Codex 并打开 `$skillping-help`。插件从解压目录安装，需保留该目录。

<a id="installed-files"></a>
## 安装文件的位置

通过插件市场安装时，Codex 将运行文件放在自己的插件缓存中，不会在你的工作目录生成源码仓库。

| 内容 | 默认位置 |
| --- | --- |
| SkillPing | `%USERPROFILE%\.codex\plugins\cache\skillping\skillping\<版本号>` |
| SkillPing Runtime | `%USERPROFILE%\.codex\plugins\cache\skillping\skillping-runtime\<版本号>` |
| 源码仓库 | 自行克隆时选择的目录 |

设置了 `CODEX_HOME` 时，用它替换上面的 `%USERPROFILE%\.codex`。模型设置和 Key 保存在 Runtime 本机数据目录的 `config.json` 中，路径可按下方配置步骤查找。

<a id="decision-model"></a>
## 配置 Sqwish 决策模型

不配置 Key 也能正常使用，由 Codex 完成判断。配置 Sqwish `kettei-fat` 后，轻量模型接手前置工作判断和工作流匹配，减少 Codex 的判断开销。调用费用和耗时见 [README 实测](../README.zh-CN.md)。启用后，前置判断发送当前请求正文，匹配发送提取后的工作、能力描述和候选工作流信息。Sqwish 单独计费。

到 [Sqwish 控制台](https://console.sqwish.ai/)注册或登录，开通 API 访问后创建 API Key。

PowerShell 安装脚本可直接填写 Key。手动配置按以下步骤操作。

<a id="runtime-config"></a>
### 1. 找到 Runtime 的 config.json

可以让 Codex 查找 SkillPing 的配置文件并给出地址。手动查找时，先打开一次 `$skillping-help`，再运行：

~~~powershell
$skillpingRuntime = codex mcp get skillping --json | ConvertFrom-Json
Join-Path $skillpingRuntime.transport.env.PLUGIN_DATA 'config.json'
~~~

使用当前 SkillPing Runtime 对应的文件。这个 `config.json` 位于插件的本机数据目录，安装包和源码仓库中的文件不用于保存 Key。拿到路径后，退出 Codex Desktop 和正在运行的 Codex CLI 会话，再编辑该文件。

<a id="decision-settings"></a>
### 2. 填写 Key 并启用

在 `config.json` 的 `decision_model` 中填写以下设置，保留其他配置。把 `api_key` 的空字符串替换为你的 Key：

~~~json
{
  "enabled": true,
  "allow_external": true,
  "provider": "sqwish",
  "model": "kettei-fat",
  "api_key": "",
  "precheck_timeout_ms": 5000,
  "match_timeout_ms": 5000,
  "existence": { "threshold": 0.5 },
  "matching": { "threshold": 0.5 }
}
~~~

保存后重新启动 Codex。以后更换 Key，直接编辑同一个 `config.json`。

Key 缺失、超时或响应无效时，SkillPing 使用 Codex。要停用 Sqwish，将 `enabled` 改为 `false`。不配置 Sqwish 时，SkillPing 默认使用 Codex。

Key 以明文保存在本机 Runtime 配置中。状态和帮助不会显示 Key，清空记录会保留模型连接设置及 API Key。

<a id="upgrade"></a>
## 更新

GitHub 安装在 PowerShell 中运行：

~~~powershell
codex plugin marketplace upgrade skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
~~~

更新后重启 Codex，在新对话中打开帮助。离线更新时，在原安装目录解压新包，再运行两条 `codex plugin add` 命令并重启。

<a id="uninstall"></a>
## 卸载

卸载保留本机记录和设置。需要删除记录时，先在 Codex 中说“清空 SkillPing 全部数据”，收到提示后再单独回复“确认清空”。清空保留开关、推荐档位和模型连接设置，包括 API Key。独立备份需自行删除。

退出 Codex Desktop 和正在运行的 Codex CLI 会话后，在 PowerShell 中运行：

~~~powershell
codex plugin remove skillping@skillping
codex plugin remove skillping-runtime@skillping
codex plugin marketplace remove skillping
~~~

卸载后不再清理过期记录。

## 安装后没有自动检测

确认插件设置中的 SkillPing 和 SkillPing Runtime 都已启用，Hook 已受信任，Node.js 为 24+。重启 Codex 后，用新对话测试。搜索 Skill 还需要 Codex 能执行命令并联网。

## English

Tell Codex: "Install SkillPing: https://github.com/Nightconch/skillping". You can also run the PowerShell installer above. It offers hidden Sqwish Key input; press Enter to skip. The Key is saved only in the Runtime's private `config.json`. The native commands remain available for manual installation.

For an offline package, extract it and run the offline commands from the folder containing `README.md`. Keep that folder. Trust the Hook, restart Codex Desktop, and enter `$skillping-help` in a new chat.

<a id="installed-files-en"></a>
### Where files are installed

Marketplace installations run from Codex's plugin cache at `%USERPROFILE%\.codex\plugins\cache\skillping\<plugin-name>\<version>`. The two plugin names are `skillping` and `skillping-runtime`. Installation does not create a source checkout in your working directory. A source checkout lives wherever you clone it.

If `CODEX_HOME` is set, use it instead of `%USERPROFILE%\.codex`. The Runtime keeps its private `config.json` in the plugin data directory. It is separate from the source checkout and installed plugin files.

<a id="decision-model-en"></a>
### Configure Sqwish

SkillPing works without a Key, using Codex for decisions. Connecting Sqwish `kettei-fat` moves the initial work check and workflow matching to a fast, low-cost model, reducing the decision work sent to Codex. See the [measured results](../README.md). The initial check sends your current request text. Matching sends extracted work, capability descriptions, and candidate workflow information. Sqwish usage is billed separately.

You can enter the Key during PowerShell installation, or configure it manually:

1. Register or sign in at the [Sqwish console](https://console.sqwish.ai/) and create an API key once API access is active.
2. Ask Codex to find SkillPing's local `config.json`, or open `$skillping-help` once and use the [PowerShell lookup](#runtime-config).
3. Quit Codex Desktop and running Codex CLI sessions before editing the file.
4. Use the [configuration object](#decision-settings) for `decision_model`, filling the blank `api_key` with your Key. Keep the other settings, save, and restart Codex.

All model settings and the Key live in the same private `config.json`. No separate Key file or path setting is required.

The example enables external requests with two `0.5` thresholds and `5000 ms` timeouts. The Key is stored locally as plaintext. Status and help do not expose it. Clearing records retains model connection settings, including the API key.

Missing credentials, timeouts, or invalid replies use Codex. To disable Sqwish, set `enabled` to `false`. Without Sqwish configuration, SkillPing uses Codex by default.

### Update and uninstall

For GitHub updates, run the [update commands](#upgrade), restart Codex, and open a new chat. For offline updates, extract the new package into the original installation folder, run both `codex plugin add` commands, and restart.

Uninstalling keeps local records and settings. To delete records, first ask Codex to "Clear all SkillPing data," then confirm in a separate reply when prompted. Clearing keeps switches, pace, and model connection settings, including the API key. Delete independent backups separately.

Quit Codex Desktop and running Codex CLI sessions, then run the [uninstall commands](#uninstall). Expiry cleanup stops after uninstalling.
