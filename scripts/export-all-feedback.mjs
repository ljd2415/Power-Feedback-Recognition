import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(path.join(root, "data", "power-feedback.db"));
const rows = db.prepare(`
  SELECT f.id, b.filename, f.user_id, f.username, f.contact, f.submitted_at, f.building,
    f.content, f.keywords, COALESCE(t.name,'其他问题') tag_name, f.priority, f.sentiment,
    f.confidence, f.rationale, f.self_check, f.resolution, f.resident_message,
    f.utility_message, f.status, f.source
  FROM feedback f
  LEFT JOIN tags t ON f.tag_id=t.id
  LEFT JOIN import_batches b ON f.batch_id=b.id
  ORDER BY f.submitted_at DESC, f.id DESC
`).all();

const parse = (value) => {
  try { return JSON.parse(value || "[]").join("、"); } catch { return ""; }
};

const headers = [
  "序号", "来源数据表", "用户ID", "用户名", "联系方式", "反馈提交时间", "楼栋地点",
  "用户反馈文本内容", "核心关键词", "问题分类", "优先级等级", "情感倾向", "置信度",
  "分类判断依据", "一级自主排查方案", "二级处置方案", "住户通知话术",
  "电力公司专业报修说明", "分析状态", "分析来源"
];
const values = rows.map((row, index) => [
  index + 1, row.filename || "", row.user_id, row.username, row.contact, row.submitted_at,
  row.building, row.content, parse(row.keywords), row.tag_name, row.priority, row.sentiment,
  Number(row.confidence), row.rationale, parse(row.self_check), row.resolution,
  row.resident_message, row.utility_message, row.status,
  row.source === "ai" ? "AI分析" : row.source === "manual" ? "人工修正" : "规则分析"
]);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("全部反馈数据");
sheet.showGridLines = false;
sheet.freezePanes.freezeRows(1);
sheet.getRangeByIndexes(0, 0, values.length + 1, headers.length).values = [headers, ...values];
sheet.getRangeByIndexes(0, 0, 1, headers.length).format = {
  fill: "#0B5D4B",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
  rowHeightPx: 34,
  borders: { preset: "all", style: "thin", color: "#C7D8D2" }
};
sheet.getRangeByIndexes(1, 0, values.length, headers.length).format = {
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: "#E0E9E6" }
};
sheet.getRangeByIndexes(1, 12, values.length, 1).format.numberFormat = "0%";

const widths = [55, 150, 90, 85, 115, 145, 110, 330, 180, 125, 75, 90, 75, 260, 280, 300, 360, 430, 85, 85];
widths.forEach((width, index) => {
  sheet.getRangeByIndexes(0, index, values.length + 1, 1).format.columnWidthPx = width;
});
sheet.tables.add(`A1:T${values.length + 1}`, true, "AllFeedbackTable").style = "TableStyleMedium4";

const summary = workbook.worksheets.add("导出说明");
summary.showGridLines = false;
summary.getRange("A1:D1").merge();
summary.getRange("A1").values = [["小区电力用户反馈数据完整导出"]];
summary.getRange("A1:D1").format = {
  fill: "#0B5D4B", font: { bold: true, color: "#FFFFFF", size: 16 },
  verticalAlignment: "center", rowHeightPx: 44
};
summary.getRange("A3:B7").values = [
  ["导出记录数", rows.length],
  ["数据范围", "系统当前全部反馈"],
  ["包含内容", "原始字段、关键词、分类、优先级、情感、两级方案及两套话术"],
  ["隐私提示", "本文件包含用户名和联系方式，请仅限授权运维人员使用"],
  ["生成时间", new Date().toLocaleString("zh-CN", { hour12: false })]
];
summary.getRange("A3:B7").format = {
  wrapText: true, verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D8E4E0" }
};
summary.getRange("A:A").format.columnWidthPx = 130;
summary.getRange("B:B").format.columnWidthPx = 520;
summary.getRange("A3:A7").format = { fill: "#DCEEE8", font: { bold: true, color: "#174A3D" } };

const preview = await workbook.render({ sheetName: "全部反馈数据", range: "A1:H8", scale: 1, format: "png" });
const previewPath = path.join(os.tmpdir(), "all-feedback-export-preview.png");
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const errors = await workbook.inspect({
  kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 }, summary: "formula error scan"
});
console.log(errors.ndjson);

const outputPath = path.join(os.homedir(), "Desktop", "小区电力系统161条反馈完整数据.xlsx");
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewPath, count: rows.length }));
