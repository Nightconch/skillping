<div align="center">
  <img src="docs/assets/skillping-mark.svg" width="80" height="80" alt="SkillPing">
  <h1>SkillPing</h1>
  <p><strong>Find the right Skill for work you do often.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Windows-Preview-475569?style=flat-square&amp;labelColor=1e293b" alt="Windows preview">
    <img src="https://img.shields.io/badge/Node.js-24%2B-41785a?style=flat-square&amp;labelColor=1e293b" alt="Node.js 24+">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-41785a?style=flat-square&amp;labelColor=1e293b" alt="MIT license"></a>
  </p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="#example">See an example</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#controls">Help</a> ·
    <a href="#privacy">Privacy</a>
  </p>
</div>

---

SkillPing helps you discover useful Skills through your everyday Codex tasks. Keep cleaning spreadsheets, organizing meeting notes and reviewing code. When the same kind of work recurs, it finds relevant Skills and explains their strengths and limits so you can choose.

- Discover opportunities through the work you already do, saving repeated searches.
- Compare reasons and limitations in one place, with installed Skills clearly marked.
- Choose a recommendation pace, or pause recording and recommendations separately.

<a id="example"></a>
## See it in action

*An illustrative example.*

| You ask Codex | What SkillPing does |
| --- | --- |
| “Turn these meeting notes into decisions and action items.” | Notices the reusable method in the work |
| “Group the action items by owner; keep the rest as it is.” | Treats it as the same task, without another count |
| “Here are notes from another meeting next week. Organize these too.” | Adds evidence to decide whether a Skill would help |

Choose your recommendation pace: **Eager** to discover opportunities sooner, **Balanced (default)** to gather more evidence, or **Cautious** to wait for a clearer recurring pattern. Enter `$skillping-help` to see each pace's conditions and change it whenever you like.

Each recommendation includes up to 3 choices, ranked by suitability. You decide whether to install or use them.

<a id="quick-start"></a>
<a id="install"></a>
## Quick start

**Requires:** Windows, Node.js 24+ with npm, and a Codex host supporting native plugin Hooks.

### 1. Install

#### From GitHub

Open PowerShell and run:

```powershell
codex plugin marketplace add Nightconch/skillping
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
```

#### From an offline package

Extract the complete SkillPing package to a folder you will keep. Open PowerShell in its root and run:

```powershell
codex plugin marketplace add .
codex plugin add skillping-runtime@skillping
codex plugin add skillping@skillping
```

The package includes everything needed to run; no build step is required. [Detailed installation steps](docs/installation.md)

### 2. Open help

Review and trust the Hook when Codex prompts you, restart Codex Desktop, then open a new chat and enter:

```text
$skillping-help
```

See your current pace and available controls. Detection and recommendations are on by default; viewing help does not change settings.

### 3. Keep working

Give Codex your tasks as usual. SkillPing looks for suitable Skills when a recurring pattern emerges. Installation and use stay your choice.

<a id="controls"></a>
## Help and settings

Enter this in Codex:

```text
$skillping-help
```

Say “Set SkillPing to eager,” “Turn off SkillPing recommendations,” or “Don't record this request.” Help explains pace conditions, recording, topic recommendations, grouping feedback and clearing records.

<a id="privacy"></a>
## Your records, your control

- Eligible request text and work summaries are stored locally as plaintext for 30 days, with expired records cleaned up during operation.
- Pause detection whenever you like, or clear records after a separate confirmation. Clearing keeps your switches and pace; manage any independent backups separately.
- Interpretation uses Codex model usage. Skill searches need shell and internet access through Codex. Recommendations do not automatically install or run a Skill.

---

[MIT license](LICENSE) · [Third-party notices](plugins/skillping-runtime/THIRD_PARTY_NOTICES.md)
