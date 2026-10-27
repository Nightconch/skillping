import path from "node:path";
import type { Confidence, ObservationFingerprint, WorkflowPrototype } from "./domain.js";

export type WorkflowCandidate = {
  workflow_id: number;
  prototype: WorkflowPrototype;
  representatives: ObservationFingerprint[];
  scope_value?: string | null;
  state?: "forming" | "confirmed";
};

export type MatchDecision =
  | { kind: "new" }
  | { kind: "direct"; workflow_id: number; score: number }
  | { kind: "review"; workflow_ids: number[]; scores: number[] };

type MatchFingerprint = ObservationFingerprint & { confidence?: Confidence };

const WEIGHTS = { core_goal: 0.40, output: 0.25, essential_steps: 0.20, input_roles: 0.15 } as const;
const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const STOP_WORDS_V1 = new Set([
  "a", "an", "and", "as", "at", "based", "by", "each", "every", "for", "from", "given", "in", "into", "of",
  "on", "or", "per", "please", "the", "then", "through", "to", "using", "via", "with", "within",
  "把", "从", "并", "为", "与", "按", "中", "的", "了", "成", "依据", "根据", "请", "将", "就", "对", "基于", "进行", "作为", "以及", "然后", "每个",
]);
const concepts: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["summarize", ["汇总", "整理", "归纳", "总结", "概括", "提炼", "summarize", "synthesize", "summary"]],
  ["group", ["分类", "归类", "聚类", "分组", "归并", "合并", "group", "cluster", "classify", "consolidate"]],
  ["extract", ["提取", "读取", "定位", "derive", "extract", "capture"]],
  ["identify", ["识别", "标出", "标记", "找出", "发现", "identify", "detect", "find", "flag", "locate"]],
  ["normalize", ["归一化", "统一", "规范", "标准化", "校正", "对齐", "normalize", "standardize", "align", "clean"]],
  ["generate", ["生成", "编写", "撰写", "形成", "制作", "create", "write", "generate", "document"]],
  ["compare", ["比较", "对照", "匹配", "核对", "compare", "benchmark", "reconcile"]],
  ["rank", ["排序", "排列", "优先级", "分级", "rank", "prioritize", "order", "sequence"]],
  ["evaluate", ["评估", "估计", "分析", "衡量", "assess", "evaluate", "analyze", "estimate", "measure"]],
  ["plan", ["规划", "编排", "安排", "制定", "plan", "schedule", "arrange"]],
  ["review", ["检查", "审查", "验证", "复核", "test", "review", "audit", "check", "validate"]],
  ["report", ["报告", "备忘录", "简报", "report", "memo", "brief"]],
  ["table", ["表", "矩阵", "table", "matrix", "ledger", "register"]],
  ["list", ["清单", "队列", "列表", "list", "queue", "checklist", "backlog"]],
  ["chart", ["图表", "仪表盘", "chart", "dashboard", "visualization"]],
  ["notes", ["记录", "纪要", "笔记", "notes", "transcript", "records"]],
  ["data", ["数据", "读数", "指标", "values", "readings", "measurements", "metrics", "data"]],
  ["theme", ["主题", "模式", "theme", "themes", "pattern", "patterns"]],
  ["evidence", ["证据", "示例", "线索", "evidence", "examples", "signals", "observations"]],
  ["anomaly", ["异常", "偏离", "离群", "anomaly", "unusual", "outlier"]],
  ["feedback", ["反馈", "评论", "意见", "feedback", "reviews", "comments"]],
  ["support", ["支持", "客服", "咨询", "support", "service requests"]],
  ["faq", ["常见问题", "问答", "faq", "questions and answers"]],
  ["release", ["发布", "版本", "上线", "release", "changelog"]],
  ["change", ["变更", "改动", "更新", "change", "changes", "updates", "diff"]],
  ["survey", ["调查", "问卷", "survey", "questionnaire"]],
  ["bibliography", ["参考文献", "书目", "引用", "bibliography", "citation", "scholarly sources"]],
  ["missing", ["缺失", "缺口", "不完整", "missing", "incomplete", "gaps"]],
  ["risk", ["风险", "risk", "severity", "impact"]],
  ["schema", ["数据结构", "表结构", "字段定义", "schema", "field definitions", "column definitions"]],
  ["dictionary", ["数据字典", "字段字典", "data dictionary"]],
  ["accessibility", ["无障碍", "可访问性", "accessibility", "accessible"]],
  ["itinerary", ["行程", "旅行日程", "路线", "itinerary", "travel schedule"]],
  ["lesson", ["课程", "课堂", "教学", "lesson", "course", "learning"]],
  ["inventory", ["库存", "仓储", "inventory", "stock"]],
  ["restock", ["补货", "采购需求", "订货", "restock", "reorder", "purchase amount"]],
  ["incident", ["故障", "事故", "中断", "outage", "incident", "failure"]],
  ["timeline", ["时间线", "经过", "timeline", "event order"]],
  ["contract", ["合同", "协议", "条款", "contract", "agreement", "terms"]],
  ["difference", ["差异", "变化", "改动", "difference", "differences", "delta", "variance"]],
  ["interview", ["访谈", "采访", "interview", "discovery conversations"]],
  ["insight", ["洞察", "结论", "insight", "insights", "findings"]],
  ["experiment", ["实验", "研究", "study", "experiment", "assay"]],
  ["conclusion", ["结论", "conclusions", "results"]],
  ["budget", ["预算", "支出", "成本", "budget", "spending", "cost", "expense"]],
  ["api", ["接口", "api", "service interface"]],
  ["action", ["行动项", "待办", "后续动作", "action item", "action plan", "follow-ups", "commitments"]],
  ["defect", ["缺陷", "问题提交", "defect", "bug", "issue submissions"]],
  ["duplicate", ["重复", "去重", "duplicate", "deduplicated", "equivalent"]],
  ["capability", ["能力", "功能", "特征", "capability", "feature"]],
  ["competitor", ["竞品", "替代服务", "competitor", "alternative services"]],
  ["contact", ["联系人", "通讯录", "contact", "address book"]],
  ["migration", ["迁移", "migration", "import"]],
  ["literature", ["文献", "论文", "学术", "literature", "research papers"]],
  ["test-case", ["测试用例", "验收条件", "test case", "acceptance criteria", "verification cases"]],
  ["requirement", ["需求", "要求", "requirements", "criteria"]],
  ["decision", ["决定", "决策", "选择", "decision", "choices"]],
  ["responsibility", ["负责人", "责任", "owner", "responsibility", "roles"]],
  ["root-cause", ["根因", "因果链", "root cause", "causal chain"]],
  ["glossary", ["术语表", "glossary", "domain terms"]],
  ["segment", ["客群", "线索分组", "segment", "segments", "target groups"]],
  ["remediation", ["整改", "修复", "remediation", "corrective"]],
  ["highlight", ["精彩片段", "亮点", "highlight", "key moments"]],
  ["energy", ["能源", "能耗", "utility consumption", "energy"]],
  ["compliance", ["合规", "政策要求", "compliance", "policy requirements"]],
  ["weekly-study-report", ["每周实验报告", "weekly study report", "weekly lab report"]],
  ["feedback-theme-table", ["反馈主题表", "feedback theme table"]],
  ["candidate-screening-table", ["候选筛选表", "candidate screening table"]],
  ["decision-table", ["决策表", "decision table"]],
  ["energy-anomaly-report", ["能源异常报告", "energy anomaly report"]],
  ["compliance-gap-list", ["合规差距清单", "compliance gap list"]],
  ["invoice", ["票据", "发票", "invoice", "receipt"]],
  ["expense", ["费用", "支出", "金额", "expense", "cost", "spending"]],
  ["category", ["类别", "科目", "category", "categories"]],
  ["total", ["合计", "小计", "汇总", "total", "totals"]],
  ["question", ["问题", "疑问", "咨询", "question", "questions", "concern"]],
  ["answer", ["答案", "答复", "回答", "answer", "response"]],
  ["frequency", ["频率", "高频", "frequency", "frequent"]],
  ["merge", ["合并记录", "合并", "merge", "merged", "commit"]],
  ["user-impact", ["用户可见", "面向用户", "user visible", "user impact"]],
  ["compatibility", ["兼容", "升级", "breaking", "compatibility", "upgrade"]],
  ["visualize", ["可视化", "绘制", "图表", "visualize", "plot", "chart"]],
  ["encoding", ["编码", "选项值", "回答编码", "encoding", "values"]],
  ["distribution", ["分布", "比例", "统计", "distribution", "percentage", "statistics"]],
  ["format", ["格式", "样式", "style", "format"]],
  ["metadata", ["元数据", "字段", "metadata", "fields"]],
  ["probability", ["概率", "可能性", "likelihood", "probability"]],
  ["mitigation", ["缓解", "处置", "响应", "mitigation", "response"]],
  ["field", ["字段", "列", "名称", "field", "column", "name"]],
  ["type", ["类型", "type"]],
  ["meaning", ["含义", "释义", "meaning", "description"]],
  ["constraint", ["约束", "限制", "可空", "constraint", "nullable", "restriction"]],
  ["keyboard", ["键盘", "焦点", "keyboard", "focus"]],
  ["semantic-label", ["语义标签", "控件名称", "semantics", "labels", "control names"]],
  ["severity", ["严重度", "分级", "severity", "priority"]],
  ["preference", ["偏好", "愿望", "preference", "desired"]],
  ["place", ["地点", "活动", "place", "activity"]],
  ["time-window", ["时段", "时间限制", "开放时间", "time", "window"]],
  ["route", ["路线", "地理顺序", "route", "geographic order"]],
  ["travel-buffer", ["交通时间", "移动缓冲", "travel time", "travel buffer"]],
  ["goal", ["目标", "知识点", "goal", "objective"]],
  ["activity", ["活动", "练习", "activity", "exercise"]],
  ["assessment", ["评估环节", "理解检查", "考核", "assessment", "knowledge check"]],
  ["turnover", ["周转", "消耗速度", "出库趋势", "turnover", "consumption rate"]],
  ["shortage", ["缺货", "低库存", "shortage", "low stock"]],
  ["quantity", ["数量", "订货量", "采购数量", "quantity", "amount"]],
  ["event", ["事件", "告警", "部署记录", "event", "events", "alert"]],
  ["time-order", ["时间顺序", "事件时间", "校准时间", "chronology", "time order"]],
  ["cause", ["因果", "原因", "症状", "cause", "causal", "symptom", "driver"]],
  ["key-point", ["关键", "重要节点", "转折", "key point", "important node"]],
  ["section", ["章节", "条款", "section", "clause"]],
  ["review-risk", ["审阅风险", "需确认", "review risk", "needs review"]],
  ["conversation", ["讨论", "会话", "conversation", "session"]],
  ["measurement", ["测量值", "观测", "measurement", "observation", "reading", "value"]],
  ["calculate", ["计算", "推导", "derive", "calculate", "compute"]],
  ["forecast", ["预测", "计划", "forecast", "planned"]],
  ["actual", ["实际", "账本", "actual", "ledger"]],
  ["driver", ["驱动", "主要原因", "driver", "material change"]],
  ["interface-change", ["接口变更", "契约变化", "schema changes", "interface changes", "contract changes"]],
  ["next-step", ["下一步", "后续", "follow up", "next step"]],
  ["dimension", ["维度", "评价轴", "dimension", "axis"]],
  ["gap", ["差距", "缺口", "gap", "gaps", "difference"]],
  ["contact-field", ["联系人字段", "通讯录记录", "contact field", "address book record"]],
  ["scenario", ["场景", "流程", "scenario", "flow"]],
  ["boundary", ["边界", "边界条件", "edge case", "boundary condition"]],
  ["expected-result", ["预期结果", "expected result", "expected outcome"]],
  ["sprint", ["迭代", "sprint"]],
  ["story", ["需求条目", "用户故事", "user story", "story backlog", "backlog 条目"]],
  ["acceptance", ["验收条件", "acceptance criteria"]],
  ["dependency", ["依赖", "阻塞", "dependency", "blocker"]],
  ["log", ["日志", "错误记录", "log", "logs"]],
  ["error", ["错误", "异常事件", "error", "failure"]],
  ["kpi", ["kpi", "关键指标"]],
  ["trend", ["趋势", "波动", "显著变化", "trend", "shift", "movement"]],
  ["commentary", ["说明", "注释", "commentary", "notes"]],
  ["bilingual", ["双语", "中英文", "bilingual"]],
  ["translation-term", ["译法", "翻译", "translation", "source term"]],
  ["usage-context", ["语境", "用例", "usage", "context"]],
  ["lead", ["线索", "潜在客户", "lead", "leads", "customer"]],
  ["attribute", ["属性", "字段", "attribute", "attributes"]],
  ["message", ["触达", "传播", "message", "messaging"]],
  ["affected", ["影响范围", "受影响", "affected", "changed areas"]],
  ["verification", ["验证项", "检查项", "verification", "test item"]],
  ["deployment", ["部署", "上线", "发布", "deployment", "rollout"]],
  ["finding", ["发现", "检查问题", "finding", "findings", "issue"]],
  ["corrective-task", ["整改项", "修复任务", "corrective task", "remediation item"]],
  ["clip", ["片段", "clip"]],
  ["moment", ["时刻", "片段", "moment"]],
  ["timestamp", ["时间区间", "时间戳", "timestamp", "time range"]],
  ["slide", ["幻灯片", "洞察 slides", "insight deck", "presentation"]],
  ["narrative", ["叙事", "组织 deck", "narrative", "deck flow"]],
  ["candidate", ["候选", "申请", "candidate", "application"]],
  ["rubric", ["职位要求", "评估标准", "rubric", "evaluation criteria"]],
  ["experience", ["经历", "经验", "experience"]],
  ["baseline", ["基线", "baseline"]],
  ["obligation", ["义务", "要求", "obligation", "requirement"]],
  ["practice", ["做法", "控制", "practice", "control"]],
  ["meeting", ["会议", "讨论", "计划会", "workshop", "planning session", "meeting"]],
  ["deadline", ["截止", "时间要求", "due condition", "deadline"]],
  ["release-note-work", ["发布说明", "版本说明", "release notes", "changelog"]],
  ["survey-visualization", ["调查数据", "问卷统计", "调查结果图表", "survey statistics", "survey chart"]],
  ["citation-cleanup", ["规范参考文献", "整理书目", "clean bibliography", "normalize citations"]],
  ["risk-register", ["风险清单", "风险事项", "风险登记", "risk register", "risk list"]],
  ["data-dictionary-work", ["字段字典", "数据字典", "数据说明", "data dictionary", "field documentation"]],
  ["accessibility-audit", ["无障碍问题", "可访问性", "accessibility barriers", "accessibility audit"]],
  ["lesson-plan", ["课程教案", "课堂方案", "课程结构", "设计一节课程", "lesson plan", "course plan"]],
  ["restock-plan", ["补货建议", "补货计划", "补货方案", "采购需求", "restock plan", "reorder quantity"]],
  ["incident-timeline-work", ["故障时间线", "中断经过", "事故时间线", "incident timeline", "outage timeline"]],
  ["contract-diff-work", ["合同条款", "协议版本", "条款差异", "contract terms", "agreement versions"]],
  ["research-conversation", ["访谈", "采访", "discovery conversations", "customer conversations", "research interviews"]],
  ["recurring-insight", ["重复洞察", "主要模式", "recurring insights", "recurring themes"]],
  ["lab-report-work", ["实验读数", "测量结果", "实验报告", "study report", "lab report", "measured results"]],
  ["budget-variance-work", ["预算差异", "计划与实际成本", "budget variance", "planned versus actual costs"]],
  ["api-changelog-work", ["api changelog", "service interface updates", "接口更新", "接口变更"]],
  ["meeting-action-work", ["行动计划", "可执行后续", "action plan", "executable follow ups"]],
  ["defect-dedup-work", ["重复缺陷", "问题提交", "duplicate defect", "repeated issue submissions"]],
  ["capability-comparison", ["竞品能力", "替代服务", "competitor capabilities", "alternative services by feature"]],
  ["contact-cleanup", ["联系人数据", "通讯录记录", "contact dataset", "address book records"]],
  ["literature-synthesis-work", ["研究论文", "学术来源", "research papers", "scholarly sources"]],
  ["research-topic", ["研究问题", "主题提示", "research question", "topic prompt", "around a question", "for a topic"]],
  ["requirements-to-tests", ["验收条件", "行为要求", "acceptance criteria", "behavior requirements"]],
  ["sprint-brief-work", ["sprint brief", "sprint 简报", "迭代简报"]],
  ["incident-root-cause-work", ["根因备忘录", "故障 root cause", "root cause memo", "root cause"]],
  ["kpi-commentary-work", ["kpi dashboard", "仪表盘 kpi", "dashboard commentary", "趋势说明"]],
  ["bilingual-glossary-work", ["双语术语表", "中英文对应", "bilingual glossary"]],
  ["lead-segmentation-work", ["划分 leads", "outreach 客群", "lead segmentation", "outreach segments"]],
  ["release-checklist-work", ["release checklist", "上线 checklist", "发布检查清单"]],
  ["remediation-backlog-work", ["remediation backlog", "修复 backlog", "整改 backlog"]],
  ["highlight-clips-work", ["highlight clips", "转写中的 highlights", "精彩片段"]],
  ["survey-insight-deck", ["insight deck", "insights presentation", "洞察 slides"]],
  ["candidate-screening-work", ["候选材料", "application summaries", "候选筛选", "candidate screening"]],
  ["meeting-decision-work", ["会议纪要整理决策", "meeting notes", "decision table", "决策表"]],
  ["energy-anomaly-work", ["能源用量", "utility consumption", "能源异常", "energy anomaly"]],
  ["policy-compliance-work", ["政策要求", "policy requirements", "合规差距", "compliance gap"]],
  ["organize-findings", ["group findings", "organize themes", "整理发现", "组织主题"]],
  ["contrast-evidence", ["compare evidence", "contrast conclusions", "对比证据", "比较结论"]],
  ["open-question-gap", ["open questions", "evidence gaps", "开放问题", "证据缺口"]],
  ["article-source", ["paper abstracts", "article notes", "论文摘要", "文章笔记"]],
  ["release-impact-warning", ["用户可见变化", "面向用户的描述", "兼容提醒", "升级注意事项", "user visible change", "upgrade guidance"]],
  ["accessibility-review-work", ["检查页面无障碍", "审查交互界面", "review interface accessibility", "check accessibility"]],
  ["inventory-demand-work", ["库存并提出补货", "库存周转生成采购", "inventory restock", "inventory turnover"]],
  ["measured-study-report", ["experimental readings", "measured results", "实验读数", "测量结果"]],
  ["interface-release-doc", ["api changelog", "service interface updates", "接口发布说明"]],
  ["notes-to-actions", ["workshop notes", "planning session notes", "行动计划", "executable follow ups"]],
  ["literature-synthesis-steps", ["group findings", "organize themes", "compare evidence", "contrast conclusions", "open questions", "evidence gaps"]],
  ["audit-remediation-work", ["audit findings", "检查问题", "remediation backlog", "修复 backlog"]],
  ["highlight-transcript-work", ["transcript 提取 highlight", "转写中的 highlights", "transcript into highlight clips", "highlights from transcript"]],
  ["clip-selection-steps", ["key moments", "notable moments", "clip summary", "片段内容", "timestamp range", "时间区间"]],
  ["survey-chart-steps", ["选项值", "回答编码", "计算分布", "汇总比例", "注释图表", "带说明的图表"]],
  ["bibliography-cleanup-steps", ["引用格式", "条目样式", "元数据", "缺失信息", "信息缺口"]],
  ["field-documentation-steps", ["字段类型", "名称与类型", "业务含义", "字段释义", "取值限制", "可空性"]],
  ["research-insight-work", ["interview transcripts", "discovery conversations", "recurring insights", "themes"]],
  ["interview-insight-steps", ["recurring themes", "repeated signals", "supporting observations", "capture evidence", "rank insights", "prioritize findings"]],
  ["account-line", ["account categories", "cost lines"]],
  ["measure-variance", ["calculate deltas", "measure differences"]],
  ["explain-drivers", ["material changes", "major drivers"]],
  ["issue-normalization-steps", ["normalize symptoms", "standardize descriptions", "equivalent reports", "matching issues", "representative evidence", "useful examples"]],
  ["test-case-steps", ["identify scenarios", "enumerate flows", "boundary conditions", "edge cases", "expected outcomes", "expected results"]],
  ["root-cause-steps", ["关联异常事件", "串联错误线索", "failure chain", "causal chain", "验证步骤", "确认办法"]],
  ["operational-log-source", ["application logs", "service error records", "系统日志", "错误记录"]],
  ["lead-segmentation-steps", ["lead attributes", "客户字段", "define segments", "target groups", "触达重点", "messaging focus"]],
  ["lead-table-source", ["lead csv", "prospect spreadsheet", "线索表"]],
] as const;

