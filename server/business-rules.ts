import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { db, bumpRuleVersion, getRuleVersion, parseJson } from "./db.js";
import { parseWorkbook } from "./importer.js";

export type RuleNode = {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
};

export type BusinessRule = {
  id: number;
  level1: string;
  level2: string;
  scenario: string;
  businessCode: string;
  priority: "紧急" | "风险" | "一般" | "待定";
  standardPrompt: string;
  requiredCondition: string;
  excludedCondition: string;
  similarDifference: string;
  decisionRule: string;
  positiveExamples: string[];
  negativeExamples: string[];
  boundaryExamples: string[];
  ruleNodes: RuleNode[];
  active: boolean;
  version: number;
};

const dictionaryCandidates = [
  path.join(os.homedir(), "Desktop", "电力业务场景标准字典.xlsx"),
  path.join("D:\\HuaweiMoveData\\Users\\dpf\\Desktop", "电力业务场景标准字典.xlsx")
];

const fieldFromDecisionRule = (decisionRule: string, label: string) => {
  const line = decisionRule.split(/\r?\n/).find((item) => item.startsWith(`${label}：`));
  return line ? line.slice(label.length + 1).trim() : "";
};

type ExampleSeed = { topic: string; intent: string; positiveHints: string[]; negativeHints: string[] };

