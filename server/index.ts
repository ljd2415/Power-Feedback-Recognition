import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format, parseISO } from "date-fns";
import { db, bumpTagVersion, getTagVersion, parseJson } from "./db.js";
import { dashboard, periodBounds, type Period } from "./stats.js";
import { importRows, parseWorkbook } from "./importer.js";
import { seedIfEmpty } from "./seed.js";
import { createDocx, streamPdf } from "./report.js";
import { currentRuleVersion, deleteBusinessRule, isDatabaseLockedError, listBusinessRules, saveBusinessRule, seedBusinessRules } from "./business-rules.js";
import { createAnalysisJob, getJob, latestJobForBatch, resumeJobs, retryFailed } from "./jobs.js";
import { generateAiReport, latestAiReport } from "./ai-report.js";
import { buildAnalysisFromRule, type AnalysisInput } from "./analysis.js";
import {
  assignUnownedBatches,
  endSession,
  requireAuth,
  startSession,
  verifyUser,
  type AuthRequest
} from "./auth.js";

seedIfEmpty();
try {
  await seedBusinessRules();
} catch (error) {
  if (isDatabaseLockedError(error)) {
    console.warn("Business rule seed skipped during startup because the database is locked.");
  } else {
    throw error;
  }
}
resumeJobs();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const feedbackSelect = `
  SELECT f.id, f.user_id userId, f.username, f.contact, f.submitted_at submittedAt,
    f.building, f.content, f.keywords, f.tag_id tagId, COALESCE(t.name,'其他问题') tagName,
    f.priority, f.sentiment, f.confidence, f.rationale, f.self_check selfCheck,
    f.resolution, f.resident_message residentMessage, f.utility_message utilityMessage,
    f.status, f.source, f.level1, f.level2, f.scenario, f.business_code businessCode,
    f.rule_version ruleVersion, f.analysis_error analysisError, f.analysis_updated_at analysisUpdatedAt
  FROM feedback f LEFT JOIN tags t ON f.tag_id=t.id
`;

const hydrateFeedback = (row: Record<string, unknown>) => ({
  ...row,
  keywords: parseJson(row.keywords, []),
  selfCheck: parseJson(row.selfCheck, []),
  ...(row.level1 && row.level2 && !db.prepare("SELECT 1 FROM business_rules WHERE active=1 AND level1=? AND level2=?").get(String(row.level1), String(row.level2))
    ? { level1: "", level2: "", scenario: "", businessCode: "", status: "待重新分析" }
    : {})
});

app.get("/api/health", (_req, res) => res.json({ ok: true, tagVersion: getTagVersion() }));

app.post("/api/auth/login", (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const user = verifyUser(username, password);
  if (!user) return res.status(401).json({ error: "账号或密码错误" });
  const session = startSession(user.id);
  assignUnownedBatches(user.id);
  res.setHeader(
    "Set-Cookie",
    `power_session=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Expires=${session.expires.toUTCString()}`
  );
  res.json({ user });
});

