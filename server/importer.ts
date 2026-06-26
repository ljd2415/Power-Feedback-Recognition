import type { Express } from "express";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { format } from "date-fns";
import { db } from "./db.js";

const aliases: Record<string, string[]> = {
  submittedAt: ["反馈提交时间", "提交时间", "反馈时间", "时间", "日期"],
  building: ["楼栋地点", "楼栋", "地点", "故障位置", "位置"],
  content: ["用户反馈文本内容", "反馈内容", "反馈文本", "问题描述", "内容"],
  username: ["用户名", "用户姓名", "姓名", "住户姓名"],
  userId: ["用户id", "用户ID", "住户id", "客户编号"],
  contact: ["联系方式", "联系电话", "手机号", "电话"]
};

const contentHash = (input: { submittedAt: string; building: string; content: string; userId: string }) =>
  crypto.createHash("sha256").update(`${input.submittedAt}|${input.building}|${input.content}|${input.userId}`).digest("hex");

const detectMapping = (headers: string[]) => {
  const result: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const found = headers.find((header) => names.some((name) => header.trim().toLowerCase() === name.toLowerCase()));
    if (found) result[field] = found;
  }
  return result;
};

const normalizeDate = (value: unknown) => {
  if (value instanceof Date) return format(value, "yyyy-MM-dd HH:mm:ss");
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return format(date, "yyyy-MM-dd HH:mm:ss");
  }
  const date = new Date(String(value));
  if (!Number.isNaN(date.getTime())) return format(date, "yyyy-MM-dd HH:mm:ss");
  return "";
};

const cellValue = (value: ExcelJS.CellValue): unknown => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "result" in value) return value.result ?? "";
  if (typeof value === "object" && "text" in value) return value.text;
  if (typeof value === "object" && "richText" in value) return value.richText.map((part) => part.text).join("");
  return value;
};

const decodeXml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const columnIndex = (reference: string) => {
  const letters = reference.match(/[A-Z]+/)?.[0] || "A";
  return [...letters].reduce((result, char) => result * 26 + char.charCodeAt(0) - 64, 0) - 1;
};

const parseXlsxFallback = async (buffer: Buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedXml
    ? [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) =>
        decodeXml([...match[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((part) => part[1]).join(""))
      )
    : [];
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetFile) return { rows: [] as Record<string, unknown>[], headers: [] as string[], mapping: {} };
  const xml = await sheetFile.async("string");
  const matrix: unknown[][] = [];
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const row: unknown[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attributes.match(/\br="([^"]+)"/)?.[1] || "A1";
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || "";
      const raw = body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? "";
      const inline = [...body.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((part) => part[1]).join("");
      let value: unknown = inline ? decodeXml(inline) : decodeXml(raw);
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (!type && raw !== "" && Number.isFinite(Number(raw))) value = Number(raw);
      row[columnIndex(reference)] = value;
    }
    matrix.push(row);
  }
  const headers = (matrix[0] || []).map((value) => String(value ?? "").trim());
  const rows = matrix.slice(1).map((row) => {
    const item: Record<string, unknown> = {};
    headers.forEach((header, index) => { item[header] = row[index] ?? ""; });
    return item;
  }).filter((row) => Object.values(row).some((value) => String(value).trim()));
  return { rows, headers, mapping: detectMapping(headers) };
};

const parseLegacyWorkbook = (buffer: Buffer) => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [] as Record<string, unknown>[], headers: [] as string[], mapping: {} };
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
  const headers = (matrix[0] || []).map((value) => String(value ?? "").trim());
  const rows = matrix.slice(1).map((row) => {
    const item: Record<string, unknown> = {};
    headers.forEach((header, index) => { item[header] = row[index] ?? ""; });
    return item;
  }).filter((row) => Object.values(row).some((value) => String(value).trim()));
  return { rows, headers, mapping: detectMapping(headers) };
};

export const parseWorkbook = async (file: Express.Multer.File) => {
  const workbook = new ExcelJS.Workbook();
  const lower = file.originalname.toLowerCase();
  if (lower.endsWith(".xls")) return parseLegacyWorkbook(file.buffer);
  if (lower.endsWith(".csv")) await workbook.csv.read(Readable.from(file.buffer));
  else {
    try {
      await workbook.xlsx.load(Buffer.from(file.buffer) as unknown as ExcelJS.Buffer);
    } catch {
      return parseXlsxFallback(file.buffer);
    }
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], headers: [], mapping: {} };
  const headers = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((value) => String(cellValue(value)).trim());
  const rows: Record<string, unknown>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item: Record<string, unknown> = {};
    headers.forEach((header, index) => { item[header] = cellValue(row.getCell(index + 1).value); });
    if (Object.values(item).some((value) => String(value).trim())) rows.push(item);
  });
  return { rows, headers, mapping: detectMapping(headers) };
};

export const importRows = async (
  filename: string,
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
  ownerUserId: number
) => {
  for (const required of ["submittedAt", "building", "content"]) {
    if (!mapping[required]) throw new Error(`缺少必填字段映射：${required}`);
  }
  if (rows.length > 10000) throw new Error("单次最多导入10000条反馈");
  const decodedFilename = /[ÃÂäåæçé]/.test(filename)
    ? Buffer.from(filename, "latin1").toString("utf8")
    : filename;
  const batch = db.prepare("INSERT INTO import_batches(filename, row_count, owner_user_id) VALUES(?, 0, ?)").run(decodedFilename, ownerUserId);
  const batchId = Number(batch.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO feedback(batch_id,user_id,username,contact,submitted_at,building,content,content_hash)
    VALUES(?,?,?,?,?,?,?,?)
  `);
  let imported = 0;
  const errors: string[] = [];
  const seenHashes = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const input = {
      userId: String(row[mapping.userId] ?? ""),
      username: String(row[mapping.username] ?? ""),
      contact: String(row[mapping.contact] ?? ""),
      submittedAt: normalizeDate(row[mapping.submittedAt]),
      building: String(row[mapping.building] ?? "").trim(),
      content: String(row[mapping.content] ?? "").trim()
    };
    if (!input.submittedAt || !input.building || !input.content) {
      errors.push(`第${index + 2}行必填字段无效`);
      continue;
    }
    const hash = contentHash(input);
    if (seenHashes.has(hash)) {
      errors.push(`第${index + 2}行与本文件其他记录重复`);
      continue;
    }
    seenHashes.add(hash);
    try {
      const result = insert.run(
        batchId,
        input.userId,
        input.username,
        input.contact,
        input.submittedAt,
        input.building,
        input.content,
        hash
      );
      imported++;
    } catch (error) {
      if (String(error).includes("UNIQUE")) errors.push(`第${index + 2}行与本文件其他记录重复`);
      else errors.push(`第${index + 2}行导入失败`);
    }
  }
  if (imported === 0) {
    db.prepare("DELETE FROM import_batches WHERE id=?").run(batchId);
    return { imported, errors: errors.slice(0, 100), batchId: undefined };
  }
  db.prepare("UPDATE import_batches SET row_count=? WHERE id=?").run(imported, batchId);
  return { imported, errors: errors.slice(0, 100), batchId };
};