const exampleSeeds: Record<string, ExampleSeed> = {
  电费电价咨询: { topic: "电费电价", intent: "查询费用、电价、余额、账单或峰谷电价", positiveHints: ["电费高", "电价", "余额", "账单", "峰谷电价"], negativeHints: ["停电", "跳闸", "电表黑屏", "过户", "投诉"] },
  停电信息查询: { topic: "停电信息", intent: "询问是否停电、停电原因、范围和复电时间", positiveHints: ["是不是停电", "什么时候来电", "停电通知", "复电时间", "停电范围"], negativeHints: ["家里跳闸", "电压不稳", "报修进度", "电费", "电表故障"] },
  用户档案查询: { topic: "用户档案", intent: "查询户号、客户编号、绑定信息或用户档案", positiveHints: ["户号", "客户编号", "用户编号", "档案", "绑定信息"], negativeHints: ["过户更名", "电费高", "停电", "充电桩", "电表黑屏"] },
  电表咨询: { topic: "电表咨询", intent: "咨询电表安装、读数、功能和使用说明", positiveHints: ["电表怎么看", "电表安装", "智能电表", "读数", "电表说明"], negativeHints: ["移表", "换表", "电表黑屏", "电费账单", "停电"] },
  供电服务咨询: { topic: "供电服务", intent: "查询营业厅、客服电话、服务时间和办理渠道", positiveHints: ["客服电话", "营业厅", "上班时间", "供电所", "服务渠道"], negativeHints: ["电压不稳", "跳闸", "电费高", "过户", "举报"] },
  充电桩服务: { topic: "充电桩服务", intent: "咨询或申请充电桩、充电容量和安装条件", positiveHints: ["充电桩", "新能源车", "申请装桩", "车位充电", "充电容量"], negativeHints: ["电表黑屏", "停电", "电费账单", "线路冒烟", "报修进度"] },
  用电报装: { topic: "用电报装", intent: "办理新装、增容、减容、临时用电或接电", positiveHints: ["新装电", "报装", "增容", "临时用电", "接电"], negativeHints: ["电费查询", "停电通知", "电表坏了", "服务投诉", "过户"] },
  用户信息变更: { topic: "用户信息变更", intent: "办理过户、更名、户主变更或联系方式变更", positiveHints: ["过户", "更名", "户主变更", "改户名", "联系方式变更"], negativeHints: ["户号查询", "电表黑屏", "电压不稳", "新装电", "投诉赔偿"] },
  电表业务办理: { topic: "电表业务办理", intent: "申请移表、换表、拆表等电表业务", positiveHints: ["移表", "换表", "拆表", "电表迁移", "更换电表"], negativeHints: ["电表怎么看", "电表黑屏", "电费高", "停电信息", "过户"] },
  停电跳闸故障: { topic: "停电跳闸故障", intent: "反馈家中、楼栋或局部无电、断电、跳闸故障", positiveHints: ["家里没电", "跳闸", "突然断电", "合不上闸", "整户无电"], negativeHints: ["停电通知", "电费查询", "电压低", "电表咨询", "客服号码"] },
  电压异常: { topic: "电压异常", intent: "反馈电压偏高偏低、不稳定、灯闪或电器异常重启", positiveHints: ["电压不稳", "灯闪", "电压低", "忽明忽暗", "电器重启"], negativeHints: ["停电通知", "电费高", "户号", "移表", "投诉赔偿"] },
  电表故障: { topic: "电表故障", intent: "反馈电表黑屏、不走、显示异常、计量疑似故障", positiveHints: ["电表黑屏", "电表不走", "显示异常", "计量异常", "电表坏了"], negativeHints: ["电表安装咨询", "换表申请", "电费账单", "停电范围", "过户"] },
  线路设备故障: { topic: "线路设备故障", intent: "反馈电线、电缆、配电箱、变压器等设备异常或损坏", positiveHints: ["线路断了", "配电箱坏了", "电缆破损", "变压器异常", "公共设备故障"], negativeHints: ["电费咨询", "户号查询", "过户", "电表读数", "客服电话"] },
  用电安全隐患: { topic: "用电安全隐患", intent: "反馈冒烟、火花、焦糊味、漏电、裸露线路等安全风险", positiveHints: ["冒烟", "火花", "焦糊味", "漏电", "裸露线路"], negativeHints: ["停电通知", "电费高", "户号查询", "营业厅地址", "建议优化"] },
  故障抢修: { topic: "故障抢修", intent: "询问或催办已报修故障的抢修进度和上门时间", positiveHints: ["报修进度", "抢修", "多久修好", "维修师傅", "催修"], negativeHints: ["新装报装", "电价咨询", "过户更名", "充电桩申请", "举报偷电"] },
  服务投诉与赔偿: { topic: "服务投诉与赔偿", intent: "投诉服务、处理不及时、要求解释、赔偿或补偿", positiveHints: ["投诉", "赔偿", "没人处理", "服务态度", "补偿"], negativeHints: ["普通咨询", "停电通知", "户号查询", "电表安装", "建议增加"] },
  意见建议: { topic: "意见建议", intent: "提出服务、设备、通知、流程等优化建议", positiveHints: ["建议", "希望", "优化", "改进", "增加设施"], negativeHints: ["投诉赔偿", "电费查询", "跳闸故障", "漏电", "过户"] },
  举报与风险反馈: { topic: "举报与风险反馈", intent: "举报偷电、私拉乱接、违规用电或风险线索", positiveHints: ["举报", "偷电", "私拉乱接", "违规用电", "私接电线"], negativeHints: ["电费高", "停电", "电表咨询", "服务建议", "过户"] },
  无法识别: { topic: "无法识别", intent: "内容过短、缺少用电诉求或无法判断具体业务", positiveHints: ["在吗", "你好", "帮看看", "有人吗", "？？"], negativeHints: ["停电啦", "电费高", "漏电", "过户", "报修进度"] },
  新增场景待确认: { topic: "新增场景待确认", intent: "诉求明确但不属于现有场景，需人工判断是否新增", positiveHints: ["有个新问题不知道归哪类", "这个情况系统里没有", "特殊用电问题", "新的业务诉求", "需要人工确认场景"], negativeHints: ["停电查询", "电费咨询", "电压异常", "电表故障", "投诉赔偿"] }
};

const genericSeed = (level2: string): ExampleSeed => ({
  topic: level2,
  intent: `识别${level2}相关诉求`,
  positiveHints: [level2, `${level2}怎么办`, `咨询${level2}`, `${level2}处理`, `${level2}问题`],
  negativeHints: ["电费咨询", "停电跳闸", "过户更名", "电表故障", "服务投诉"]
});