app.post("/api/auth/logout", (req, res) => {
  endSession(req);
  res.setHeader("Set-Cookie", "power_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req: AuthRequest, res) => res.json({ user: req.user }));

app.use("/api", requireAuth);

const ownsBatch = (userId: number, batchId: number) =>
  Boolean(db.prepare("SELECT id FROM import_batches WHERE id=? AND owner_user_id=?").get(batchId, userId));

app.get("/api/batches", (req: AuthRequest, res) => {
  const batches = db.prepare(`
    SELECT b.id,b.filename,b.row_count rowCount,b.created_at createdAt,
      COUNT(f.id) actualCount,
      SUM(CASE WHEN f.status IN ('已分析','待确认') THEN 1 ELSE 0 END) analyzedCount,
      SUM(CASE WHEN f.status='已分析' THEN 1 ELSE 0 END) completedCount,
      SUM(CASE WHEN f.status='待确认' THEN 1 ELSE 0 END) confirmedCount,
      SUM(CASE WHEN f.status='分析失败' THEN 1 ELSE 0 END) failedCount,
      SUM(CASE WHEN f.status IN ('待重新分析','待分析') THEN 1 ELSE 0 END) pendingCount,
      SUM(CASE WHEN f.status IN ('分析中','正在重新分析') THEN 1 ELSE 0 END) analyzingCount,
      CASE WHEN COUNT(f.id)=0 THEN 0 ELSE ROUND(SUM(CASE WHEN f.status IN ('已分析','待确认') THEN 1 ELSE 0 END) * 100.0 / COUNT(f.id)) END progressPercent
    FROM import_batches b LEFT JOIN feedback f ON f.batch_id=b.id
    WHERE b.owner_user_id=?
    GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC
  `).all(req.user!.id);
  res.json({ batches });
});

app.get("/api/business-rules", (_req, res) => {
  const level1 = String(_req.query.level1 || "");
  const level2 = String(_req.query.level2 || "");
  const rules = listBusinessRules(level1 || undefined, level2 || undefined);
  res.json({ rules, version: currentRuleVersion() });
});

const generatedRuleNodes = (draft: {
  level1: string;
  level2: string;
  standardPrompt: string;
  requiredCondition: string;
  excludedCondition: string;
  similarDifference: string;
  decisionRule: string;
  positiveExamples: string[];
  negativeExamples: string[];
  boundaryExamples: string[];
  keywordEnhancement: string;
  thresholdRule: string;
}) => [
  { id: "ai-dictionary", title: "AI 协同读取场景字典", content: `一级分类：${draft.level1}\n二级分类：${draft.level2}\n标准提示词：${draft.standardPrompt}`, enabled: true, order: 1 },
  { id: "local-score", title: "本地规则打分生成候选场景", content: `必须满足：${draft.requiredCondition}\n排除条件：${draft.excludedCondition}\n相似场景区分：${draft.similarDifference}\n判定规则：${draft.decisionRule}`, enabled: true, order: 2 },
  { id: "strong-rules", title: "特殊强规则优先", content: "投诉、举报、安全隐患、电表移换拆等强意图优先进入对应场景。", enabled: true, order: 3 },
  { id: "low-confidence", title: "低置信度转新增场景待确认 / 无法识别", content: "最高匹配度低于80且诉求明确时进入新增场景待确认；低于60且诉求不清晰时进入无法识别。", enabled: true, order: 4 },
  { id: "ai-candidate", title: "AI 在候选场景中选择最合适分类并生成说明", content: `口语化正例：\n${draft.positiveExamples.join("\n")}\n\n口语化反例：\n${draft.negativeExamples.join("\n")}\n\n边界样本：\n${draft.boundaryExamples.join("\n")}`, enabled: true, order: 5 },
  { id: "keyword-boost", title: "口语化正则 / 关键词增强", content: draft.keywordEnhancement, enabled: true, order: 6 },
  { id: "threshold-rule", title: "匹配度阈值说明", content: draft.thresholdRule, enabled: true, order: 7 },
  { id: "fallback", title: "AI 不可用时使用本地规则兜底", content: "AI接口不可用、超时或返回异常时，使用本地规则最高分场景生成分析内容。", enabled: true, order: 8 },
  { id: "save-status", title: "按置信度保存状态", content: "匹配度>=80保存为已分析；60-79保存为待确认；低于60保存为分析失败。", enabled: true, order: 9 }
];

const localRuleDraft = (level1: string, level2: string, feedback: AnalysisInput) => {
  const short = feedback.content.slice(0, 80);
  const terms = [...new Set([level2, ...short.split(/[，。,.、\s]+/).filter((item) => item.length >= 2).slice(0, 6)])];
  const draft = {
    level1,
    level2,
    scenario: level2,
    priority: "一般",
    standardPrompt: terms.join("、"),
    requiredCondition: `反馈内容应明确表达“${level2}”相关诉求，包含具体办理、咨询、故障、建议或异常现象，并能从语义上区分为该场景。`,
    excludedCondition: "仅表达问候、无明确用电诉求、已能归入现有停电、电费、电表、投诉、报修等场景的反馈不归入本场景。",
    similarDifference: "与已有场景冲突时，优先判断是否存在更明确的业务关键词；若只是表达新诉求但边界不清，进入待确认后由人工复核。",
    decisionRule: `当反馈主体诉求与“${level2}”高度一致，且未命中排除条件时归入该场景；存在安全、投诉、停电等强意图时优先走对应强规则。`,
    positiveExamples: [feedback.content, `咨询${level2}相关事项，需要帮忙确认处理流程`, `${level2}这个问题应该怎么处理`],
    negativeExamples: ["只是想查询电费余额", "家里突然停电需要报修", "我要投诉一直没人处理"],
    boundaryExamples: [`可能和${level2}有关，但也不确定是不是其他业务`, `描述中出现${level2}相关说法，但缺少关键事实，需要人工确认`],
    keywordEnhancement: `关键词建议：${terms.join("、")}。\n正则建议：(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})。`,
    thresholdRule: "匹配度>=90直接分类；80-89高可信分类；60-79进入待确认；低于60不匹配。与强规则场景冲突时以强规则优先。"
  };
  return { ...draft, ruleNodes: generatedRuleNodes(draft), active: true };
};

app.post("/api/business-rules/draft", (req: AuthRequest, res) => {
  const feedbackId = Number(req.body.feedbackId);
  const level1 = String(req.body.level1 || "其他").trim() || "其他";
  const level2 = String(req.body.level2 || "").trim();
  if (!level2) return res.status(400).json({ error: "请先输入新场景名称" });
  const feedback = db.prepare(`
    SELECT f.user_id userId,f.username,f.contact,f.submitted_at submittedAt,f.building,f.content
    FROM feedback f JOIN import_batches b ON b.id=f.batch_id
    WHERE f.id=? AND b.owner_user_id=?
  `).get(feedbackId, req.user!.id) as AnalysisInput | undefined;
  if (!feedback) return res.status(404).json({ error: "反馈不存在" });
  const existing = listBusinessRules().map((rule) => ({
    level1: rule.level1,
    level2: rule.level2,
    standardPrompt: rule.standardPrompt,
    requiredCondition: rule.requiredCondition,
    excludedCondition: rule.excludedCondition,
    similarDifference: rule.similarDifference,
    decisionRule: rule.decisionRule
  }));
  const fallback = localRuleDraft(level1, level2, feedback);
  const finish = (draft: typeof fallback) => res.json({ draft });
  if (!process.env.OPENAI_API_KEY) return finish(fallback);
  fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是电力业务场景字典维护专家。根据用户反馈和已有场景，生成新场景规则JSON。字段必须包含standardPrompt、requiredCondition、excludedCondition、similarDifference、decisionRule、positiveExamples、negativeExamples、boundaryExamples、keywordEnhancement、thresholdRule、priority。要求与已有场景判定口径一致，不能虚构业务事实，样本要口语化。" },
        { role: "user", content: JSON.stringify({ newScene: { level1, level2 }, feedback, existingScenes: existing }) }
      ]
    }),
    signal: AbortSignal.timeout(45000)
  }).then(async (response) => {
    if (!response.ok) return finish(fallback);
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    const draft = {
      ...fallback,
      priority: ["紧急", "风险", "一般", "待定"].includes(String(parsed.priority)) ? parsed.priority : fallback.priority,
      standardPrompt: String(parsed.standardPrompt || fallback.standardPrompt),
      requiredCondition: String(parsed.requiredCondition || fallback.requiredCondition),
      excludedCondition: String(parsed.excludedCondition || fallback.excludedCondition),
      similarDifference: String(parsed.similarDifference || fallback.similarDifference),
      decisionRule: String(parsed.decisionRule || fallback.decisionRule),
      positiveExamples: Array.isArray(parsed.positiveExamples) ? [feedback.content, ...parsed.positiveExamples.map(String)].filter(Boolean) : fallback.positiveExamples,
      negativeExamples: Array.isArray(parsed.negativeExamples) ? parsed.negativeExamples.map(String).filter(Boolean) : fallback.negativeExamples,
      boundaryExamples: Array.isArray(parsed.boundaryExamples) ? parsed.boundaryExamples.map(String).filter(Boolean) : fallback.boundaryExamples,
      keywordEnhancement: String(parsed.keywordEnhancement || fallback.keywordEnhancement),
      thresholdRule: String(parsed.thresholdRule || fallback.thresholdRule)
    };
    finish({ ...draft, ruleNodes: generatedRuleNodes(draft) });
  }).catch(() => finish(fallback));
});

