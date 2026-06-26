import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "power-feedback.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    keywords TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'preset',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER,
    user_id TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL,
    building TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    tag_id INTEGER,
    priority TEXT NOT NULL DEFAULT '中',
    sentiment TEXT NOT NULL DEFAULT '常规报修',
    confidence REAL NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL DEFAULT '',
    self_check TEXT NOT NULL DEFAULT '[]',
    resolution TEXT NOT NULL DEFAULT '',
    resident_message TEXT NOT NULL DEFAULT '',
    utility_message TEXT NOT NULL DEFAULT '',
    analysis_error TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '待分析',
    source TEXT NOT NULL DEFAULT 'rule',
    content_hash TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(batch_id) REFERENCES import_batches(id),
    FOREIGN KEY(tag_id) REFERENCES tags(id)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_date ON feedback(submitted_at);
  CREATE INDEX IF NOT EXISTS idx_feedback_tag ON feedback(tag_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_building ON feedback(building);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_hash ON feedback(content_hash) WHERE content_hash <> '';
  CREATE TABLE IF NOT EXISTS tag_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposed_name TEXT NOT NULL,
    definition TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]',
    boundary_text TEXT NOT NULL DEFAULT '',
    rationale TEXT NOT NULL DEFAULT '',
    similar_tag TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '待审核',
    feedback_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(feedback_id) REFERENCES feedback(id)
  );
  CREATE TABLE IF NOT EXISTS classification_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id INTEGER NOT NULL,
    old_tag_id INTEGER,
    new_tag_id INTEGER,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS business_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level1 TEXT NOT NULL,
    level2 TEXT NOT NULL,
    scenario TEXT NOT NULL,
    business_code TEXT NOT NULL UNIQUE,
    priority TEXT NOT NULL DEFAULT '一般',
    standard_prompt TEXT NOT NULL,
    decision_rule TEXT NOT NULL,
    required_condition TEXT NOT NULL DEFAULT '',
    excluded_condition TEXT NOT NULL DEFAULT '',
    similar_difference TEXT NOT NULL DEFAULT '',
    positive_examples TEXT NOT NULL DEFAULT '[]',
    negative_examples TEXT NOT NULL DEFAULT '[]',
    boundary_examples TEXT NOT NULL DEFAULT '[]',
    rule_nodes TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS rule_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'analysis',
    status TEXT NOT NULL DEFAULT 'pending',
    total INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY(batch_id) REFERENCES import_batches(id),
    FOREIGN KEY(owner_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS analysis_job_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    feedback_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY(feedback_id) REFERENCES feedback(id) ON DELETE CASCADE,
    UNIQUE(job_id, feedback_id)
  );
  CREATE TABLE IF NOT EXISTS report_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    period TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    content TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const batchColumns = db.prepare("PRAGMA table_info(import_batches)").all() as unknown as { name: string }[];
