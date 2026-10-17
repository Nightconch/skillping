<div align="center">
  <img src="docs/assets/skillping-mark.svg" width="80" height="80" alt="SkillPing">
  <h1>SkillPing</h1>
  <p><strong>让常做的事，用上合适的 Skill。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Windows-Preview-475569?style=flat-square&amp;labelColor=1e293b" alt="Windows preview">
    <img src="https://img.shields.io/badge/Node.js-24%2B-41785a?style=flat-square&amp;labelColor=1e293b" alt="Node.js 24+">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-41785a?style=flat-square&amp;labelColor=1e293b" alt="MIT license"></a>
  </p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="#example">看一个例子</a> ·
    <a href="#quick-start">快速开始</a> ·
    <a href="#controls">使用帮助</a> ·
    <a href="#privacy">隐私说明</a>
  </p>
</div>

---

SkillPing 帮你从日常 Codex 任务中发现用得上的 Skill。照常清洗表格、整理会议记录、审查代码；同一类工作反复出现时，它会寻找合适的 Skill，说明推荐理由和使用限制，方便你选择。

- 根据你实际做的工作发现机会，省去反复找 Skill 的功夫。
- 把适合理由和主要限制放在一起，方便比较；已安装的 Skill 也会标明。
- 选择推荐节奏，也可以单独暂停记录或推荐。

<a id="example"></a>
## 看一个例子

*以下是使用示意。*

| 你在 Codex 中说 | SkillPing 会怎样处理 |
| --- | --- |
| “把这次会议记录整理成决定和待办。” | 留意这类工作的可复用方法 |
| “待办按负责人分组，其他内容不变。” | 继续同一次工作，不重复计数 |
| “这是下周另一场会议，也整理一下。” | 积累新线索，判断是否值得推荐 Skill |

你可以选择三种推荐节奏：**积极**，更早发现机会；**均衡（默认）**，积累足够线索再推荐；**谨慎**，等重复模式更明确时再推荐。输入 `$skillping-help`，查看各档条件并随时调整。

每次推荐最多 3 项，按适合程度排序。是否安装、是否使用，由你决定。

### 推荐长这样

反复整理会议记录时，你可能看到：

| Skill | 适合的理由 | 明显限制 |
| --- | --- | --- |
| [summarize-meeting](https://skills.sh/phuryn/pm-skills/summarize-meeting) | 从转写中分别提取决定、行动项和开放问题，方便整理会后小结。 | 默认模板较完整，发群时可精简；缺失信息仍需明确保留。 |
| [meeting-notes-and-actions](https://skills.sh/composio-community/awesome-codex-skills/meeting-notes-and-actions) | 提取决策、阻塞事项及任务的负责人和期限，并检查歧义。 | 包含补提截止日期的步骤；本任务中须跳过。 |

<a id="quick-start"></a>
<a id="安装"></a>
## 快速开始

**需要：** Windows、Node.js 24+（含 npm），以及支持原生插件 Hook 的 Codex。

### 1. 安装

#### 从 GitHub 安装

打开 PowerShell，依次运行：

```powershell
codex plugin marketplace add Nightconch/skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
```

#### 从离线安装包安装

[下载最新离线安装包](https://github.com/Nightconch/skillping/releases/latest)，在 Assets 中选择 `skillping-<版本号>-windows.zip`。完整解压到准备长期保留的目录，在解压后的根目录打开 PowerShell，依次运行：

```powershell
codex plugin marketplace add .
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
```

安装包已包含运行所需内容，无需编译。[详细安装步骤](docs/installation.md)

### 2. 打开帮助

按 Codex 提示审阅并信任 Hook，重启 Codex Desktop，在新对话中输入：

```text
$skillping-help
```

查看当前推荐档位和常用操作。检测与推荐默认开启，查看帮助不会改变设置。

### 3. 继续日常工作

正常把任务交给 Codex。形成重复模式后，SkillPing 会寻找合适的 Skill；安装和使用由你决定。

<a id="controls"></a>
## 使用帮助

在 Codex 中输入：

```text
$skillping-help
```

可以直接说“调成积极档”“关闭 SkillPing 推荐”或“这次不要记录”。Help 中提供各档条件，以及暂停记录、管理某类推荐、反馈归类和清空记录的方法。

更新或卸载，请看[安装与管理说明](docs/installation.md#upgrade)。

<a id="privacy"></a>
## 你的记录，由你控制

- 符合条件的请求正文和工作摘要以明文保存在本机，保留 30 天，到期后在运行时清理。
- 随时暂停检测，或确认后清空记录。清空保留开关和档位设置；如有独立备份，需单独管理。
- 判断会使用 Codex 模型额度；搜索 Skill 时需要 Codex 能执行命令并联网。推荐仅供选择，不会自动安装或执行。

---

[MIT 许可证](LICENSE) · [第三方许可声明](plugins/skillping-runtime/THIRD_PARTY_NOTICES.md)