app.post("/api/business-rules", (req, res) => {
  try {
    req.body.scenario = String(req.body.scenario || req.body.level2 || "").trim();
    for (const key of ["level1", "level2", "standardPrompt", "requiredCondition", "excludedCondition", "similarDifference", "decisionRule", "priority"]) {
      if (!String(req.body[key] || "").trim()) return res.status(400).json({ error: `${key}不能为空` });
    }
    res.json(saveBusinessRule(req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存规则失败" });
  }
});

app.patch("/api/business-rules/:id", (req, res) => {
  try {
    req.body.scenario = String(req.body.scenario || req.body.level2 || "").trim();
    res.json(saveBusinessRule({ ...req.body, id: Number(req.params.id) }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "保存规则失败" });
  }
});

app.delete("/api/business-rules/:id", (req, res) => {
  try {
    res.json(deleteBusinessRule(Number(req.params.id)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "删除规则失败" });
  }
});

app.delete("/api/batches/:id", (req: AuthRequest, res) => {
  const batchId = Number(req.params.id);
  if (!ownsBatch(req.user!.id, batchId)) return res.status(404).json({ error: "数据表不存在" });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM analysis_job_items WHERE job_id IN (SELECT id FROM analysis_jobs WHERE batch_id=?)").run(batchId);
    db.prepare("DELETE FROM analysis_jobs WHERE batch_id=?").run(batchId);
    db.prepare("DELETE FROM report_snapshots WHERE batch_id=?").run(batchId);
    db.prepare("DELETE FROM tag_suggestions WHERE feedback_id IN (SELECT id FROM feedback WHERE batch_id=?)").run(batchId);
    db.prepare("DELETE FROM classification_history WHERE feedback_id IN (SELECT id FROM feedback WHERE batch_id=?)").run(batchId);
    const deletedRows = db.prepare("DELETE FROM feedback WHERE batch_id=?").run(batchId).changes;
    db.prepare("DELETE FROM import_batches WHERE id=? AND owner_user_id=?").run(batchId, req.user!.id);
    db.exec("COMMIT");
    res.json({ ok: true, deletedRows });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: "删除数据表失败" });
  }
});

