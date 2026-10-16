---
name: skillping
description: Use when the user opens SkillPing, asks about its status or records, or wants to change recommendation pace, detection, recommendations or feedback on a kind of work.
---

# SkillPing

Use the `control` tool from the `skillping` MCP server for these commands:

For help-only requests, use `skillping-help` and its read-only `help` command. Do not run `status` or change settings just to explain usage or pace conditions.

For an explicit SkillPing open, status request, or other requested control, call `status` first. If and only if it returns `onboarding:"first_use"`, briefly introduce the product: SkillPing finds reusable Skills from recurring work; detection and recommendations default on, accepted requests are stored locally as plaintext for 30 days, and the user can pause or clear records. Describe actual switches from the response. Execute any requested control in the same turn. Later status calls need no introduction; a privacy or usage question alone needs no control call.

User-facing replies describe the requested result in ordinary language: what changed, the current state and any action the user needs to take. Use SkillPing consistently. Translate Workflow, Dispatch and internal status names into the work or recommendation they refer to. Internal routing, technical validation, development history and unperformed checks stay out of normal replies. Show diagnostic codes only for an explicit troubleshooting request. Runtime messages and summaries establish what happened; explain them without copying implementation vocabulary.

| User request | `command` |
|---|---|
| 查看状态 | `status` |
| 调成积极档 / 均衡档 / 谨慎档 | `set_recommendation_pace` with `pace:"eager"` / `"balanced"` / `"cautious"` |
| 开启检测 | `enable_detection` |
| 关闭检测 | `disable_detection` |
| 开启推荐 | `enable_recommendations` |
| 关闭推荐 | `disable_recommendations` |
| 这次不要记录 | `skip_turn` with the real current `session_id` and `turn_id` |
| 先不用这个 | `cooldown_workflow` with the real current `session_id` |
| 以后别推荐这类 | `suppress_workflow` with the real current `session_id` |
| 已在使用 / 已有 Skill 可以处理这个需求（方向明确） | `cover_workflow` with the real current `session_id` |
| 现有 Skill 不够用 / 这个方向的覆盖不足（方向明确） | `reopen_covered_workflow` with the real current `session_id` |
| 这几个不是同一类 / 判断错了 | `invalidate_workflow` with the real current `session_id` |
| 清空 SkillPing 全部数据 | `request_clear` with the real current `session_id` |
| 确认清空 | `confirm_clear` with the same real `session_id` and the preceding Runtime `confirmation_token`, only in the confirmation flow below |

Full clear is a two-message control flow. On an explicit initial request to clear all SkillPing data, call `{"command":"request_clear","session_id":<real current Task ID>}`. Its `confirmation_required` result supplies an opaque `confirmation_token` and `expires_at` (Unix milliseconds). Explain that all SkillPing records and topic feedback will be deleted, switch and pace settings will be kept, and the application cannot restore deleted records. Any independent backups need separate deletion. Then ask for an explicit second “确认清空”. Even an initial request claiming prior approval starts here.

Only after that separate explicit confirmation in this same Task/control flow, call `{"command":"confirm_clear","session_id":<same real Task ID>,"confirmation_token":<exact preceding token>}`. Keep the token internal. Missing Task identity, missing token, another Task's token, or no preceding request means no confirmation call: explain the missing current confirmation and ask the user to restart the all-data request. Never invent an ID/token or reuse one after success, failure, expiry, or restart. Runtime validates the Task, expiry, generation and one-use token; `needs_context` means no deletion was authorized. Report `CLEAR_FAILED` truthfully: deletion may be partial and data operations are paused; do not claim either full success or preservation. A retry needs a fresh request and separate confirmation.

Generic “删除/清理一下旧记录” is not consent to clear all data: clarify scope without a clear call. A privacy question alone performs no mutation. Ordinary records expire after30days from their original occurrence, including imported history; physical cleanup runs opportunistically. Do not promise SSD physical-sector erasure, reliable clearing of all managed memory, or recovery through SkillPing after a successful clear.

For Workflow feedback, include one real `dispatch_id` from the current Task's internal SkillPing Dispatch context when available, or one real `workflow_id` already present in the current Task or explicitly supplied by the user. Otherwise omit both references and let Runtime proceed only if that Task has one unique relevant Workflow. Never use a global latest Workflow, invent an ID, expose internal IDs, or retry with a guess. If Runtime returns `needs_context`, ask the user to describe the intended work in plain language and report no change; do not show internal IDs or invent Workflow names in the question.

`skip_turn` changes no persistent preference. If the real current IDs are unavailable, make no fabricated call; the Hook's hard filter still excludes the opt-out Prompt itself. Cooldown lasts30days, permanent suppression still permits later observation, and invalidation does not split, move, or delete prior evidence.

覆盖反馈是用户自述，不判断 Skill 是否真的适合该方向。`cover_workflow` 只暂停唯一定位方向的自动推荐，保留其 global/project 作用域，不扩展到其他方向。`reopen_covered_workflow` 只解除该方向的 covered 原因，不清除用户拒绝、冷却、归类失效、重试或每轮派发限制；普通工作再次出现也不撤销限制。已有用户拒绝比覆盖更强。依据 Runtime 的结果，用日常语言说明实际变化：没有 covered 状态或已有永久拒绝时，不声称已恢复推荐。

“结果不适用”本身不表示归类错误，不自动调用 `invalidate_workflow`。若用户明确说现有 Skill 的覆盖不足，可按上表恢复对应 covered 状态；目标或意图不唯一时只问必要的澄清，不猜测修改历史。主动要求找 Skill 时走现有 `find-skills` 明确搜索流程，不调用新的 SkillPing 搜索接口，也不清除本方向或其他方向的长期限制。该明确搜索请求无需为此先恢复覆盖；此处仅控制自动推荐。覆盖与恢复反馈本身使用 control，不记为独立工作。

For status, show returned detection and recommendation switches, the recommendation pace (`eager` = 积极, `balanced` = 均衡, `cautious` = 谨慎), health in plain language and record counts. Import state is relevant only when the user asks about an import. Pace defaults to balanced and changes only when requested. Pace changes and full clear preserve the other settings as specified above. Never expose raw exceptions, paths, internal IDs or log contents. For a switch or pace change, explain the returned result and any updated summary. A cleanup failure can leave a switch persisted off: report the actual switch state and incomplete operation, without claiming either a full success or an unchanged setting unless supported.

Collect evidence from new work. Do not offer history import or read earlier conversations, transcripts or logs as a fallback.

Do not treat ordinary language as a control unless it clearly requests one row above. Perform only the requested control after the status check when one is required. This Skill manages SkillPing; explicit requests to find other Skills follow the existing find-skills guide.