type CanonicalGroup = readonly [string, readonly string[]];

const ACTION_GROUPS_V1: readonly CanonicalGroup[] = [
  ["organize", ["整理", "组织", "编排", "安排", "organize", "arrange", "structure"]],
  ["summarize", ["汇总", "汇编", "汇整", "总结", "归纳", "概括", "提炼", "summarize", "synthesize", "aggregate", "compile", "assemble", "collate"]],
  ["generate", ["生成", "编写", "撰写", "制作", "形成", "记录", "发布", "输出", "导出", "generate", "write", "create", "produce", "prepare", "document", "record", "publish", "emit", "output", "export"]],
  ["identify", ["识别", "标出", "标记", "定位", "找出", "发现", "突出", "凸显", "identify", "detect", "find", "flag", "locate", "surface", "highlight", "spotlight"]],
  ["validate", ["验证", "检查", "核对", "校验", "审查", "validate", "check", "verify", "review", "audit", "inspect"]],
  ["analyze", ["分析", "评估", "衡量", "analyze", "assess", "evaluate"]],
  ["extract", ["提取", "读取", "捕获", "摄取", "载入", "加载", "解析", "导入", "收集", "extract", "read", "capture", "ingest", "load", "parse", "import", "collect"]],
  ["calculate", ["计算", "估算", "统计", "衡量", "calculate", "compute", "measure", "estimate"]],
  ["compare", ["比较", "对照", "匹配", "compare", "contrast", "match", "reconcile"]],
  ["classify", ["分类", "归类", "聚类", "分组", "标注", "打标签", "分桶", "编目", "classify", "categorize", "cluster", "group", "tag", "label", "bucket", "catalog"]],
  ["normalize", ["规范", "标准化", "统一", "清理", "校正", "normalize", "standardize", "clean", "align"]],
  ["prioritize", ["排序", "排列", "优先", "分级", "sort", "rank", "prioritize", "order", "sequence"]],
  ["explain", ["解释", "说明", "描述", "explain", "describe"]],
  ["plan", ["规划", "计划", "制定", "设计", "plan", "schedule", "design"]],
  ["recommend", ["建议", "提出", "recommend", "suggest", "propose"]],
  ["transform", ["转换", "转成", "转为", "convert", "transform", "turn"]],
  ["merge", ["合并", "归并", "去重", "merge", "consolidate", "deduplicate", "dedupe"]],
  ["delete", ["删除", "移除", "清除", "销毁", "撤销", "吊销", "清空", "delete", "remove", "erase", "drop", "purge", "revoke", "destroy"]],
  ["enable", ["启用", "开启", "打开", "启动", "enable", "start", "activate", "turn on"]],
  ["disable", ["禁用", "关闭", "停止", "停用", "disable", "stop", "deactivate", "turn off"]],
  ["encrypt", ["加密", "encrypt"]],
  ["decrypt", ["解密", "decrypt"]],
  ["translate", ["翻译", "本地化", "translate", "localize"]],
  ["format", ["排版", "润色", "校对格式", "format", "restyle", "copyedit", "proofread", "polish"]],
  ["rewrite", ["改写", "压缩", "缩短", "rewrite", "condense", "shorten"]],
  ["update", ["更新", "维护", "修订", "update", "maintain", "revise"]],
  ["forecast", ["预测", "预估", "forecast", "predict"]],
  ["present", ["展示", "呈现", "绘制", "show", "present", "visualize", "plot"]],
] as const;

