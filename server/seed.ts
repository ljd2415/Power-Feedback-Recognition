import { format, subDays, subMonths, subYears } from "date-fns";
import { analyzeByRule, contentHash, saveAnalysis } from "./analysis.js";
import { db } from "./db.js";

const samples = [
  ["停电故障", "整栋突然停电了，楼道和家里都没电，请尽快处理"],
  ["电压异常", "晚上灯一直闪，电压忽高忽低，冰箱反复重启"],
  ["线路破损", "楼道电井有电线外皮破损并且能闻到焦糊味"],
  ["电表异常", "这个月电费突然翻倍，怀疑电表走得太快"],
  ["充电桩", "地下车库充电桩一直提示供电故障，充不上电"],
  ["噪音", "配电房晚上嗡嗡响，噪音影响休息"],
  ["设备老化", "配电箱很陈旧，开关频繁跳闸，建议整体检查"],
  ["公共设施", "3号楼楼道灯和公共区域插座都没电"],
  ["咨询", "咨询一下申请峰谷电价需要怎么办理"],
  ["建议", "建议在地下车库增加充电桩和独立电表"],
  ["投诉", "已经多次反映停电一直没人处理，严重影响生活，我要投诉"]
] as const;

export const seedIfEmpty = () => {
  const count = Number((db.prepare("SELECT COUNT(*) count FROM feedback").get() as { count: number }).count);
  if (count) return;
  const batch = db.prepare("INSERT INTO import_batches(filename, row_count) VALUES('系统示例数据.xlsx', 0)").run();
  const batchId = Number(batch.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO feedback(batch_id,user_id,username,contact,submitted_at,building,content,content_hash)
    VALUES(?,?,?,?,?,?,?,?)
  `);
  const dates: Date[] = [];
  const now = new Date();
  for (let i = 0; i < 64; i++) dates.push(subDays(now, i % 28));
  for (let i = 0; i < 45; i++) dates.push(subMonths(subDays(now, i % 24), 1));
  for (let i = 0; i < 52; i++) dates.push(subYears(subDays(now, i % 28), 1));
  for (const [index, date] of dates.entries()) {
    const sample = samples[(index * 7 + date.getDate()) % samples.length];
    const input = {
      userId: `U${String(1001 + index).padStart(5, "0")}`,
      username: ["张先生", "李女士", "王师傅", "陈女士", "赵先生"][index % 5],
      contact: `138${String(10000000 + index).slice(-8)}`,
      submittedAt: `${format(date, "yyyy-MM-dd")} ${String(7 + (index * 3) % 16).padStart(2, "0")}:${String((index * 11) % 60).padStart(2, "0")}:00`,
      building: `${1 + (index * 5) % 12}号楼`,
      content: sample[1]
    };
    const result = insert.run(
      batchId,
      input.userId,
      input.username,
      input.contact,
      input.submittedAt,
      input.building,
      input.content,
      contentHash(input)
    );
    saveAnalysis(Number(result.lastInsertRowid), analyzeByRule(input));
  }
  db.prepare("UPDATE import_batches SET row_count=? WHERE id=?").run(dates.length, batchId);
};
