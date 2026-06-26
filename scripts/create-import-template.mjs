import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const desktop = path.join(os.homedir(), "Desktop");
const outputPath = path.join(desktop, "小区电力用户反馈导入模板.xlsx");
const previewPath = path.join(os.tmpdir(), "power-feedback-template-preview.png");

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("反馈数据");
const guide = workbook.worksheets.add("填写说明");

sheet.showGridLines = false;
sheet.freezePanes.freezeRows(1);
sheet.getRange("A1:F4").values = [
  ["反馈提交时间", "楼栋地点", "用户反馈文本内容", "用户名", "用户ID", "联系方式"],
  ["2026-06-23 09:30:00", "1号楼2单元", "家中突然停电，检查空开后仍未恢复，邻居家供电正常。", "张先生", "U00001", "13800000001"],
  ["2026-06-23 19:15:00", "3号楼地下车库", "充电桩提示供电故障，车辆无法开始充电。", "李女士", "U00002", "13800000002"],
  ["2026-06-24 08:10:00", "5号楼", "建议检查楼道配电箱，近期夜间经常发出嗡嗡声。", "王先生", "U00003", "13800000003"]
];

sheet.getRange("A1:F1").format = {
  fill: "#0B5D4B",
  font: { bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D8E4E0" }
};
sheet.getRange("A2:F1000").format = {
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#E2EAE7" }
};
sheet.getRange("A2:A1000").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
sheet.getRange("C2:C1000").format.wrapText = true;
sheet.getRange("A1:F1").format.rowHeightPx = 32;
sheet.getRange("A2:F4").format.rowHeightPx = 48;
sheet.getRange("A:A").format.columnWidthPx = 165;
sheet.getRange("B:B").format.columnWidthPx = 130;
sheet.getRange("C:C").format.columnWidthPx = 420;
sheet.getRange("D:D").format.columnWidthPx = 100;
sheet.getRange("E:E").format.columnWidthPx = 105;
sheet.getRange("F:F").format.columnWidthPx = 135;
sheet.getRange("A2:A1000").dataValidation = {
  rule: {
    type: "date",
    operator: "between",
    formula1: "2000-01-01",
    formula2: "2100-12-31"
  }
};

const table = sheet.tables.add("A1:F4", true, "FeedbackImportTable");
table.style = "TableStyleMedium4";
table.showFilterButton = true;

guide.showGridLines = false;
guide.getRange("A1:D1").merge();
guide.getRange("A1").values = [["小区电力用户反馈导入模板 · 填写说明"]];
guide.getRange("A1:D1").format = {
  fill: "#0B5D4B",
  font: { bold: true, color: "#FFFFFF", size: 16 },
  horizontalAlignment: "left",
  verticalAlignment: "center"
};
guide.getRange("A1:D1").format.rowHeightPx = 44;
guide.getRange("A3:D10").values = [
  ["字段名称", "是否必填", "填写要求", "示例"],
  ["反馈提交时间", "必填", "请填写可识别的日期时间，建议格式：年-月-日 时:分:秒", "2026-06-23 09:30:00"],
  ["楼栋地点", "必填", "尽量填写到楼栋、单元或公共区域", "1号楼2单元"],
  ["用户反馈文本内容", "必填", "完整描述故障现象、影响范围和已完成的排查", "整栋停电，楼道也无电"],
  ["用户名", "选填", "住户姓名或称呼", "张先生"],
  ["用户ID", "选填", "物业或业务系统中的用户编号", "U00001"],
  ["联系方式", "选填", "联系电话，建议按文本格式填写", "13800000001"],
  ["单次导入限制", "-", "最多10000条；请勿修改第一行字段名称", "-"]
];
guide.getRange("A3:D3").format = {
  fill: "#DCEEE8",
  font: { bold: true, color: "#174A3D" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#BFD4CD" }
};
guide.getRange("A4:D10").format = {
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D8E4E0" }
};
guide.getRange("A:A").format.columnWidthPx = 145;
guide.getRange("B:B").format.columnWidthPx = 85;
guide.getRange("C:C").format.columnWidthPx = 390;
guide.getRange("D:D").format.columnWidthPx = 210;
guide.getRange("A4:D10").format.rowHeightPx = 42;
guide.getRange("A12:D13").merge();
guide.getRange("A12").values = [[
  "提示：系统会根据反馈文本自动提取关键词、判定问题类型和优先级，并生成住户自查方案、后续处置方案及通知话术。示例数据可直接删除后填写正式数据。"
]];
guide.getRange("A12:D13").format = {
  fill: "#FFF4DD",
  font: { color: "#77531C" },
  wrapText: true,
  verticalAlignment: "center",
  horizontalAlignment: "left"
};

const preview = await workbook.render({
  sheetName: "反馈数据",
  range: "A1:F4",
  scale: 1.2,
  format: "png"
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const inspect = await workbook.inspect({
  kind: "table",
  range: "反馈数据!A1:F4",
  include: "values,formulas",
  tableMaxRows: 5,
  tableMaxCols: 6
});
console.log(inspect.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 50 },
  summary: "final formula error scan"
});
console.log(errors.ndjson);

await fs.mkdir(desktop, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({ outputPath, previewPath }));