app.get("/api/feedback", (req: AuthRequest, res) => {
  const search = String(req.query.search || "").trim();
  const priority = String(req.query.priority || "");
  const tag = String(req.query.tag || "");
  const sortBy = String(req.query.sortBy || "time");
  const sortOrder = String(req.query.sortOrder || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 20));
  const conditions: string[] = ["b.owner_user_id=?"];
  const params: (string | number)[] = [req.user!.id];
  const batchId = Number(req.query.batchId);
  if (batchId) {
    conditions.push("f.batch_id=?");
    params.push(batchId);
    const period = (["day", "week", "month", "year", "all"].includes(String(req.query.period)) ? req.query.period : "month") as Period;
    const latest = db.prepare(
      "SELECT MAX(f.submitted_at) latest FROM feedback f JOIN import_batches b ON b.id=f.batch_id WHERE f.batch_id=? AND b.owner_user_id=?"
    ).get(batchId, req.user!.id) as { latest?: string };
    if (latest.latest && period !== "all") {
      const [rangeStart, rangeEnd] = periodBounds(parseISO(latest.latest), period);
      conditions.push("f.submitted_at BETWEEN ? AND ?");
      params.push(format(rangeStart, "yyyy-MM-dd HH:mm:ss"), format(rangeEnd, "yyyy-MM-dd HH:mm:ss"));
    }
  }
  if (search) {
    conditions.push("(f.content LIKE ? OR f.username LIKE ? OR f.user_id LIKE ? OR f.building LIKE ?)");
    params.push(...Array(4).fill(`%${search}%`));
  }
  if (priority) {
    conditions.push("f.priority=?");
    params.push(priority);
  }
  if (tag) {
    conditions.push("t.name=?");
    params.push(tag);
  }
  const where = ` WHERE ${conditions.join(" AND ")}`;
  const total = Number((db.prepare(`SELECT COUNT(*) count FROM feedback f LEFT JOIN tags t ON f.tag_id=t.id JOIN import_batches b ON b.id=f.batch_id${where}`).get(...params) as { count: number }).count);
  const priorityRank = "CASE f.priority WHEN '紧急' THEN 1 WHEN '风险' THEN 2 WHEN '一般' THEN 3 WHEN '待定' THEN 4 ELSE 5 END";
  const orderBy = sortBy === "priority"
    ? `${priorityRank} ${sortOrder}, f.submitted_at DESC, f.id DESC`
    : `f.submitted_at ${sortOrder}, f.id ${sortOrder}`;
  const items = db.prepare(`${feedbackSelect} JOIN import_batches b ON b.id=f.batch_id${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as unknown as Record<string, unknown>[];
  res.json({ items: items.map(hydrateFeedback), total });
});

app.get("/api/feedback/:id", (req: AuthRequest, res) => {
  const row = db.prepare(`${feedbackSelect} JOIN import_batches b ON b.id=f.batch_id WHERE f.id=? AND b.owner_user_id=?`).get(Number(req.params.id), req.user!.id) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "反馈不存在" });
  res.json(hydrateFeedback(row));
});

app.patch("/api/feedback/:id", (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const current = db.prepare(`
    SELECT f.id,f.tag_id,f.business_code,f.user_id userId,f.username,f.contact,
      f.submitted_at submittedAt,f.building,f.content
    FROM feedback f
    JOIN import_batches b ON b.id=f.batch_id
    WHERE f.id=? AND b.owner_user_id=?
  `).get(id, req.user!.id) as ({ tag_id: number; business_code: string } & AnalysisInput) | undefined;
  if (!current) return res.status(404).json({ error: "反馈不存在" });
  const allowed: Record<string, string> = { tagId: "tag_id", priority: "priority", sentiment: "sentiment" };
  const updates: string[] = [];
  const values: (string | number)[] = [];
  for (const [key, column] of Object.entries(allowed)) {
    if (key === "priority" && req.body.businessRuleId !== undefined) continue;
    if (req.body[key] !== undefined) {
      updates.push(`${column}=?`);
      values.push(String(req.body[key]));
    }
  }
  if (req.body.businessRuleId !== undefined) {
    const rule = listBusinessRules().find((item) => item.id === Number(req.body.businessRuleId) && item.active);
    if (!rule) return res.status(400).json({ error: "请选择有效的业务分类" });
    if (req.body.addPositiveExample) {
      const positiveExamples = [current.content, ...rule.positiveExamples].map((item) => item.trim()).filter(Boolean);
      saveBusinessRule({ ...rule, positiveExamples: [...new Set(positiveExamples)] });
    }
    const analysis = buildAnalysisFromRule(current as AnalysisInput, rule, {
      priority: (["紧急", "风险", "一般", "待定"].includes(String(req.body.priority)) ? req.body.priority : rule.priority) as "紧急" | "风险" | "一般" | "待定",
      source: "manual",
      confidence: 100
    });
    updates.push(
      "keywords=?", "priority=?", "sentiment=?", "confidence=?", "rationale=?", "self_check=?", "resolution=?",
      "resident_message=?", "utility_message=?", "status='已分析'",
      "level1=?", "level2=?", "scenario=?", "business_code=?", "rule_version=?", "analysis_updated_at=CURRENT_TIMESTAMP"
    );
    values.push(
      JSON.stringify(analysis.keywords), analysis.priority, analysis.sentiment, 1, analysis.feedbackAnalysis,
      JSON.stringify(analysis.selfCheck), analysis.resolution, analysis.residentMessage, analysis.utilityMessage,
      analysis.level1, analysis.level2, analysis.scenario, analysis.businessCode, analysis.ruleVersion
    );
  }
  if (!updates.length) return res.status(400).json({ error: "没有可更新字段" });
  db.prepare(`UPDATE feedback SET ${updates.join(",")}, source='manual' WHERE id=?`).run(...values, id);
  db.prepare("UPDATE report_snapshots SET status='stale',updated_at=CURRENT_TIMESTAMP WHERE batch_id=(SELECT batch_id FROM feedback WHERE id=?) AND status='completed'").run(id);
  if (req.body.tagId && req.body.tagId !== current.tag_id) {
    db.prepare("INSERT INTO classification_history(feedback_id,old_tag_id,new_tag_id,reason) VALUES(?,?,?,'人工修正')").run(id, current.tag_id, Number(req.body.tagId));
  }
  const row = db.prepare(`${feedbackSelect} WHERE f.id=?`).get(id) as Record<string, unknown>;
  res.json(hydrateFeedback(row));
});

app.post("/api/analyze", async (req: AuthRequest, res) => {
  const batchId = Number(req.body.batchId);
  if (batchId && !ownsBatch(req.user!.id, batchId)) return res.status(404).json({ error: "数据表不存在" });
  let ids: number[];
  const scope = String(req.body.scope || (Array.isArray(req.body.ids) && req.body.ids.length ? "selected" : "batch"));
  if (scope === "selected" && Array.isArray(req.body.ids) && req.body.ids.length) {
    ids = req.body.ids.map(Number);
  } else {
    const conditions = ["b.owner_user_id=?", "f.batch_id=?"];
    const params: (string | number)[] = [req.user!.id, batchId];
    const filters = req.body.filters || {};
    if (filters.search) {
      conditions.push("(f.content LIKE ? OR f.username LIKE ? OR f.user_id LIKE ? OR f.building LIKE ?)");
      params.push(...Array(4).fill(`%${String(filters.search)}%`));
    }
    if (filters.priority) { conditions.push("f.priority=?"); params.push(String(filters.priority)); }
    const sortBy = String(filters.sortBy || "time");
    const sortOrder = String(filters.sortOrder || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const filterPeriod = String(filters.period || "all") as Period;
    if (filterPeriod !== "all") {
      const latest = db.prepare("SELECT MAX(submitted_at) latest FROM feedback WHERE batch_id=?").get(batchId) as { latest?: string };
      if (latest.latest) {
        const [rangeStart, rangeEnd] = periodBounds(parseISO(latest.latest), filterPeriod);
        conditions.push("f.submitted_at BETWEEN ? AND ?");
        params.push(format(rangeStart, "yyyy-MM-dd HH:mm:ss"), format(rangeEnd, "yyyy-MM-dd HH:mm:ss"));
      }
    }
    const priorityRank = "CASE f.priority WHEN '紧急' THEN 1 WHEN '风险' THEN 2 WHEN '一般' THEN 3 WHEN '待定' THEN 4 ELSE 5 END";
    const orderBy = sortBy === "priority"
      ? `${priorityRank} ${sortOrder}, f.submitted_at DESC, f.id DESC`
      : `f.submitted_at ${sortOrder}, f.id ${sortOrder}`;
    const page = Math.max(1, Number(req.body.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.body.pageSize) || 20));
    const limitClause = scope === "page" ? " LIMIT ? OFFSET ?" : "";
    const finalParams = scope === "page" ? [...params, pageSize, (page - 1) * pageSize] : params;
    ids = (db.prepare(`
      SELECT f.id FROM feedback f JOIN import_batches b ON b.id=f.batch_id
      WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy}${limitClause}
    `).all(...finalParams) as unknown as { id: number }[]).map((row) => row.id);
  }
  const ownedIds = ids.filter((id: number) => Boolean(db.prepare(`
    SELECT f.id FROM feedback f JOIN import_batches b ON b.id=f.batch_id
    WHERE f.id=? AND b.owner_user_id=? AND (?=0 OR f.batch_id=?)
  `).get(id, req.user!.id, batchId || 0, batchId || 0)));
  const jobId = createAnalysisJob(batchId, req.user!.id, ownedIds, "正在重新分析");
  res.json({ jobId, total: ownedIds.length });
});

app.post("/api/import", upload.single("file"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "请选择Excel或CSV文件" });
    const parsed = await parseWorkbook(req.file);
    const supplied = req.body.mapping ? JSON.parse(req.body.mapping) : null;
    if (!supplied) {
      return res.json({ preview: parsed.rows.slice(0, 8), headers: parsed.headers, mapping: parsed.mapping });
    }
    const result = await importRows(req.file.originalname, parsed.rows, supplied, req.user!.id);
    if (!result.batchId || !result.imported) return res.json(result);
    const ids = (db.prepare("SELECT id FROM feedback WHERE batch_id=? ORDER BY id DESC").all(result.batchId) as unknown as { id: number }[]).map((row) => row.id);
    const jobId = createAnalysisJob(result.batchId, req.user!.id, ids);
    res.json({ ...result, jobId });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "导入失败" });
  }
});

app.get("/api/jobs/:id", (req: AuthRequest, res) => {
  const job = getJob(Number(req.params.id), req.user!.id);
  if (!job) return res.status(404).json({ error: "任务不存在" });
  res.json(job);
});

app.get("/api/batches/:id/latest-job", (req: AuthRequest, res) => {
  res.json({ job: latestJobForBatch(Number(req.params.id), req.user!.id) });
});

app.post("/api/jobs/:id/retry", (req: AuthRequest, res) => {
  try {
    const jobId = retryFailed(Number(req.params.id), req.user!.id);
    res.json({ jobId });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "重试失败" });
  }
});

app.get("/api/batches/:id/ai-report", (req: AuthRequest, res) => {
  const batchId = Number(req.params.id);
  if (!ownsBatch(req.user!.id, batchId)) return res.status(404).json({ error: "数据表不存在" });
  res.json({ report: latestAiReport(batchId, req.user!.id, String(req.query.period || "month") as Period) });
});

app.post("/api/batches/:id/ai-report", (req: AuthRequest, res) => {
  const batchId = Number(req.params.id);
  if (!ownsBatch(req.user!.id, batchId)) return res.status(404).json({ error: "数据表不存在" });
  const id = generateAiReport(batchId, req.user!.id, String(req.body.period || "month") as Period);
  res.json({ id });
});

app.get("/api/dashboard", (req: AuthRequest, res) => {
  const period = (["day", "week", "month", "year", "all"].includes(String(req.query.period)) ? req.query.period : "month") as Period;
  const batchId = Number(req.query.batchId);
  if (!batchId || !ownsBatch(req.user!.id, batchId)) return res.status(400).json({ error: "请选择有效数据表" });
  res.json(dashboard(period, req.query.date ? String(req.query.date) : undefined, batchId));
});

app.get("/api/tags", (_req, res) => {
  const tags = (db.prepare("SELECT * FROM tags ORDER BY active DESC,id").all() as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id, name: row.name, description: row.description, aliases: parseJson(row.aliases, []),
    keywords: parseJson(row.keywords, []), active: Boolean(row.active), version: row.version,
    source: row.source, createdAt: row.created_at
  }));
  const suggestions = (db.prepare("SELECT * FROM tag_suggestions ORDER BY status='待审核' DESC,id DESC").all() as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id, proposedName: row.proposed_name, definition: row.definition, keywords: parseJson(row.keywords, []),
    boundary: row.boundary_text, rationale: row.rationale, similarTag: row.similar_tag,
    status: row.status, feedbackId: row.feedback_id, createdAt: row.created_at
  }));
  res.json({ tags, suggestions, version: getTagVersion() });
});

app.post("/api/tag-suggestions/:id/approve", (req, res) => {
  const suggestion = db.prepare("SELECT * FROM tag_suggestions WHERE id=? AND status='待审核'").get(Number(req.params.id)) as Record<string, string | number> | undefined;
  if (!suggestion) return res.status(404).json({ error: "待审核建议不存在" });
  const version = bumpTagVersion();
  try {
    const result = db.prepare("INSERT INTO tags(name,description,keywords,aliases,version,source) VALUES(?,?,?,'[]',?,'ai_suggestion')").run(suggestion.proposed_name, suggestion.definition, suggestion.keywords, version);
    db.prepare("UPDATE tag_suggestions SET status='已通过' WHERE id=?").run(req.params.id);
    res.json({ id: Number(result.lastInsertRowid), version });
  } catch {
    res.status(409).json({ error: "标签名称已存在，请选择合并" });
  }
});

app.post("/api/tag-suggestions/:id/reject", (req, res) => {
  db.prepare("UPDATE tag_suggestions SET status='已驳回' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/tag-suggestions/:id/merge", (req, res) => {
  const suggestion = db.prepare("SELECT proposed_name FROM tag_suggestions WHERE id=?").get(req.params.id) as { proposed_name: string } | undefined;
  const tag = db.prepare("SELECT aliases FROM tags WHERE id=?").get(Number(req.body.tagId)) as { aliases: string } | undefined;
  if (!suggestion || !tag) return res.status(404).json({ error: "标签或建议不存在" });
  const aliases = [...new Set([...parseJson<string[]>(tag.aliases, []), suggestion.proposed_name])];
  const version = bumpTagVersion();
  db.prepare("UPDATE tags SET aliases=?,version=? WHERE id=?").run(JSON.stringify(aliases), version, req.body.tagId);
  db.prepare("UPDATE tag_suggestions SET status='已合并' WHERE id=?").run(req.params.id);
  res.json({ ok: true, version });
});

app.patch("/api/tags/:id", (req, res) => {
  const version = bumpTagVersion();
  db.prepare("UPDATE tags SET active=?,version=? WHERE id=?").run(req.body.active ? 1 : 0, version, req.params.id);
  res.json({ ok: true, version });
});

app.get("/api/reports/word", async (req: AuthRequest, res) => {
  const period = (req.query.period || "month") as Period;
  const batchId = Number(req.query.batchId);
  if (!batchId || !ownsBatch(req.user!.id, batchId)) return res.status(400).json({ error: "请选择有效数据表" });
  const buffer = await createDocx(period, req.query.date ? String(req.query.date) : undefined, batchId);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", "attachment; filename=power-feedback-report.docx");
  res.send(buffer);
});

app.get("/api/reports/pdf", (req: AuthRequest, res) => {
  const batchId = Number(req.query.batchId);
  if (!batchId || !ownsBatch(req.user!.id, batchId)) return res.status(400).json({ error: "请选择有效数据表" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=power-feedback-report.pdf");
  streamPdf((req.query.period || "month") as Period, req.query.date ? String(req.query.date) : undefined, res, batchId);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
app.use(express.static(dist));
app.get("*path", (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Power feedback server: http://localhost:${port}`));