const ARTIFACT_GROUPS_V1: readonly CanonicalGroup[] = [
  ["report", ["报告", "摘要", "简报", "备忘录", "分析", "综述", "概览", "report", "summary", "brief", "memo", "analysis", "commentary", "digest", "recap", "overview", "write up"]],
  ["table", ["表", "表格", "矩阵", "台账", "table", "matrix", "ledger", "sheet"]],
  ["list", ["清单", "列表", "队列", "登记表", "list", "checklist", "backlog", "queue", "register"]],
  ["guide", ["指南", "手册", "说明", "文档", "guide", "manual", "documentation", "instructions", "specification"]],
  ["script", ["script", "training script"]],
  ["plan", ["计划", "方案", "日程", "路线", "排班", "日历", "plan", "schedule", "roadmap", "itinerary", "route", "calendar"]],
  ["visual", ["图表", "看板", "仪表盘", "地图", "chart", "dashboard", "visualization", "map"]],
  ["presentation", ["幻灯片", "演示稿", "slides", "deck", "presentation"]],
  ["glossary", ["术语表", "字典", "glossary", "dictionary"]],
  ["transcript", ["转写稿", "字幕", "caption", "captions", "subtitle", "transcript"]],
  ["forecast", ["预测", "forecast"]],
] as const;