if (!batchColumns.some((column) => column.name === "owner_user_id")) {
  db.exec("ALTER TABLE import_batches ADD COLUMN owner_user_id INTEGER REFERENCES users(id)");
}
const feedbackColumns = db.prepare("PRAGMA table_info(feedback)").all() as unknown as { name: string }[];
const addFeedbackColumn = (name: string, definition: string) => {
  if (!feedbackColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${definition}`);
  }
};
addFeedbackColumn("level1", "TEXT NOT NULL DEFAULT ''");
addFeedbackColumn("level2", "TEXT NOT NULL DEFAULT ''");
addFeedbackColumn("scenario", "TEXT NOT NULL DEFAULT ''");
addFeedbackColumn("business_code", "TEXT NOT NULL DEFAULT ''");
addFeedbackColumn("rule_version", "INTEGER NOT NULL DEFAULT 0");
addFeedbackColumn("analysis_updated_at", "TEXT");
addFeedbackColumn("analysis_error", "TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE feedback SET status='待重新分析' WHERE level1='' AND status='已分析'").run();

const businessRuleColumns = db.prepare("PRAGMA table_info(business_rules)").all() as unknown as { name: string }[];
if (!businessRuleColumns.some((column) => column.name === "priority")) {
  db.exec("ALTER TABLE business_rules ADD COLUMN priority TEXT NOT NULL DEFAULT '一般'");
}
const addBusinessRuleColumn = (name: string, definition: string) => {
  if (!businessRuleColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE business_rules ADD COLUMN ${name} ${definition}`);
  }
};
addBusinessRuleColumn("required_condition", "TEXT NOT NULL DEFAULT ''");
addBusinessRuleColumn("excluded_condition", "TEXT NOT NULL DEFAULT ''");
addBusinessRuleColumn("similar_difference", "TEXT NOT NULL DEFAULT ''");
addBusinessRuleColumn("positive_examples", "TEXT NOT NULL DEFAULT '[]'");
addBusinessRuleColumn("negative_examples", "TEXT NOT NULL DEFAULT '[]'");
addBusinessRuleColumn("boundary_examples", "TEXT NOT NULL DEFAULT '[]'");
addBusinessRuleColumn("rule_nodes", "TEXT NOT NULL DEFAULT '[]'");
db.exec(`
  DROP INDEX IF EXISTS idx_feedback_hash;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_batch_hash
  ON feedback(batch_id, content_hash) WHERE content_hash <> '';
`);

const initialTags = [
  ["停电故障", "住宅或区域供电中断", ["断电", "没电", "停电", "跳闸"], ["无电", "供电中断"]],
  ["电压异常", "电压过高、过低或波动", ["电压", "忽高忽低", "灯闪", "电器重启"], ["电压不稳"]],
  ["线路破损故障", "线路外露、破损、短路或烧焦", ["电线破", "裸露", "短路", "烧焦", "火花"], ["线缆破损"]],
  ["电表计量异常", "电表读数、计费或设备运行异常", ["电表", "电费", "计量", "读数", "走得快"], ["计费异常"]],
  ["充电桩用电问题", "新能源汽车充电设施供电问题", ["充电桩", "充不上", "充电枪"], ["充电设施"]],
  ["配电设备噪音", "变压器、配电柜等设备噪声", ["噪音", "嗡嗡", "异响", "震动"], ["设备异响"]],
  ["线路设备老化", "线路、开关或设备因老化产生的问题", ["老化", "锈蚀", "陈旧", "频繁故障"], ["设备老旧"]],
  ["公共配电设施故障", "楼道、公共区域配电设施故障", ["楼道灯", "配电箱", "公共区域", "电井", "路灯"], ["公共用电故障"]],
  ["用电咨询", "用电政策、缴费、容量等咨询", ["咨询", "怎么", "如何", "办理", "收费"], ["业务咨询"]],
  ["设施优化建议", "对用电设施或服务的改进建议", ["建议", "希望", "增加", "改造", "优化"], ["改进建议"]],
  ["其他问题", "暂时无法归入其他类别的问题", [], ["未分类"]]
] as const;

const tagCount = Number((db.prepare("SELECT COUNT(*) AS count FROM tags").get() as { count: number }).count);
if (false && !tagCount) {
  const insert = db.prepare(
    "INSERT INTO tags(name, description, keywords, aliases, version, source) VALUES(?, ?, ?, ?, 1, 'preset')"
  );
  for (const [name, description, keywords, aliases] of initialTags) {
    insert.run(name, description, JSON.stringify(keywords), JSON.stringify(aliases));
  }
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('tag_version', '1')").run();
}

export const getTagVersion = () =>
  Number((db.prepare("SELECT value FROM settings WHERE key='tag_version'").get() as { value?: string })?.value || 1);

export const bumpTagVersion = () => {
  const next = getTagVersion() + 1;
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('tag_version', ?)").run(String(next));
  return next;
};

export const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

export const getRuleVersion = () =>
  Number((db.prepare("SELECT value FROM settings WHERE key='business_rule_version'").get() as { value?: string })?.value || 1);

export const bumpRuleVersion = () => {
  const version = getRuleVersion() + 1;
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('business_rule_version',?)").run(String(version));
  return version;
};
