export type Priority = "紧急" | "风险" | "一般" | "待定";
export type Sentiment = "负面投诉" | "常规报修" | "优化建议" | "咨询内容";

export interface Feedback {
  id: number;
  userId: string;
  username: string;
  contact: string;
  submittedAt: string;
  building: string;
  content: string;
  keywords: string[];
  tagId: number;
  tagName: string;
  priority: Priority;
  sentiment: Sentiment;
  confidence: number;
  rationale: string;
  selfCheck: string[];
  resolution: string;
  residentMessage: string;
  utilityMessage: string;
  status: string;
  source: string;
  level1: string;
  level2: string;
  scenario: string;
  businessCode: string;
  ruleVersion: number;
  analysisError: string;
  analysisUpdatedAt?: string;
}

export interface Tag {
  id: number;
  name: string;
  description: string;
  aliases: string[];
  keywords: string[];
  active: boolean;
  version: number;
  source: string;
  createdAt: string;
}

export interface TagSuggestion {
  id: number;
  proposedName: string;
  definition: string;
  keywords: string[];
  boundary: string;
  rationale: string;
  similarTag: string;
  status: string;
  feedbackId: number;
  createdAt: string;
}

export interface ChangeValue {
  current: number;
  previous: number;
  yoyBase: number;
  mom: number | null;
  yoy: number | null;
  momLabel: string;
  yoyLabel: string;
}

export interface DashboardData {
  total: number;
  highPriority: number;
  complaintRate: number;
  activeTags: number;
  tagVersion: number;
  typeDistribution: { name: string; value: number }[];
  priorityDistribution: { name: string; value: number }[];
  sentimentDistribution: { name: string; value: number }[];
  keywordStats: { name: string; value: number }[];
  buildingStats: { name: string; value: number }[];
  timeTrend: { period: string; count: number }[];
  comparisonTrend: ({ period: string } & ChangeValue)[];
  typeChanges: ({ name: string } & ChangeValue)[];
  highPriorityTrend: ({ period: string } & ChangeValue)[];
  alerts: { title: string; detail: string; rate: number; kind: string }[];
  currentPeriod: string;
  period: "day" | "week" | "month" | "year" | "all";
}

export interface AuthUser {
  id: number;
  username: string;
  role: string;
}

export interface DataBatch {
  id: number;
  filename: string;
  rowCount: number;
  actualCount: number;
  analyzedCount: number;
  completedCount: number;
  confirmedCount: number;
  failedCount: number;
  pendingCount: number;
  analyzingCount: number;
  progressPercent: number;
  createdAt: string;
}

export interface AnalysisJob {
  id: number;
  batchId: number;
  status: string;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  percent: number;
}

export interface BusinessRule {
  id: number;
  level1: string;
  level2: string;
  scenario: string;
  businessCode: string;
  standardPrompt: string;
  requiredCondition: string;
  excludedCondition: string;
  similarDifference: string;
  decisionRule: string;
  positiveExamples: string[];
  negativeExamples: string[];
  boundaryExamples: string[];
  ruleNodes: RuleNode[];
  active: boolean;
  version: number;
  priority: Priority;
}

export interface RuleNode {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  order: number;
}