const INPUT_GROUPS_V1: readonly CanonicalGroup[] = [
  ["records", ["记录", "日志", "事件", "条目", "数据集", "导出", "快照", "records", "logs", "events", "entries", "tickets", "requests", "cases", "items", "dataset", "export", "dump", "snapshot"]],
  ["table", ["表", "表格", "电子表格", "台账", "csv", "table", "sheet", "spreadsheet", "ledger"]],
  ["document", ["文档", "文本", "合同", "政策", "证书", "规范", "document", "text", "contract", "policy", "certificate", "specification"]],
  ["conversation", ["对话", "访谈", "会议", "转写", "conversation", "interview", "meeting", "transcript"]],
  ["requirements", ["需求", "要求", "条件", "目标", "requirements", "criteria", "objectives"]],
  ["code", ["代码", "提交", "变更", "差异", "code", "commit", "changes", "diff"]],
  ["media", ["图片", "图像", "音频", "视频", "image", "audio", "video"]],
  ["measurements", ["数据", "读数", "指标", "测量值", "data", "values", "readings", "metrics", "measurements"]],
  ["stream", ["流", "数据流", "馈送", "载荷", "stream", "feed", "payload"]],
] as const;

function normalizeText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function normalizedOutputMatches(left: string, right: string) {
  return normalizeText(left) === normalizeText(right);
}