export const defaultRuleExamples = (level2: string) => {
  const seed = exampleSeeds[level2] || genericSeed(level2);
  const positiveExamples = [
    `请问${seed.topic}这个事怎么处理`,
    `我想咨询一下${seed.topic}，麻烦帮我看看`,
    `关于${seed.topic}，现在需要走什么流程`,
    `${seed.positiveHints[0] || seed.topic}，这个是不是属于${level2}`,
    `${seed.positiveHints[1] || seed.topic}能帮忙查一下吗`,
    `${seed.positiveHints[2] || seed.topic}需要准备什么`,
    `${seed.positiveHints[3] || seed.topic}已经影响我用电了`,
    `${seed.positiveHints[4] || seed.topic}麻烦尽快确认`,
    `我反馈的是${seed.intent}`,
    `这个${seed.topic}问题应该找供电公司处理吧`
  ];
  const negativeExamples = [
    `我不是问${seed.topic}，只是想查电费账单`,
    `不是${level2}，我家是突然跳闸没电`,
    `这和${seed.topic}无关，我要办理过户更名`,
    `不是这个场景，我是想投诉服务态度`,
    `我没有${seed.topic}诉求，只是想问客服电话`,
    `${seed.negativeHints[0] || "其他业务"}才是我的问题`,
    `${seed.negativeHints[1] || "其他故障"}，不是${level2}`,
    `${seed.negativeHints[2] || "其他办理"}怎么处理`,
    `${seed.negativeHints[3] || "其他咨询"}和这个不一样`,
    `${seed.negativeHints[4] || "其他反馈"}不是${seed.topic}`
  ];
  const boundaryExamples = [
    `可能是${seed.topic}，但我不确定是不是别的原因`,
    `${seed.topic}和其他问题都有一点，帮我判断下`,
    `我只知道和${seed.positiveHints[0] || seed.topic}有关，具体不清楚`,
    `这个情况像${level2}，但还没有确认现场情况`,
    `先帮我看看是不是${seed.topic}，不确定再人工确认`
  ];
  return { positiveExamples, negativeExamples, boundaryExamples };
};

const normalizedExamples = (value: unknown, fallback: string[]) => {
  const parsed = Array.isArray(value) ? value.map(String) : parseJson<string[]>(value, []);
  const cleaned = parsed.map((item) => item.trim()).filter(Boolean);
  return cleaned.length ? cleaned : fallback;
};

const defaultRuleNodes = (input: {
  standardPrompt: string;
  requiredCondition: string;
  excludedCondition: string;
  similarDifference: string;
  decisionRule: string;
  positiveExamples: string[];
  negativeExamples: string[];
  boundaryExamples: string[];
}) => [
  { id: "ai-dictionary", title: "AI 协同读取场景字典", content: `标准提示词：${input.standardPrompt}`, enabled: true, order: 1 },
  { id: "local-score", title: "本地规则打分生成候选场景", content: `必须满足：${input.requiredCondition}\n排除条件：${input.excludedCondition}\n相似场景区分：${input.similarDifference}\n判定规则：${input.decisionRule}`, enabled: true, order: 2 },
  { id: "strong-rules", title: "特殊强规则优先", content: "投诉、举报、安全隐患、电表移换拆等强意图优先进入对应场景。", enabled: true, order: 3 },
  { id: "low-confidence", title: "低置信度转新增场景待确认 / 无法识别", content: "最高匹配度低于80且诉求明确时进入新增场景待确认；低于60且诉求不清晰时进入无法识别。", enabled: true, order: 4 },
  { id: "ai-candidate", title: "AI 在候选场景中选择最合适分类并生成说明", content: `口语化正例：\n${input.positiveExamples.join("\n")}\n\n口语化反例：\n${input.negativeExamples.join("\n")}\n\n边界样本：\n${input.boundaryExamples.join("\n")}`, enabled: true, order: 5 },
  { id: "fallback", title: "AI 不可用时使用本地规则兜底", content: "AI接口不可用、超时或返回异常时，使用本地规则最高分场景生成分析内容。", enabled: true, order: 6 },
  { id: "save-status", title: "按置信度保存状态", content: "匹配度>=80保存为已分析；60-79保存为待确认；低于60保存为分析失败。", enabled: true, order: 7 }
];

const normalizeRuleNodes = (value: unknown, fallback: RuleNode[]) => {
  const parsed = Array.isArray(value) ? value : parseJson<RuleNode[]>(value, []);
  const cleaned = parsed
    .map((node, index) => ({
      id: String(node.id || `node-${index + 1}`),
      title: String(node.title || `规则节点${index + 1}`),
      content: String(node.content || ""),
      enabled: node.enabled !== false,
      order: Number(node.order || index + 1)
    }))
    .filter((node) => node.title.trim());
  return (cleaned.length ? cleaned : fallback).sort((a, b) => a.order - b.order);
};

