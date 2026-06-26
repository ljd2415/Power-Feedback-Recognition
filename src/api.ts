import type { AnalysisJob, AuthUser, BusinessRule, DashboardData, DataBatch, Feedback, Tag, TagSuggestion } from "./types";

const json = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "请求失败" }));
    throw new Error(body.error || "请求失败");
  }
  return response.json();
};

export const api = {
  me: () => json<{ user: AuthUser }>("/api/auth/me"),
  login: (username: string, password: string) =>
    json<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    }),
  logout: () => json("/api/auth/logout", { method: "POST" }),
  batches: () => json<{ batches: DataBatch[] }>("/api/batches"),
  deleteBatch: (id: number) => json<{ ok: boolean; deletedRows: number }>(`/api/batches/${id}`, { method: "DELETE" }),
  feedback: (params = "") => json<{ items: Feedback[]; total: number }>(`/api/feedback${params}`),
  feedbackDetail: (id: number) => json<Feedback>(`/api/feedback/${id}`),
  dashboard: (period: string, batchId: number, date?: string) =>
    json<DashboardData>(`/api/dashboard?period=${period}&batchId=${batchId}${date ? `&date=${date}` : ""}`),
  tags: () => json<{ tags: Tag[]; suggestions: TagSuggestion[]; version: number }>("/api/tags"),
  updateFeedback: (id: number, payload: object) =>
    json<Feedback>(`/api/feedback/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  generateBusinessRuleDraft: (feedbackId: number, level2: string, level1 = "其他") =>
    json<{ draft: Partial<BusinessRule> }>("/api/business-rules/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedbackId, level1, level2 })
    }),
  analyze: (batchId: number, ids?: number[], filters?: { search?: string; priority?: string; period?: string; sortBy?: string; sortOrder?: string }, scope: "batch" | "page" | "selected" = ids?.length ? "selected" : "batch", page?: number, pageSize?: number) =>
    json<{ jobId: number; total: number }>("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, batchId, filters, scope, page, pageSize })
    }),
  importFile: async (file: File, mapping?: Record<string, string>) => {
    const form = new FormData();
    form.append("file", file);
    if (mapping) form.append("mapping", JSON.stringify(mapping));
    return json<{ preview?: unknown; imported?: number; mapping?: Record<string, string>; errors?: string[]; batchId?: number; jobId?: number }>(
      "/api/import",
      { method: "POST", body: form }
    );
  },
  job: (id: number) => json<AnalysisJob>(`/api/jobs/${id}`),
  latestJob: (batchId: number) => json<{ job: AnalysisJob | null }>(`/api/batches/${batchId}/latest-job`),
  retryJob: (id: number) => json<{ jobId: number }>(`/api/jobs/${id}/retry`, { method: "POST" }),
  businessRules: (level1 = "", level2 = "") => {
    const params = new URLSearchParams();
    if (level1) params.set("level1", level1);
    if (level2) params.set("level2", level2);
    return json<{ rules: BusinessRule[]; version: number }>(`/api/business-rules?${params}`);
  },
  saveBusinessRule: (payload: Partial<BusinessRule>) =>
    json<{ rule: BusinessRule; version: number }>(payload.id ? `/api/business-rules/${payload.id}` : "/api/business-rules", {
      method: payload.id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  deleteBusinessRule: (id: number) =>
    json<{ ok: boolean; version: number }>(`/api/business-rules/${id}`, { method: "DELETE" }),
  aiReport: (batchId: number, period: string) =>
    json<{ report: { id: number; status: string; content: Record<string, string>; stale: boolean; error?: string } | null }>(`/api/batches/${batchId}/ai-report?period=${period}`),
  generateAiReport: (batchId: number, period: string) =>
    json<{ id: number }>(`/api/batches/${batchId}/ai-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ period })
    }),
  approveSuggestion: (id: number) =>
    json(`/api/tag-suggestions/${id}/approve`, { method: "POST" }),
  rejectSuggestion: (id: number) =>
    json(`/api/tag-suggestions/${id}/reject`, { method: "POST" }),
  mergeSuggestion: (id: number, tagId: number) =>
    json(`/api/tag-suggestions/${id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagId })
    }),
  toggleTag: (id: number, active: boolean) =>
    json(`/api/tags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active })
    })
};