export function normalizeFingerprint(value: ObservationFingerprint): ObservationFingerprint {
  return {
    core_goal: normalizeText(value.core_goal),
    input_roles: value.input_roles.map(normalizeText),
    output: normalizeText(value.output),
    essential_steps: value.essential_steps.map(normalizeText),
    scope: value.scope,
  };
}

const genericConcepts = new Set([
  "summarize", "group", "extract", "identify", "normalize", "generate", "compare", "rank", "evaluate", "plan", "review",
]);
const exactOutputConcepts = new Set([
  "weekly-study-report", "feedback-theme-table", "candidate-screening-table", "decision-table", "energy-anomaly-report",
  "compliance-gap-list",
]);
const workflowConcepts = new Set([
  "release-note-work", "survey-visualization", "citation-cleanup", "risk-register", "data-dictionary-work",
  "accessibility-audit", "lesson-plan", "restock-plan", "incident-timeline-work", "contract-diff-work",
  "research-conversation", "recurring-insight", "lab-report-work", "budget-variance-work", "api-changelog-work",
  "meeting-action-work", "defect-dedup-work", "capability-comparison", "contact-cleanup", "literature-synthesis-work",
  "research-topic", "requirements-to-tests", "sprint-brief-work", "incident-root-cause-work", "kpi-commentary-work",
  "bilingual-glossary-work", "lead-segmentation-work", "release-checklist-work", "remediation-backlog-work",
  "highlight-clips-work", "survey-insight-deck", "candidate-screening-work", "meeting-decision-work",
  "energy-anomaly-work", "policy-compliance-work",
]);

