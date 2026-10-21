# SkillPing 安装、更新与卸载

需要 Windows、Node.js 24+（含 npm），以及支持原生插件 Hook 的 Codex。安装内容已预构建，无需编译。

## 从 GitHub 安装

打开 PowerShell，依次运行：

~~~powershell
codex plugin marketplace add Nightconch/skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
~~~

按提示审阅并信任 Hook，重启 Codex Desktop，然后在新对话中输入：

~~~text
$skillping-help
~~~

查看当前推荐档位和常用操作。检测与推荐默认开启。

## 从离线安装包安装

[下载最新离线安装包](https://github.com/Nightconch/skillping/releases/latest)，在 Assets 中选择 `skillping-<版本号>-windows.zip`。完整解压到准备长期保留的目录，在解压后的根目录打开 PowerShell：

~~~powershell
codex plugin marketplace add .
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
~~~

安装后按上面的步骤信任 Hook、重启并打开帮助。保留完整解压目录。

<a id="decision-model"></a>
## 可选启用 Sqwish 判断

默认使用 Codex 提取工作、匹配与复核，不要求 Sqwish Key。Sqwish `kettei-fat` 是可选的前置判断与匹配服务，需要联网并单独计费。

开启后，前置判断会向 Sqwish 发送当前请求正文；匹配会发送提取后的工作、能力描述和候选工作流原型。允许这些传输后，再按下面步骤配置。Key 缺失、超时或响应无法采用时，会回退到 Codex。

### 1. 找到本机配置

先打开一次 `$skillping-help`，让 Runtime 初始化本机设置。配置文件是当前 Runtime 的 `PLUGIN_DATA/config.json`，不在仓库或 `distribution` 中。可在 PowerShell 列出包含 `decision_model` 的配置路径：

~~~powershell
$skillpingRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
Get-ChildItem -LiteralPath (Join-Path $skillpingRoot 'plugins\data') -Filter config.json -Recurse |
    Select-String -Pattern '"decision_model"' -List |
    Select-Object -ExpandProperty Path
~~~

如有多个结果，使用当前 SkillPing Runtime 对应的文件。不要批量修改其他插件的配置。完全退出 Codex，包括正在运行的 CLI 会话，再编辑配置。

### 2. 设置自己的 Key

在 PowerShell 中运行。输入内容不会显示，也不会作为命令正文写入历史：

~~~powershell
$skillpingKey = Read-Host 'Sqwish API key' -AsSecureString
$skillpingCredential = [System.Net.NetworkCredential]::new('', $skillpingKey)
[Environment]::SetEnvironmentVariable('SQWISH_API_KEY', $skillpingCredential.Password, 'User')
Remove-Variable skillpingKey, skillpingCredential
~~~

这会保存当前 Windows 用户的环境变量，不写入仓库。不要把 Key 填入 `config.json`、插件包或 README。正在运行的进程不会自动获得新环境变量。

### 3. 修改判断配置并重启

在前面找到的 `config.json` 中，把 `decision_model` 改为下面的对象，保留其他设置：

~~~json
{
  "enabled": true,
  "allow_external": true,
  "provider": "sqwish",
  "model": "kettei-fat",
  "precheck_timeout_ms": 5000,
  "match_timeout_ms": 5000,
  "existence": { "threshold": 0.5 },
  "matching": { "threshold": 0.5 }
}
~~~

这是已做过本地测试的可选配置。新安装默认 `enabled`、`allow_external` 为 `false`，两项阈值为空；不会自动授权外发。`0.5` 是本项目测试采用的阈值，不代表概率已经过统计校准。响应合法性仍会检查，但不要求模型版本编号。

重新启动 Codex。若桌面应用仍未读取新环境变量，注销并重新登录 Windows 后再打开。要关闭 Sqwish，将 `enabled` 或 `allow_external` 改为 `false`，退出并重启 Codex。

<a id="upgrade"></a>
## 更新 GitHub 安装的版本

~~~powershell
codex plugin marketplace upgrade skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
~~~

更新后重启 Codex Desktop，在新对话中打开帮助。离线安装请先将新安装包解压到新目录，再从其根目录按离线安装步骤操作。

<a id="uninstall"></a>
## 卸载

卸载会移除插件和安装源，保留 SkillPing 的本机记录与设置。卸载后不再执行到期清理。

如果也要删除记录，请先在 Codex 中说“清空 SkillPing 全部数据”，收到确认提示后，再单独回复“确认清空”。清空完成后再卸载。清空保留开关和档位；独立备份需自行处理。

完全退出 Codex（包括仍在运行的 Codex CLI 会话），再打开 PowerShell，依次运行：

~~~powershell
codex plugin remove skillping@skillping
codex plugin remove skillping-runtime@skillping
codex plugin marketplace remove skillping
~~~

## 安装后没有自动检测

在插件设置中确认 SkillPing 和 SkillPing Runtime 均已启用，并检查 Hook 信任、Node.js 版本及重启后的新对话是否生效。推荐搜索还需要 Codex 能执行命令并联网读取 Skill 说明。

## English

Run the GitHub installation commands above in PowerShell. For offline installation, extract the complete package to a permanent folder and run the offline commands from its root. Review and trust the Hook, restart Codex Desktop, then enter $skillping-help in a new chat. Detection and recommendations are on by default.

For GitHub updates, run the update commands above, restart Desktop and open a new chat. Both SkillPing and SkillPing Runtime must be enabled. Skill discovery also needs shell and internet access through Codex.

### Optional Sqwish setup

Codex handles the work by default. Sqwish is optional and billed separately. If you enable it, the initial decision sends the current request text to Sqwish; matching sends extracted work, capability descriptions, and candidate workflow prototypes. Missing credentials or unusable responses fall back to Codex.

The [setup section above](#decision-model) contains the shared PowerShell commands and JSON settings. Open help once to initialize the Runtime, locate its `PLUGIN_DATA/config.json`, and fully quit Codex. Set your own `SQWISH_API_KEY` in the Windows user environment using the hidden-input command. Replace only the `decision_model` object with the shown settings, then restart Codex. Sign out of Windows and sign in again if the desktop app still inherits the old environment. Never put the key in the repository or `config.json`.

The tested settings use `kettei-fat`, two `0.5` thresholds, and two `5000 ms` timeouts. Fresh installations leave external decisions disabled and thresholds unset. The threshold is a tested project setting, not a calibrated probability guarantee. To disable Sqwish, set `enabled` or `allow_external` to `false` and restart Codex.

### Uninstall

Uninstalling removes the plugins and marketplace registration. It keeps SkillPing's local records and settings, and stops expiry cleanup.

To delete records too, first ask Codex to “Clear all SkillPing data,” then confirm in a separate reply when prompted. Finish clearing before uninstalling. Clearing keeps your switches and pace; manage independent backups separately.

Fully quit Codex, including any running Codex CLI sessions. Open PowerShell and run:

~~~powershell
codex plugin remove skillping@skillping
codex plugin remove skillping-runtime@skillping
codex plugin marketplace remove skillping
~~~