const rowValue = (row: Record<string, unknown>, key: string) => String(row[key] || "").trim();

const normalizePriority = (value: unknown): BusinessRule["priority"] => {
  const text = String(value || "").trim();
  return text === "紧急" || text === "风险" || text === "待定" ? text : "一般";
};

const buildNodeFallback = (
  standardPrompt: string,
  requiredCondition: string,
  excludedCondition: string,
  similarDifference: string,
  decisionRule: string,
  positiveExamples: string[],
  negativeExamples: string[],
  boundaryExamples: string[]
) => defaultRuleNodes({ standardPrompt, requiredCondition, excludedCondition, similarDifference, decisionRule, positiveExamples, negativeExamples, boundaryExamples });

export const seedBusinessRules = async () => {
  const dictionaryPath = dictionaryCandidates.find(fs.existsSync);
  if (!dictionaryPath) return 0;
  const buffer = fs.readFileSync(dictionaryPath);
  const signature = crypto.createHash("sha256").update(buffer).digest("hex");
  const currentSignature = (db.prepare("SELECT value FROM settings WHERE key='business_rule_dictionary_signature'").get() as { value?: string } | undefined)?.value;
  const count = Number((db.prepare("SELECT COUNT(*) count FROM business_rules").get() as { count: number }).count);
  if (count && currentSignature === signature) {
    backfillRuleMetadata();
    invalidateOutdatedFeedbackClassifications();
    return count;
  }
  const parsed = await parseWorkbook({ buffer, originalname: path.basename(dictionaryPath) } as Express.Multer.File);
  db.exec("DELETE FROM business_rules");
  const insert = db.prepare(`
    INSERT INTO business_rules(level1,level2,scenario,business_code,priority,standard_prompt,
      required_condition,excluded_condition,similar_difference,decision_rule,
      positive_examples,negative_examples,boundary_examples,rule_nodes,version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `);
  let inserted = 0;
  for (const row of parsed.rows) {
    const level1 = rowValue(row, "一级分类");
    const level2 = rowValue(row, "二级分类");
    const standardPrompt = rowValue(row, "标准提示词");
    const required = rowValue(row, "必须满足条件");
    const excluded = rowValue(row, "排除条件");
    const similar = rowValue(row, "相似场景区分");
    const decision = rowValue(row, "判定规则");
    const isNew = rowValue(row, "是否新增场景");
    const priority = normalizePriority(row["优先级"]);
    if (level1 && level2 && standardPrompt && decision) {
      const code = `STD-${String(inserted + 1).padStart(3, "0")}`;
      const examples = defaultRuleExamples(level2);
      const finalDecision = isNew ? `${decision}\n是否新增场景：${isNew}` : decision;
      insert.run(
        level1,
        level2,
        level2,
        code,
        priority,
        standardPrompt,
        required,
        excluded,
        similar,
        finalDecision,
        JSON.stringify(examples.positiveExamples),
        JSON.stringify(examples.negativeExamples),
        JSON.stringify(examples.boundaryExamples),
        JSON.stringify(buildNodeFallback(standardPrompt, required, excluded, similar, finalDecision, examples.positiveExamples, examples.negativeExamples, examples.boundaryExamples))
      );
      inserted++;
    }
  }
  const nextVersion = count ? bumpRuleVersion() : 1;
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('business_rule_version',?)").run(String(nextVersion));
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('business_rule_dictionary_signature',?)").run(signature);
  invalidateOutdatedFeedbackClassifications();
  return inserted;
};

export const isDatabaseLockedError = (error: unknown) =>
  error instanceof Error && /database is locked/i.test(error.message);