function stem(value: string) {
  return /^[a-z][a-z0-9]*$/u.test(value) && value.length >= 5
    ? value.replace(/(?:ing|ed|es|s)$/u, "")
    : value;
}

function addToken(tokens: Map<string, number>, token: string, weight: number) {
  if (!token || STOP_WORDS_V1.has(token)) return;
  tokens.set(token, Math.max(tokens.get(token) ?? 0, weight));
}

// Only the fixed vocabulary is retained; input segments live for one matching pass.
const aliasPatterns = new Map([...concepts, ...ACTION_GROUPS_V1, ...ARTIFACT_GROUPS_V1, ...INPUT_GROUPS_V1]
  .flatMap(([, aliases]) => aliases.map(alias => {
    const text = normalizeText(alias);
    const words = /^[\x00-\x7f ]+$/u.test(text)
      ? [...segmenter.segment(text)].filter(part => part.isWordLike).map(part => stem(part.segment)) : null;
    return [alias, { text, words }] as const;
  })));

function aliasMatcher(text: string) {
  let haystack: Array<{ word: string; index: number }> | undefined;
  return (alias: string) => {
    const pattern = aliasPatterns.get(alias)!;
    if (!pattern.text) return -1;
    if (pattern.words === null) return text.indexOf(pattern.text);
    haystack ??= [...segmenter.segment(text)].filter(part => part.isWordLike)
      .map(part => ({ word: stem(part.segment), index: part.index }));
    const needle = pattern.words;
    for (let index = 0; index + needle.length <= haystack.length; index++) {
      if (needle.length > 0 && needle.every((word, offset) => word === haystack![index + offset]!.word)) {
        return haystack[index]!.index;
      }
    }
    return -1;
  };
}

