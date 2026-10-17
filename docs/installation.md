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

### Uninstall

Uninstalling removes the plugins and marketplace registration. It keeps SkillPing's local records and settings, and stops expiry cleanup.

To delete records too, first ask Codex to “Clear all SkillPing data,” then confirm in a separate reply when prompted. Finish clearing before uninstalling. Clearing keeps your switches and pace; manage independent backups separately.

Fully quit Codex, including any running Codex CLI sessions. Open PowerShell and run:

~~~powershell
codex plugin remove skillping@skillping
codex plugin remove skillping-runtime@skillping
codex plugin marketplace remove skillping
~~~
