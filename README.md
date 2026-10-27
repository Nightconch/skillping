<div align="center">
  <img src="docs/assets/skillping-mark.svg" width="80" height="80" alt="SkillPing">
  <h1>SkillPing</h1>
  <p><strong>Keep using Codex. Hear from SkillPing when a Skill could help.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Windows-Preview-475569?style=flat-square&amp;labelColor=1e293b" alt="Windows preview">
    <img src="https://img.shields.io/badge/Node.js-24%2B-41785a?style=flat-square&amp;labelColor=1e293b" alt="Node.js 24+">
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-41785a?style=flat-square&amp;labelColor=1e293b" alt="MIT license"></a>
  </p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#example">Work example</a> ·
    <a href="#api-key">API key setup</a> ·
    <a href="#privacy">Privacy and costs</a>
  </p>
</div>

---

SkillPing is a Codex plugin that spots recurring work in your daily tasks, finds relevant Skills, and explains why they fit and where they fall short.

- **Stay focused on your work.** You do not need to open SkillPing or describe your needs separately. Routine detection stays out of your answers. Suitable recommendations appear after the task answer.
- **Low-cost, fast decisions.** Optional Sqwish `kettei-fat` integration handled **855 real API requests** in one test campaign, with a median response time of **0.55 seconds** and a total API charge of about **USD 0.022**.

These measurements are from 2026-10-21 and cover Sqwish decision requests only. Work extraction, review, and discovery still use Codex.

Current realtime matching scans all eligible Workflows in bounded batches and assigns at most one. Positive matches can require Codex evidence review. The earlier measurements do not measure this complete scan. See [the matching protocol and limits](docs/workflow-matching.md).

## Why SkillPing?

Cleaning spreadsheets, organizing meeting notes, and reviewing code often involve repeating the same instructions. A suitable Skill can save that effort, but finding one means knowing what to search for and which results to trust.

With SkillPing installed, keep giving Codex your tasks. It gathers evidence of recurring work and searches for Skills when a recommendation could help. Installed and uninstalled candidates appear together for comparison.

<a id="example"></a>
## How it finds a Skill you could use

Here is an excerpt from an actual code-review test request, translated from Chinese:

> Review this sample repository branch against its merge base with main. First check that the base is valid and the diff is not empty, and find the repository standards and original requirements. Have two people review independently: one checks standards and maintainability; the other checks omissions, mistakes, and unnecessary additions.

SkillPing identified the need to establish the Git comparison range, then check standards and requirements separately. After discovery and content comparison, the isolated replay returned these recommendations. All three were installed at the time of the test:

| Skill | Why it fits | Main limitation |
| --- | --- | --- |
| [code-review](https://skills.sh/mattpocock/skills/code-review) (installed) | Validates the Git base and diff, then separately reviews repository standards and requirement coverage. It covers the requested review workflow. | Needs a valid Git comparison point. Without a specification, it skips the requirements review. |
| [superpowers:requesting-code-review](https://skills.sh/obra/superpowers/requesting-code-review) (installed) | Gives an independent reviewer the change range, implementation summary, and requirements for a check without the current chat's history. | Defaults to one combined reviewer and report. Preserve separate standards and requirements reviews for this task. |
| [pstack:interrogate](https://github.com/ericlitman/open-pstack) (installed) | Uses independent inspections of the diff and intent to find omissions, correctness issues, and structural problems, while filtering weak findings. | Defaults to a synthesized verdict. Preserve the two separate reports required by this task. |

Each recommendation includes up to 3 candidates. Use an existing Skill or decide whether to install a new one. If a suggestion does not fit, tell SkillPing "Not this one for now" or "Don't recommend this kind of work again."

<a id="quick-start"></a>
<a id="install"></a>
## Quick start

You need Windows, Node.js 24+ with npm, and a Codex host supporting native plugin Hooks.

Tell Codex:

```text
Install SkillPing: https://github.com/Nightconch/skillping
```

Or install from PowerShell:

```powershell
irm https://raw.githubusercontent.com/Nightconch/skillping/main/install.ps1 | iex
```

The installer offers hidden [Sqwish Key input](#api-key). Press Enter to skip it.

Review and trust the Hook when Codex prompts you. Restart Codex Desktop, open a new chat, and enter:

```text
$skillping-help
```

Detection and recommendations are on by default, with a balanced pace. Continue your work as usual.

You can also [download an offline package](https://github.com/Nightconch/skillping/releases/latest) and follow the [installation guide](docs/installation.md).

<a id="api-key"></a>
<a id="decision-model"></a>
### Optional API key setup

**SkillPing works without an extra API key**, using Codex for the initial work check and workflow matching. Connecting **Sqwish `kettei-fat`** moves these decisions to a fast, low-cost model, reducing the decision work sent to Codex. See the measurements above; Sqwish usage is billed separately.

Register or sign in at the [Sqwish console](https://console.sqwish.ai/) and create an API key once API access is active.

Enter the Key during PowerShell installation, or open the Runtime's local `config.json` ([find its location](docs/installation.md#runtime-config)) and set `decision_model` to:

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

Replace the empty `api_key` with your Key, save, and restart Codex. Keep the other configuration unchanged.

<a id="controls"></a>
## Adjust recommendations in conversation

Tell Codex what you want:

| What you want | What to say |
| --- | --- |
| View status | Show SkillPing status |
| Get recommendations sooner | Set SkillPing to eager |
| Pause recommendations | Turn off SkillPing recommendations |
| Skip the current request | Don't record this request |
| Stop recommendations for a kind of work | Don't recommend this kind of work again |
| Delete records | Clear all SkillPing data |

Clearing records requires a separate confirmation. Enter `$skillping-help` for all available controls.

<a id="privacy"></a>
## Privacy and costs

- Eligible request text and work summaries are stored locally as plaintext for 30 days. SkillPing cleans up expired records while it runs.
- You can turn detection and recommendations off separately, or clear records after confirmation. Clearing keeps switches, recommendation pace, and model connection settings, including the API key.
- Work extraction, review, and recommendations use Codex model usage. Skill searches need shell and internet access through Codex.
- With Sqwish enabled, the initial check sends your current request text. Matching sends extracted work, capability descriptions, and candidate workflow information. Sqwish usage is billed separately.

## Update and uninstall

Follow the [management instructions](docs/installation.md#upgrade) to update or uninstall. Uninstalling keeps local records. To delete them, clear SkillPing data in Codex before uninstalling.

## Develop from source

Run these commands in `plugins/skillping-runtime`:

```powershell
npm ci
npm test
npm run smoke
npm run build:marketplace
```

`plugins/` contains source code; `distribution/` contains prebuilt plugins. Regenerate and commit `distribution/` when changing the source.

---

[MIT license](LICENSE) · [Third-party notices](plugins/skillping-runtime/THIRD_PARTY_NOTICES.md)
