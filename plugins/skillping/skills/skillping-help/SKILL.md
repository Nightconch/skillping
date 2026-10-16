---
name: skillping-help
description: Use when the user invokes skillping-help or asks how to use SkillPing, about its recommendation paces, their trigger conditions, or available controls.
---

# SkillPing Help

Call the `control` tool from `skillping` with `{"command":"help"}`. This reads help and the current pace without onboarding or changing settings. A help-only request needs no `status`, switch, feedback or clear call.

Write a concise product guide in the user's language. Use this structure, localizing the headings and examples:

1. **SkillPing**: one sentence explaining that it notices recurring work and finds reusable Skills, with reasons and limitations so the user can choose. Follow with the current recommendation pace, using the matching label from `help.paces`.
2. **推荐节奏**: a three-row table with pace, when it is useful, and its trigger conditions. Use the returned `window_days`, `min_occurrences` and `min_chats`; balanced is the default. Follow with one sentence: independent tasks add evidence; formatting edits and retries of the same work do not add another count. The counts allow a suitability check, not a guaranteed recommendation.
3. **直接说，就能调整**: show the table below. These are examples to explain the controls; execute an action only when the user actually requests it.

| 想做什么 | 可以这样说 |
| --- | --- |
| 查看开关、档位和记录情况 | 查看 SkillPing 状态 |
| 调整推荐节奏 | 把 SkillPing 调成积极档 / 均衡档 / 谨慎档 |
| 暂停或恢复记录 | 关闭 SkillPing 检测 / 开启 SkillPing 检测 |
| 暂停或恢复推荐 | 关闭 SkillPing 推荐 / 开启 SkillPing 推荐 |
| 跳过这次请求 | 这次不要记录 |
| 暂停这类推荐 30 天 | 先不用这个 |
| 停止这类推荐 | 以后别推荐这类 |
| 反馈归类有误 | 这几个不是同一类 |
| 已有 Skill 够用，或不再够用 | 已有 Skill 能处理这类工作 / 现有 Skill 不够用了 |
| 清空全部记录 | 清空 SkillPing 全部数据 |

End with one short data note: accepted requests are stored locally as plaintext; clearing needs a separate confirmation. Normal help ends there. Development history, unavailable features, internal terminology, IDs, error codes, backup procedures and a report of checks not performed belong outside this guide. Explain a relevant boundary when the user asks about that operation, privacy or troubleshooting.

If help returns `unavailable`, say the current pace could not be read once, then show qualitative pace descriptions in a two-column table and explain the controls. Include numerical conditions only when supplied by Runtime; do not invent a current pace or successful setting change. Diagnostic details are for an explicit troubleshooting request.

If the user also explicitly requests an action, use the existing `skillping` control Skill for that action and its safeguards. Pace IDs are `eager` (积极), `balanced` (均衡), and `cautious` (谨慎). Disabling recommendations keeps detection separate; changing pace preserves records and existing topic feedback. For topic feedback, ask which work they mean when needed, using ordinary language. `invalidate_workflow` marks a grouping as wrong but does not reorganize old records. `reopen_covered_workflow` removes only the pause caused by existing Skill coverage, preserving a separate refusal or cooldown. Help and pace changes do not search or replay old requests. These are internal routing rules, not extra help paragraphs.
