<div align="center">
  <img src="docs/assets/skillping-mark.svg" width="80" height="80" alt="SkillPing">
  <h1>SkillPing</h1>
  <p><strong>照常用 Codex，有合适的 Skill 才提醒你。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Windows-Preview-475569?style=flat-square&amp;labelColor=1e293b" alt="Windows preview">
    <img src="https://img.shields.io/badge/Node.js-24%2B-41785a?style=flat-square&amp;labelColor=1e293b" alt="Node.js 24+">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-41785a?style=flat-square&amp;labelColor=1e293b" alt="MIT license"></a>
  </p>
  <p><a href="README.md">English</a> · <strong>简体中文</strong></p>
  <p>
    <a href="#quick-start">快速开始</a> ·
    <a href="#example">工作示例</a> ·
    <a href="#api-key">配置 Key</a> ·
    <a href="#privacy">隐私与费用</a>
  </p>
</div>

---

SkillPing 是一个 Codex 插件。它从你的日常任务中识别反复出现的工作，寻找合适的 Skill，并说明推荐理由和使用限制。

- **日常几乎无感。** 无需专门打开 SkillPing，也不用额外描述需求。平时不在回答里汇报检测过程，找到合适的 Skill 时，才在任务回答后补上推荐。
- **决策开销小，响应快。** 可选接入 Sqwish `kettei-fat`。一次实测的 855 次真实接口请求，单次响应中位数约 **0.55 秒**，接口费用合计约 **0.022 美元**。

以上耗时和费用统计于 2026-10-21，仅包含 Sqwish 决策请求。工作提取、复核和搜索仍使用 Codex。

当前实时匹配会在预算内分批扫描全部合格 Workflow，最终最多归属一个。正命中可能需要 Codex 证据终审，上述旧实验没有测量完整扫描的开销。具体行为见 [分批匹配协议与限制](docs/workflow-matching.md)。

## 为什么需要 SkillPing？

清洗表格、整理会议记录、审查代码，这些事可能每周都要做。合适的 Skill 能省去反复交代方法的功夫，但你得先知道该搜什么、哪个值得用。

装上 SkillPing 后，继续把任务交给 Codex。它会积累同类工作的线索，在值得推荐时搜索 Skill，把已安装和未安装的候选一起列给你比较。

<a id="example"></a>
## 它怎样发现你需要的 Skill

下面是一轮代码评审测试中的真实请求节选：

> 帮我看看这个示例仓库分支，按它和 main 的共同祖先算全部改动。基点先确认能用，diff 也别是空的；仓库规范和最初需求都找来。让两个人各看各的，一个盯规范和好不好维护，一个盯漏做、做错、做多了没。

SkillPing 识别出这项工作需要确认 Git 比较范围，再分别检查代码规范和原始需求。完成候选查找和内容比较后，隔离回放实际返回了以下推荐，三项在测试时均已安装：