function tokensFor(values: readonly string[]) {
  const tokens = new Map<string, number>();
  for (const raw of values) {
    const text = normalizeText(raw);
    if (!text) continue;
    addToken(tokens, `phrase:${text}`, 0.5);
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike) continue;
      const token = stem(part.segment);
      addToken(tokens, `word:${token}`, 0.1);
      if (/^\p{Script=Han}+$/u.test(token)) {
        const characters = [...token];
        for (const character of characters) addToken(tokens, `han:${character}`, 0.02);
        for (let index = 0; index + 1 < characters.length; index += 1) {
          addToken(tokens, `han2:${characters[index]}${characters[index + 1]}`, 0.05);
        }
      }
    }
    const locateAlias = aliasMatcher(text);
    for (const [concept, aliases] of concepts) {
      if (!aliases.some((alias) => locateAlias(alias) >= 0)) continue;
      const weight = exactOutputConcepts.has(concept) ? 12
        : workflowConcepts.has(concept) ? 16
          : genericConcepts.has(concept) ? 1
            : 8;
      addToken(tokens, `concept:${concept}`, weight);
    }
  }
  return tokens;
}

function weightedJaccard(left: readonly string[], right: readonly string[]) {
  const a = tokensFor(left);
  const b = tokensFor(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  let union = 0;
  for (const token of new Set([...a.keys(), ...b.keys()])) {
    intersection += Math.min(a.get(token) ?? 0, b.get(token) ?? 0);
    union += Math.max(a.get(token) ?? 0, b.get(token) ?? 0);
  }
  return union === 0 ? 0 : intersection / union;
}

function canonicalSet(values: readonly string[], groups: readonly CanonicalGroup[]) {
  const result = new Set<string>();
  for (const raw of values) {
    const text = normalizeText(raw);
    const locateAlias = aliasMatcher(text);
    for (const [canonical, aliases] of groups) {
      if (aliases.some((alias) => locateAlias(alias) >= 0)) result.add(canonical);
    }
  }
  return result;
}

function setJaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / new Set([...left, ...right]).size;
}

function canonicalSimilarity(
  left: readonly string[],
  right: readonly string[],
  groups: readonly CanonicalGroup[],
  ceiling: number,
) {
  return Math.max(weightedJaccard(left, right), setJaccard(canonicalSet(left, groups), canonicalSet(right, groups)) * ceiling);
}

const ACTION_FAMILY_V1 = new Map<string, string>([
  ...["organize", "summarize", "generate", "extract", "classify", "normalize", "merge", "explain", "present", "update"]
    .map((action) => [action, "synthesize"] as const),
  ...["identify", "validate", "analyze", "calculate", "compare"].map((action) => [action, "inspect"] as const),
  ...["prioritize", "plan", "recommend"].map((action) => [action, "plan"] as const),
  ["forecast", "forecast"],
  ["transform", "transform"],
  ["translate", "translate"],
  ["format", "format"],
  ["rewrite", "format"],
  ["delete", "delete"],
  ["enable", "toggle"],
  ["disable", "toggle"],
  ["encrypt", "crypto"],
  ["decrypt", "crypto"],
]);
const STEP_GROUPS_V1 = ACTION_GROUPS_V1;
const UNIVERSALLY_CONFLICTING_ACTIONS_V1 = new Set(["delete", "translate", "format", "rewrite"]);
const EXPLICIT_ACTION_CONFLICTS_V1 = new Set([
  "forecast|summarize",
  "forecast|validate",
  "summarize|validate",
  "disable|enable",
  "decrypt|encrypt",
]);

function firstCanonicalAction(value: string) {
  const text = normalizeText(value);
  const locateAlias = aliasMatcher(text);
  let best: { action: string; index: number } | undefined;
  for (const [action, aliases] of ACTION_GROUPS_V1) {
    for (const alias of aliases) {
      const index = locateAlias(alias);
      if (index >= 0 && (!best || index < best.index)) best = { action, index };
    }
  }
  return best?.action;
}

function actionPairConflicts(left: string, right: string) {
  if (left === right) return false;
  if (UNIVERSALLY_CONFLICTING_ACTIONS_V1.has(left) || UNIVERSALLY_CONFLICTING_ACTIONS_V1.has(right)) return true;
  return EXPLICIT_ACTION_CONFLICTS_V1.has([left, right].sort().join("|"));
}

