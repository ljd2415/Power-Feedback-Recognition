import { analyzeFeedback, saveAnalysis, type AnalysisInput } from "./analysis.js";
import { db } from "./db.js";

let workerRunning = false;

export const createAnalysisJob = (batchId: number, ownerUserId: number, feedbackIds: number[], initialStatus = "待分析") => {
  const uniqueIds = [...new Set(feedbackIds)];
  if (!uniqueIds.length) throw new Error("没有可分析的反馈");
  const result = db.prepare(`
    INSERT INTO analysis_jobs(batch_id,owner_user_id,total,status) VALUES(?,?,?,'pending')
  `).run(batchId, ownerUserId, uniqueIds.length);
  const jobId = Number(result.lastInsertRowid);
  db.prepare("UPDATE report_snapshots SET status='stale',updated_at=CURRENT_TIMESTAMP WHERE batch_id=? AND status='completed'").run(batchId);
  const insert = db.prepare("INSERT INTO analysis_job_items(job_id,feedback_id) VALUES(?,?)");
  for (const id of uniqueIds) insert.run(jobId, id);
  db.prepare(`UPDATE feedback SET status=? WHERE id IN (${uniqueIds.map(() => "?").join(",")})`).run(initialStatus, ...uniqueIds);
  queueMicrotask(runWorker);
  return jobId;
};

const getInput = (feedbackId: number) =>
  db.prepare(`
    SELECT id,user_id userId,username,contact,submitted_at submittedAt,building,content
    FROM feedback WHERE id=?
  `).get(feedbackId) as AnalysisInput | undefined;

const processItem = async (item: { id: number; feedback_id: number; job_id: number }) => {
  db.prepare("UPDATE analysis_job_items SET status='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(item.id);
  db.prepare("UPDATE feedback SET status=CASE WHEN status='正在重新分析' THEN status ELSE '分析中' END WHERE id=?").run(item.feedback_id);
  try {
    const input = getInput(item.feedback_id);
    if (!input) throw new Error("反馈不存在");
    const result = await analyzeFeedback(input);
    saveAnalysis(item.feedback_id, result);
    db.prepare("UPDATE analysis_job_items SET status='succeeded',error='',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(item.id);
    db.prepare("UPDATE analysis_jobs SET completed=completed+1,succeeded=succeeded+1 WHERE id=?").run(item.job_id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "分析失败";
    db.prepare(`
      UPDATE feedback SET status='分析失败',keywords='[]',confidence=0,rationale='',self_check='[]',
        resolution='',resident_message='',utility_message='',level1='',level2='',scenario='',
        business_code='',analysis_error=?,analysis_updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(message, item.feedback_id);
    db.prepare("UPDATE analysis_job_items SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(message, item.id);
    db.prepare("UPDATE analysis_jobs SET completed=completed+1,failed=failed+1 WHERE id=?").run(item.job_id);
    return false;
  }
};

export const runWorker = async () => {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (true) {
      const job = db.prepare(`
        SELECT * FROM analysis_jobs WHERE status IN ('pending','running') ORDER BY id DESC LIMIT 1
      `).get() as { id: number } | undefined;
      if (!job) break;
      db.prepare("UPDATE analysis_jobs SET status='running',started_at=COALESCE(started_at,CURRENT_TIMESTAMP) WHERE id=?").run(job.id);
      const concurrency = Math.max(1, Math.min(6, Number(process.env.AI_CONCURRENCY || 5)));
      const items = db.prepare(`
        SELECT id,feedback_id,job_id FROM analysis_job_items
        WHERE job_id=? AND status IN ('pending','running') ORDER BY id LIMIT ?
      `).all(job.id, concurrency) as unknown as { id: number; feedback_id: number; job_id: number }[];
      if (!items.length) {
        const counts = db.prepare(`
          SELECT COUNT(*) total,
            SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) succeeded,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
          FROM analysis_job_items WHERE job_id=?
        `).get(job.id) as { total: number; succeeded: number; failed: number };
        db.prepare(`
          UPDATE analysis_jobs SET status=?,completed=?,succeeded=?,failed=?,finished_at=CURRENT_TIMESTAMP WHERE id=?
        `).run(counts.failed ? "completed_with_errors" : "completed", counts.total, counts.succeeded || 0, counts.failed || 0, job.id);
        continue;
      }
      await Promise.all(items.map(processItem));
      const counts = db.prepare(`
        SELECT SUM(CASE WHEN status IN ('succeeded','failed') THEN 1 ELSE 0 END) completed,
          SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) succeeded,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed
        FROM analysis_job_items WHERE job_id=?
      `).get(job.id) as { completed: number; succeeded: number; failed: number };
      db.prepare("UPDATE analysis_jobs SET completed=?,succeeded=?,failed=? WHERE id=?")
        .run(counts.completed || 0, counts.succeeded || 0, counts.failed || 0, job.id);
    }
  } finally {
    workerRunning = false;
  }
};

export const getJob = (jobId: number, ownerUserId: number) => {
  const job = db.prepare(`
    SELECT id,batch_id batchId,status,total,completed,succeeded,failed,created_at createdAt,
      started_at startedAt,finished_at finishedAt
    FROM analysis_jobs WHERE id=? AND owner_user_id=?
  `).get(jobId, ownerUserId) as Record<string, unknown> | undefined;
  if (!job) return null;
  return { ...job, percent: Number(job.total) ? Math.round(Number(job.completed) / Number(job.total) * 100) : 0 } as {
    id: number; batchId: number; status: string; total: number; completed: number; succeeded: number; failed: number; percent: number;
  };
};

export const latestJobForBatch = (batchId: number, ownerUserId: number) => {
  const row = db.prepare("SELECT id FROM analysis_jobs WHERE batch_id=? AND owner_user_id=? ORDER BY id DESC LIMIT 1")
    .get(batchId, ownerUserId) as { id: number } | undefined;
  return row ? getJob(row.id, ownerUserId) : null;
};

export const retryFailed = (jobId: number, ownerUserId: number) => {
  const job = getJob(jobId, ownerUserId);
  if (!job) throw new Error("任务不存在");
  const ids = (db.prepare("SELECT feedback_id id FROM analysis_job_items WHERE job_id=? AND status='failed'").all(jobId) as unknown as { id: number }[]).map((row) => row.id);
  return createAnalysisJob(Number(job.batchId), ownerUserId, ids);
};

export const resumeJobs = () => {
  db.prepare("UPDATE analysis_job_items SET status='pending' WHERE status='running'").run();
  db.prepare("UPDATE analysis_jobs SET status='pending' WHERE status='running'").run();
  queueMicrotask(runWorker);
};
