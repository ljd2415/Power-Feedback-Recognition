import { dashboard, type Period } from "./stats.js";
import { currentRuleVersion } from "./business-rules.js";
import { db } from "./db.js";

const fallbackSections = (data: ReturnType<typeof dashboard>) => {
  const topTypes = data.typeDistribution.slice(0, 5).map((item) => `${item.name}${item.value}条`).join("、");
  const topBuildings = data.buildingStats.slice(0, 3).map((item) => `${item.name}${item.value}条`).join("、");
  return {
    overview: `本统计周期共收到${data.total}条反馈，其中紧急优先级${data.highPriority}条，负面投诉占比${data.complaintRate.toFixed(1)}%。`,
    classification: `一级业务分类中，数量较多的类别为${topTypes || "暂无已分析分类"}，应优先核查高频场景对应的服务流程与设备状态。`,
    priority: `紧急优先级反馈${data.highPriority}条，应立即确认安全风险和影响范围；其余反馈按风险、一般或待定口径处理。`,
    spacetime: `楼栋反馈主要集中在${topBuildings || "暂无集中楼栋"}。时间趋势应结合图表中的峰值时段安排巡检力量。`,
    comparison: `最新周期反馈总量环比${data.comparisonTrend.at(-1)?.momLabel || "数据不足"}、同比${data.comparisonTrend.at(-1)?.yoyLabel || "数据不足"}。`,
    sentiment: `负面投诉占比${data.complaintRate.toFixed(1)}%，需复核多次反映、久未处理等服务闭环问题。`,
    diagnosis: `故障原因研判仅基于反馈聚合特征。应围绕高频业务类别、集中楼栋和异常增长指标开展现场检测后确认。`,
    alerts: data.alerts.length ? data.alerts.map((item) => `${item.title}（${item.detail}）`).join("；") : "本期未触发涨幅超过30%的异常预警。",
    actions: `紧急优先级反馈立即核实并派单；高频业务场景制定专项排查清单；集中楼栋安排配电设施巡检；咨询建议类统一形成标准答复。`
  };
};

export const generateAiReport = (batchId: number, ownerUserId: number, period: Period) => {
  const version = currentRuleVersion();
  const result = db.prepare(`
    INSERT INTO report_snapshots(batch_id,owner_user_id,period,rule_version,status)
    VALUES(?,?,?,?,'running')
  `).run(batchId, ownerUserId, period, version);
  const id = Number(result.lastInsertRowid);
  queueMicrotask(async () => {
    const data = dashboard(period, undefined, batchId);
    let content = fallbackSections(data);
    try {
      if (process.env.OPENAI_API_KEY) {
        const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
            temperature: 0.15,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "你是电力运维数据分析师。根据给定的准确统计数据生成JSON报告，字段固定为overview、classification、priority、spacetime、comparison、sentiment、diagnosis、alerts、actions。每项80-160字，必须引用具体数字、业务分类、楼栋或变化率；没有证据时明确说明数据不足，禁止空泛表述或虚构原因。" },
              { role: "user", content: JSON.stringify({ period: data.currentPeriod, metrics: data }) }
            ]
          }),
          signal: AbortSignal.timeout(60000)
        });
        if (response.ok) {
          const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
          const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
          if (parsed.overview && parsed.classification) content = { ...content, ...parsed };
        }
      }
      db.prepare("UPDATE report_snapshots SET status='completed',content=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(content), id);
    } catch (error) {
      db.prepare("UPDATE report_snapshots SET status='completed',content=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(JSON.stringify(content), error instanceof Error ? error.message : "AI报告生成失败，已使用数据报告", id);
    }
  });
  return id;
};

export const latestAiReport = (batchId: number, ownerUserId: number, period: Period) => {
  const row = db.prepare(`
    SELECT id,status,content,error,rule_version ruleVersion,created_at createdAt,updated_at updatedAt
    FROM report_snapshots WHERE batch_id=? AND owner_user_id=? AND period=?
    ORDER BY id DESC LIMIT 1
  `).get(batchId, ownerUserId, period) as Record<string, unknown> | undefined;
  if (!row) return null;
  let content = {};
  try { content = JSON.parse(String(row.content || "{}")); } catch {}
  return { ...row, content, stale: row.status === "stale" || Number(row.ruleVersion) !== currentRuleVersion() };
};
