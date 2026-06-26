import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { parseWorkbook } from "./importer.js";

test("Excel导入可识别标准中文字段和数据行", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("反馈数据");
  sheet.addRow(["反馈提交时间", "楼栋地点", "用户反馈文本内容", "用户名", "用户ID", "联系方式"]);
  sheet.addRow(["2026-06-23 09:30:00", "1号楼", "家中突然停电", "张先生", "U001", "13800000000"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseWorkbook({ buffer, originalname: "测试.xlsx" } as Express.Multer.File);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.mapping.submittedAt, "反馈提交时间");
  assert.equal(parsed.mapping.building, "楼栋地点");
  assert.equal(parsed.mapping.content, "用户反馈文本内容");
});

test("Excel导入允许选填用户字段缺失", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("反馈数据");
  sheet.addRow(["反馈提交时间", "楼栋地点", "用户反馈文本内容"]);
  sheet.addRow(["2026-06-23 09:30:00", "1号楼", "家中突然停电"]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseWorkbook({ buffer, originalname: "测试.xlsx" } as Express.Multer.File);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.mapping.submittedAt, "反馈提交时间");
  assert.equal(parsed.mapping.username, undefined);
});

test("Excel导入可解析xls格式", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["反馈提交时间", "楼栋地点", "用户反馈文本内容"],
    ["2026-06-23 09:30:00", "2号楼", "电压不稳灯闪"]
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "反馈数据");
  const buffer = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xls" }));
  const parsed = await parseWorkbook({ buffer, originalname: "测试.xls" } as Express.Multer.File);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.mapping.content, "用户反馈文本内容");
});
