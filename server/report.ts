import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import PDFDocument from "pdfkit";
import { dashboard, type Period } from "./stats.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(root, "reports");
fs.mkdirSync(reportDir, { recursive: true });

const reportSections = (period: Period, date?: string, batchId?: number) => {
  const data = dashboard(period, date, batchId);
  const topType = data.typeDistribution[0];
  const topBuilding = data.buildingStats[0];
  const topKeyword = data.keywordStats[0];
  const priorityText = data.priorityDistribution.map((item) => `${item.name}优先级${item.value}条`).join("，");
  const typeText = data.typeDistribution.slice(0, 6).map((item) => `${item.name}${item.value}条`).join("，");
  const alertText = data.alerts.length
    ? data.alerts.map((item) => `${item.title}：${item.detail}`).join("；")
    : "本期未发现同比或环比涨幅超过30%的异常指标。";
  const cause = [
    topType?.name.includes("老化") ? "设备老化和绝缘性能下降" : "",
    topType?.name.includes("停电") || topType?.name.includes("电压") ? "集中用电时段负荷增长或线路损耗" : "",
    data.highPriority > Math.max(2, data.total * 0.2) ? "紧急优先级事件集中，可能存在共性供配电薄弱环节" : "",
    topBuilding ? `${topBuilding.name}反馈集中，建议核查该楼栋配电支路和公共设施` : ""
  ].filter(Boolean).join("；") || "现有数据未形成单一明确诱因，建议结合现场巡检记录进一步确认。";
  return {
    data,
    sections: [
      ["数据概览", `统计周期：${data.currentPeriod}；共分析反馈${data.total}条，紧急优先级${data.highPriority}条，负面投诉占比${data.complaintRate.toFixed(1)}%，标签体系版本V${data.tagVersion}。`],
      ["关键词与问题分类分析", `高频关键词以“${topKeyword?.name || "暂无"}”为代表。主要问题分布：${typeText || "暂无数据"}。当前高发类型为${topType?.name || "暂无"}。`],
      ["优先级分布分析", priorityText || "暂无优先级数据。"],
      ["时空分布分析", `${topBuilding ? `${topBuilding.name}反馈最多，共${topBuilding.value}条。` : "暂无楼栋数据。"}应结合时段趋势重点安排巡检。`],
      ["同比环比专项分析", `反馈总量环比${data.comparisonTrend.at(-1)?.momLabel || "数据不足"}，同比${data.comparisonTrend.at(-1)?.yoyLabel || "数据不足"}。统计口径为北京时间自然周期，周一至周日为一周。`],
      ["情感分析", `负面投诉占比${data.complaintRate.toFixed(1)}%。投诉、举报和安全风险类内容按字典场景进入较高处置优先级。`],
      ["故障原因研判（综合推断）", `${cause}。以上仅为基于分类、时空分布和波动特征的综合推断，不作为已确认故障结论。`],
      ["故障预警", alertText],
      ["批量整改处置建议", "紧急优先级：立即电话确认影响范围，隔离风险并组织现场抢修；风险优先级：纳入计划工单，完成线路、电压和设备检测；一般优先级：集中答复咨询，评估建议并安排低峰时段维护；待定优先级：先补充信息并人工确认。"]
    ] as [string, string][]
  };
};

const tableFor = (headers: string[], rows: (string | number)[][]) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((header) =>
          new TableCell({
            shading: { fill: "0B5D4B" },
            children: [new Paragraph({ children: [new TextRun({ text: header, bold: true, color: "FFFFFF" })] })]
          })
        )
      }),
      ...rows.map((row) =>
        new TableRow({
          children: row.map((value) => new TableCell({ children: [new Paragraph(String(value))] }))
        })
      )
    ]
  });

export const createDocx = async (period: Period, date?: string, batchId?: number) => {
  const { data, sections } = reportSections(period, date, batchId);
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: "小区电力用户反馈总体分析报告", bold: true, size: 36, color: "0B5D4B" })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun(`统计周期：${data.currentPeriod}　标签版本：V${data.tagVersion}`)]
    })
  ];
  for (const [title, content] of sections) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
    children.push(new Paragraph({ text: content, spacing: { after: 180, line: 360 } }));
    if (title === "关键词与问题分类分析") {
      children.push(tableFor(["问题类型", "数量", "占比"], data.typeDistribution.map((item) => [item.name, item.value, data.total ? `${((item.value / data.total) * 100).toFixed(1)}%` : "0%"])));
    }
    if (title === "故障预警" && data.alerts.length) {
      children.push(tableFor(["预警指标", "说明", "变化率"], data.alerts.map((item) => [item.title, item.detail, `${item.rate.toFixed(1)}%`])));
    }
  }
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Microsoft YaHei", size: 21 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", run: { bold: true, color: "0B5D4B", size: 28 } }
      ]
    },
    sections: [{ properties: { page: { margin: { top: 1000, right: 1000, bottom: 1000, left: 1000 } } }, children }]
  });
  return Packer.toBuffer(doc);
};

export const streamPdf = (period: Period, date: string | undefined, output: NodeJS.WritableStream, batchId?: number) => {
  const { data, sections } = reportSections(period, date, batchId);
  const doc = new PDFDocument({ size: "A4", margins: { top: 52, left: 56, right: 56, bottom: 52 }, info: { Title: "小区电力用户反馈总体分析报告" } });
  const fonts = ["C:\\Windows\\Fonts\\simhei.ttf"];
  const font = fonts.find(fs.existsSync);
  if (font) doc.font(font);
  doc.pipe(output);
  doc.fillColor("#0b5d4b").fontSize(20).text("小区电力用户反馈总体分析报告", { align: "center" });
  doc.moveDown(0.5).fillColor("#52645f").fontSize(10).text(`统计周期：${data.currentPeriod}　标签体系：V${data.tagVersion}`, { align: "center" });
  doc.moveDown(1.4);
  for (const [title, content] of sections) {
    if (doc.y > 730) doc.addPage();
    doc.fillColor("#0b5d4b").fontSize(14).text(title);
    doc.moveDown(0.35).fillColor("#23332f").fontSize(10.5).text(content, { lineGap: 5 });
    doc.moveDown(0.8);
  }
  doc.end();
};