function canonicalActions(value: string) {
  const text = normalizeText(value);
  const locateAlias = aliasMatcher(text);
  return new Set(ACTION_GROUPS_V1.flatMap(([action, aliases]) =>
    aliases.some((alias) => locateAlias(alias) >= 0) ? [action] : []));
}

function actionsConflict(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const onlyLeft = [...left].filter((action) => !right.has(action));
  const onlyRight = [...right].filter((action) => !left.has(action));
  return onlyLeft.some((leftAction) => onlyRight.some((rightAction) => actionPairConflicts(leftAction, rightAction)));
}

function actionNeedsReview(left: string, right: string) {
  const leftActions = canonicalActions(left);
  const rightActions = canonicalActions(right);
  return leftActions.size === 0 || rightActions.size === 0 || leftActions.size !== rightActions.size ||
    [...leftActions].some((action) => !rightActions.has(action));
}

export function workspaceKey(value: string | null | undefined) {
  const candidate = value?.trim();
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate).replace(/\\/g, "/").toLowerCase() : null;
}

const INTERCHANGEABLE_TEXT_ARTIFACTS = new Set(["report", "table", "list"]);

export function scoreWorkflow(observation: MatchFingerprint, candidate: WorkflowCandidate, workspacePath?: string): number | null {
  const current = normalizeFingerprint(observation);
  const prototype = normalizeFingerprint(candidate.prototype);
  if (current.scope !== prototype.scope) return null;
  if (prototype.scope === "project") {
    const candidateWorkspace = workspaceKey(candidate.scope_value);
    const observationWorkspace = workspaceKey(workspacePath);
    if (!candidateWorkspace || !observationWorkspace || candidateWorkspace !== observationWorkspace) return null;
  }

  const currentArtifacts = canonicalSet([current.output], ARTIFACT_GROUPS_V1);
  const prototypeArtifacts = canonicalSet([prototype.output], ARTIFACT_GROUPS_V1);
  if (currentArtifacts.size > 0 && prototypeArtifacts.size > 0 && setJaccard(currentArtifacts, prototypeArtifacts) === 0 &&
      !([...currentArtifacts].some(item=>INTERCHANGEABLE_TEXT_ARTIFACTS.has(item)) &&
        [...prototypeArtifacts].some(item=>INTERCHANGEABLE_TEXT_ARTIFACTS.has(item)))) return null;
  if (currentArtifacts.has("script") !== prototypeArtifacts.has("script")) return null;
  const currentAction = firstCanonicalAction(current.core_goal);
  const prototypeAction = firstCanonicalAction(prototype.core_goal);
  if (actionsConflict(canonicalActions(current.core_goal), canonicalActions(prototype.core_goal))) return null;

  const lexicalCoreGoal = canonicalSimilarity([current.core_goal], [prototype.core_goal], ACTION_GROUPS_V1, 0.75);
  const coreGoal = !currentAction && !prototypeAction
    ? current.core_goal === prototype.core_goal ? 1 : lexicalCoreGoal
    : !currentAction || !prototypeAction
      ? lexicalCoreGoal
      : currentAction === prototypeAction
        ? Math.max(lexicalCoreGoal, 0.75)
        : ACTION_FAMILY_V1.get(currentAction) === ACTION_FAMILY_V1.get(prototypeAction)
          ? Math.max(lexicalCoreGoal, 0.50)
          : lexicalCoreGoal;
  const score =
    WEIGHTS.core_goal * coreGoal +
    WEIGHTS.output * canonicalSimilarity([current.output], [prototype.output], ARTIFACT_GROUPS_V1, 0.90) +
    WEIGHTS.essential_steps * canonicalSimilarity(current.essential_steps, prototype.essential_steps, STEP_GROUPS_V1, 0.75) +
    WEIGHTS.input_roles * canonicalSimilarity(current.input_roles, prototype.input_roles, INPUT_GROUPS_V1, 0.70);
  return Math.round(score * 1_000_000) / 1_000_000;
}

export function chooseMatch(observation: MatchFingerprint, candidates: readonly WorkflowCandidate[], workspacePath?: string): MatchDecision {
  const ranked = candidates
    .map((candidate) => ({
      workflow_id: candidate.workflow_id,
      score: scoreWorkflow(observation, candidate, workspacePath),
      action_review: actionNeedsReview(observation.core_goal, candidate.prototype.core_goal),
      output_review: !normalizedOutputMatches(observation.output, candidate.prototype.output),
  }))
    .filter((candidate): candidate is { workflow_id: number; score: number; action_review: boolean; output_review: boolean } => candidate.score !== null)
    .sort((left, right) => right.score - left.score || left.workflow_id - right.workflow_id);
  const first = ranked[0];
  if (!first) return { kind: "new" };
  const second = ranked[1];
  if (first.score >= 0.85 && observation.confidence !== "low" && !first.action_review && !first.output_review &&
      (!second || first.score - second.score >= 0.05)) {
    return { kind: "direct", workflow_id: first.workflow_id, score: first.score };
  }
  const review = ranked.slice(0, 5);
  return { kind: "review", workflow_ids: review.map(({ workflow_id }) => workflow_id), scores: review.map(({ score }) => score) };
}