const backfillRuleMetadata = () => {
  const rows = db.prepare("SELECT * FROM business_rules").all() as unknown as Record<string, unknown>[];
  const update = db.prepare(`
    UPDATE business_rules SET required_condition=?,excluded_condition=?,similar_difference=?,decision_rule=?,
      positive_examples=?,negative_examples=?,boundary_examples=?,rule_nodes=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);
  for (const row of rows) {
    const level2 = String(row.level2 || "");
    const decisionRule = String(row.decision_rule || "");
    const examples = defaultRuleExamples(level2);
    const required = String(row.required_condition || "") || fieldFromDecisionRule(decisionRule, "必须满足");
    const excluded = String(row.excluded_condition || "") || fieldFromDecisionRule(decisionRule, "排除条件");
    const similar = String(row.similar_difference || "") || fieldFromDecisionRule(decisionRule, "相似场景区分");
    const decision = fieldFromDecisionRule(decisionRule, "判定规则") || decisionRule;
    const positiveExamples = normalizedExamples(row.positive_examples, examples.positiveExamples);
    const negativeExamples = normalizedExamples(row.negative_examples, examples.negativeExamples);
    const boundaryExamples = normalizedExamples(row.boundary_examples, examples.boundaryExamples);
    const standardPrompt = String(row.standard_prompt || "");
    const normalizedRequired = required === "无" ? "" : required;
    const normalizedExcluded = excluded === "无" ? "" : excluded;
    const normalizedSimilar = similar === "无" ? "" : similar;
    const ruleNodes = normalizeRuleNodes(row.rule_nodes, buildNodeFallback(standardPrompt, normalizedRequired, normalizedExcluded, normalizedSimilar, decision, positiveExamples, negativeExamples, boundaryExamples));
    update.run(
      normalizedRequired,
      normalizedExcluded,
      normalizedSimilar,
      decision,
      JSON.stringify(positiveExamples),
      JSON.stringify(negativeExamples),
      JSON.stringify(boundaryExamples),
      JSON.stringify(ruleNodes),
      Number(row.id)
    );
  }
};

const invalidateOutdatedFeedbackClassifications = () => {
  db.prepare(`
    UPDATE feedback
    SET status='待重新分析',
      level1='',
      level2='',
      scenario='',
      business_code='',
      confidence=0,
      rationale='分类字典已更新，请重新分析',
      analysis_updated_at=CURRENT_TIMESTAMP
    WHERE status='已分析'
      AND level2 <> ''
      AND NOT EXISTS (
        SELECT 1 FROM business_rules br
        WHERE br.active=1
          AND br.level1=feedback.level1
          AND br.level2=feedback.level2
      )
  `).run();
};

export const listBusinessRules = (level1?: string, level2?: string) => {
  const conditions: string[] = [];
  const params: string[] = [];
  if (level1) { conditions.push("level1=?"); params.push(level1); }
  if (level2) { conditions.push("level2=?"); params.push(level2); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return (db.prepare(`SELECT * FROM business_rules ${where} ORDER BY level1,level2,business_code`).all(...params) as unknown as Record<string, unknown>[]).map(mapRule);
};

const mapRule = (row: Record<string, unknown>): BusinessRule => {
  const examples = defaultRuleExamples(String(row.level2 || ""));
  const rawDecision = String(row.decision_rule || "");
  const standardPrompt = String(row.standard_prompt || "");
  const requiredCondition = String(row.required_condition || fieldFromDecisionRule(rawDecision, "必须满足") || "");
  const excludedCondition = String(row.excluded_condition || fieldFromDecisionRule(rawDecision, "排除条件") || "");
  const similarDifference = String(row.similar_difference || fieldFromDecisionRule(rawDecision, "相似场景区分") || "");
  const decisionRule = fieldFromDecisionRule(rawDecision, "判定规则") || rawDecision;
  const positiveExamples = normalizedExamples(row.positive_examples, examples.positiveExamples);
  const negativeExamples = normalizedExamples(row.negative_examples, examples.negativeExamples);
  const boundaryExamples = normalizedExamples(row.boundary_examples, examples.boundaryExamples);
  const ruleNodes = normalizeRuleNodes(row.rule_nodes, buildNodeFallback(standardPrompt, requiredCondition, excludedCondition, similarDifference, decisionRule, positiveExamples, negativeExamples, boundaryExamples));
  return {
    id: Number(row.id),
    level1: String(row.level1),
    level2: String(row.level2),
    scenario: String(row.scenario),
    businessCode: String(row.business_code),
    priority: normalizePriority(row.priority),
    standardPrompt,
    requiredCondition,
    excludedCondition,
    similarDifference,
    decisionRule,
    positiveExamples,
    negativeExamples,
    boundaryExamples,
    ruleNodes,
    active: Boolean(row.active),
    version: Number(row.version)
  };
};

export const activeBusinessRules = () => listBusinessRules().filter((rule) => rule.active);

type SavePayload = Partial<BusinessRule> & Pick<BusinessRule, "level1" | "level2" | "standardPrompt" | "decisionRule">;

export const saveBusinessRule = (payload: SavePayload) => {
  const version = bumpRuleVersion();
  const code = payload.businessCode?.trim() || `CUSTOM-${String(version).padStart(4, "0")}`;
  const priority = normalizePriority(payload.priority);
  const scenario = payload.scenario?.trim() || payload.level2;
  const defaults = defaultRuleExamples(payload.level2);
  const positiveExamples = normalizedExamples(payload.positiveExamples, defaults.positiveExamples);
  const negativeExamples = normalizedExamples(payload.negativeExamples, defaults.negativeExamples);
  const boundaryExamples = normalizedExamples(payload.boundaryExamples, defaults.boundaryExamples);
  const ruleNodes = normalizeRuleNodes(payload.ruleNodes, buildNodeFallback(
    payload.standardPrompt,
    payload.requiredCondition || "",
    payload.excludedCondition || "",
    payload.similarDifference || "",
    payload.decisionRule,
    positiveExamples,
    negativeExamples,
    boundaryExamples
  ));
  let id = payload.id;
  if (id) {
    db.prepare(`
      UPDATE business_rules SET level1=?,level2=?,scenario=?,business_code=?,priority=?,standard_prompt=?,
        required_condition=?,excluded_condition=?,similar_difference=?,decision_rule=?,
        positive_examples=?,negative_examples=?,boundary_examples=?,rule_nodes=?,active=?,version=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(
      payload.level1,
      payload.level2,
      scenario,
      code,
      priority,
      payload.standardPrompt,
      payload.requiredCondition || "",
      payload.excludedCondition || "",
      payload.similarDifference || "",
      payload.decisionRule,
      JSON.stringify(positiveExamples),
      JSON.stringify(negativeExamples),
      JSON.stringify(boundaryExamples),
      JSON.stringify(ruleNodes),
      payload.active === false ? 0 : 1,
      version,
      id
    );
  } else {
    const result = db.prepare(`
      INSERT INTO business_rules(level1,level2,scenario,business_code,priority,standard_prompt,
        required_condition,excluded_condition,similar_difference,decision_rule,
        positive_examples,negative_examples,boundary_examples,rule_nodes,active,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      payload.level1,
      payload.level2,
      scenario,
      code,
      priority,
      payload.standardPrompt,
      payload.requiredCondition || "",
      payload.excludedCondition || "",
      payload.similarDifference || "",
      payload.decisionRule,
      JSON.stringify(positiveExamples),
      JSON.stringify(negativeExamples),
      JSON.stringify(boundaryExamples),
      JSON.stringify(ruleNodes),
      payload.active === false ? 0 : 1,
      version
    );
    id = Number(result.lastInsertRowid);
  }
  const saved = db.prepare("SELECT * FROM business_rules WHERE id=?").get(id!) as Record<string, unknown>;
  db.prepare("INSERT INTO rule_changes(rule_id,version,action,snapshot) VALUES(?,?,?,?)")
    .run(id!, version, payload.id ? "update" : "create", JSON.stringify(saved));
  return { rule: mapRule(saved), version };
};

export const deleteBusinessRule = (id: number) => {
  const existing = db.prepare("SELECT * FROM business_rules WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!existing) throw new Error("业务场景不存在");
  const version = bumpRuleVersion();
  db.prepare("DELETE FROM business_rules WHERE id=?").run(id);
  db.prepare("INSERT INTO rule_changes(rule_id,version,action,snapshot) VALUES(?,?,?,?)")
    .run(id, version, "delete", JSON.stringify(existing));
  db.prepare(`
    UPDATE feedback
    SET status='待重新分析', level1='', level2='', scenario='', business_code='',
      confidence=0, rationale='业务场景已删除，请重新分析', analysis_updated_at=CURRENT_TIMESTAMP
    WHERE level1=? AND level2=?
  `).run(String(existing.level1), String(existing.level2));
  return { ok: true, version };
};

export const currentRuleVersion = getRuleVersion;