| Skill | 适合的理由 | 明显限制 |
| --- | --- | --- |
| [code-review](https://skills.sh/mattpocock/skills/code-review)（已安装） | 先确认 Git 基点和有效改动，再分别审查仓库规范与需求实现，符合这次评审的完整流程。 | 需要有效的 Git 比较起点；没有需求说明时会跳过需求审查。 |
| [superpowers:requesting-code-review](https://skills.sh/obra/superpowers/requesting-code-review)（已安装） | 把改动范围、实现说明和需求交给独立评审者，适合补充一次不受当前对话影响的检查。 | 默认由一位评审者给出合并报告，需要按本任务要求保留两条独立审查线。 |
| [pstack:interrogate](https://github.com/ericlitman/open-pstack)（已安装） | 组织独立评审检查改动和意图，查找遗漏、正确性与结构问题，并筛掉依据不足的意见。 | 默认汇总为综合结论，需要按本任务要求分别保留规范与需求报告。 |

每次最多推荐 3 项。你可以使用已有 Skill，也可以决定是否安装新候选；不合适时，直接告诉 SkillPing“先不用这个”或“以后别推荐这类”。

<a id="quick-start"></a>
<a id="安装"></a>
## 快速开始

需要 Windows、Node.js 24+（含 npm），以及支持原生插件 Hook 的 Codex。

在 Codex 中发送：

```text
帮我安装 SkillPing：https://github.com/Nightconch/skillping
```

也可以在 PowerShell 中安装：

```powershell
irm https://raw.githubusercontent.com/Nightconch/skillping/main/install.ps1 | iex
```

安装时会提示填写 [Sqwish Key](#api-key)，输入隐藏，直接回车可跳过。

按 Codex 提示审阅并信任 Hook，重启 Codex Desktop，在新对话中输入：

```text
$skillping-help
```

检测和推荐默认开启，推荐节奏为均衡。接下来照常工作即可。

也可以[下载离线安装包](https://github.com/Nightconch/skillping/releases/latest)，按[安装指南](docs/installation.md)操作。

<a id="api-key"></a>
<a id="decision-model"></a>
### 配置 Key（可选）

**不配置 Key 也能正常使用**，前置工作判断和工作流匹配由 Codex 完成。配置 **Sqwish `kettei-fat`** 后，这两步交给轻量模型，减少 Codex 的判断开销，响应快、费用低，实测数据见上文。Sqwish 单独计费。

先到 [Sqwish 控制台](https://console.sqwish.ai/)注册或登录，开通 API 访问后创建 Key。

可以在 PowerShell 安装时填写 Key，也可以打开 Runtime 的本机 `config.json`（[查找位置](docs/installation.md#runtime-config)），将其中的 `decision_model` 配置为：

```json
{
  "enabled": true,
  "allow_external": true,
  "model": "kettei-fat",
  "api_key": "",
  "existence": { "threshold": 0.5 },
  "matching": { "threshold": 0.5 }
}
```

把 `api_key` 的空字符串替换为你的 Key，保存后重启 Codex。其他配置保持原样。

<a id="controls"></a>
## 用对话调整推荐

直接在 Codex 中说：

| 你想做什么 | 可以这样说 |
| --- | --- |
| 查看状态 | 查看 SkillPing 状态 |
| 更早收到推荐 | 把 SkillPing 调成积极档 |
| 暂停推荐 | 关闭 SkillPing 推荐 |
| 跳过当前请求 | 这次不要记录 |
| 不再推荐某类工作 | 以后别推荐这类 |
| 删除记录 | 清空 SkillPing 全部数据 |

清空记录需要再次确认。输入 `$skillping-help` 可查看全部操作。

<a id="privacy"></a>
## 隐私与费用

- 符合条件的请求正文和工作摘要以明文保存在本机，保留 30 天。SkillPing 运行时清理过期记录。
- 可以分别关闭检测和推荐，也可以确认后清空记录。清空保留开关、推荐档位和模型连接设置，包括 API Key。
- 工作提取、复核和推荐使用 Codex 模型额度。搜索 Skill 需要 Codex 能执行命令并联网。
- 启用 Sqwish 后，前置判断会发送当前请求正文，匹配会发送提取后的工作、能力描述和候选工作流信息。Sqwish 单独计费。

## 更新与卸载

按[管理说明](docs/installation.md#upgrade)更新或卸载插件。卸载保留本机记录；需要删除记录时，先在 Codex 中清空数据。

## 从源码开发

在 `plugins/skillping-runtime` 目录运行：

```powershell
npm ci
npm test
npm run smoke
npm run build:marketplace
```

`plugins/` 保存源码，`distribution/` 保存预构建插件。修改源码后，重新生成并提交 `distribution/`。

---

[MIT 许可证](LICENSE) · [第三方许可声明](plugins/skillping-runtime/THIRD_PARTY_NOTICES.md)
