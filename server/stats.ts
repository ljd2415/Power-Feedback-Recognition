import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfDay,
  endOfMonth,
  endOfYear,
  endOfWeek,
  format,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfYear,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
  subYears
} from "date-fns";
import { zhCN } from "date-fns/locale";
import { db, getRuleVersion, parseJson } from "./db.js";

type Row = {
  id: number;
  submitted_at: string;
  building: string;
  keywords: string;
  tag_name: string;
  priority: string;
  sentiment: string;
};

export type Period = "day" | "week" | "month" | "year" | "all";

const getRows = (batchId?: number) =>
  db.prepare(`
    SELECT f.id, f.submitted_at, f.building, f.keywords, COALESCE(NULLIF(f.level1,''), '待分析') tag_name,
      f.priority, f.sentiment
    FROM feedback f
    WHERE f.status='已分析' ${batchId ? "AND f.batch_id=?" : ""}
    ORDER BY f.submitted_at
  `).all(...(batchId ? [batchId] : [])) as unknown as Row[];

export const periodBounds = (date: Date, period: Period) => {
  if (period === "all") return [new Date(2000, 0, 1), new Date(2100, 11, 31, 23, 59, 59)] as const;
  if (period === "day") return [startOfDay(date), endOfDay(date)] as const;
  if (period === "week")
    return [startOfWeek(date, { weekStartsOn: 1 }), endOfWeek(date, { weekStartsOn: 1 })] as const;
  if (period === "year") return [startOfYear(date), endOfYear(date)] as const;
  return [startOfMonth(date), endOfMonth(date)] as const;
};

const previousDate = (date: Date, period: Period) =>
  period === "day" ? subDays(date, 1) : period === "week" ? subWeeks(date, 1) : period === "month" ? subMonths(date, 1) : subYears(date, 1);

const nextDate = (date: Date, period: Period) =>
  period === "day" ? addDays(date, 1) : period === "week" ? addWeeks(date, 1) : period === "month" ? addMonths(date, 1) : addYears(date, 1);

const inRange = (row: Row, start: Date, end: Date) => {
  const value = parseISO(row.submitted_at);
  return value >= start && value <= end;
};

export const calculateRate = (current: number, base: number) => {
  if (base === 0) return current === 0 ? 0 : null;
  return ((current - base) / base) * 100;
};

const label = (value: number | null, current: number, base: number) => {
  if (base === 0 && current > 0) return "新增";
  if (value === null) return "数据不足";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
};

const change = (current: number, previous: number, yoyBase: number) => {
  const mom = calculateRate(current, previous);
  const yoy = calculateRate(current, yoyBase);
  return {
    current,
    previous,
    yoyBase,
    mom,
    yoy,
    momLabel: label(mom, current, previous),
    yoyLabel: label(yoy, current, yoyBase)
  };
};

const groupCount = (rows: Row[], getter: (row: Row) => string) => {
  const map = new Map<string, number>();
  for (const row of rows) map.set(getter(row), (map.get(getter(row)) || 0) + 1);
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
};

const periodLabel = (date: Date, period: Period) =>
  period === "day"
    ? format(date, "MM-dd")
    : period === "week"
      ? `${format(startOfWeek(date, { weekStartsOn: 1 }), "MM-dd")}周`
      : period === "month"
        ? format(date, "yyyy-MM")
        : format(date, "yyyy");

const maskRowsExist = (rows: Row[], start: Date) => rows.some((row) => parseISO(row.submitted_at) < start);

export const dashboard = (period: Period, requestedDate?: string, batchId?: number) => {
  const rows = getRows(batchId);
  const latest = rows.length ? parseISO(rows[rows.length - 1].submitted_at) : new Date();
  const date = requestedDate ? parseISO(requestedDate) : latest;
  const earliest = rows.length ? parseISO(rows[0].submitted_at) : date;
  const [start, end] = period === "all" ? [earliest, latest] : periodBounds(date, period);
  const comparisonPeriod: Period = period === "all" ? "year" : period;
  const [previousStart, previousEnd] = periodBounds(previousDate(date, comparisonPeriod), comparisonPeriod);
  const [yoyStart, yoyEnd] = periodBounds(subYears(date, 1), comparisonPeriod);
  const currentRows = rows.filter((row) => inRange(row, start, end));
  const previousRows = rows.filter((row) => inRange(row, previousStart, previousEnd));
  const yoyRows = rows.filter((row) => inRange(row, yoyStart, yoyEnd));

  const typeDistribution = groupCount(currentRows, (row) => row.tag_name);
  const priorityDistribution = groupCount(currentRows, (row) => row.priority);
  const sentimentDistribution = groupCount(currentRows, (row) => row.sentiment);
  const buildingStats = groupCount(currentRows, (row) => row.building).slice(0, 12);
  const keywordMap = new Map<string, number>();
  for (const row of currentRows) {
    for (const keyword of parseJson<string[]>(row.keywords, [])) {
      keywordMap.set(keyword, (keywordMap.get(keyword) || 0) + 1);
    }
  }
  const keywordStats = [...keywordMap.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  const comparisonTrend = Array.from({ length: 12 }, (_, index) => {
    const point = previousDate(date, comparisonPeriod);
    const currentDate =
      comparisonPeriod === "day"
        ? subDays(point, 10 - index)
        : comparisonPeriod === "week"
          ? subWeeks(point, 10 - index)
          : comparisonPeriod === "month"
            ? subMonths(point, 10 - index)
            : subYears(point, 10 - index);
    const [cs, ce] = periodBounds(currentDate, comparisonPeriod);
    const [ps, pe] = periodBounds(previousDate(currentDate, comparisonPeriod), comparisonPeriod);
    const [ys, ye] = periodBounds(subYears(currentDate, 1), comparisonPeriod);
    const c = rows.filter((row) => inRange(row, cs, ce)).length;
    const p = rows.filter((row) => inRange(row, ps, pe)).length;
    const y = rows.filter((row) => inRange(row, ys, ye)).length;
    return { period: periodLabel(currentDate, comparisonPeriod), ...change(c, p, y) };
  });

  const trendPeriod: Period = period === "all" ? "year" : period;
  const timeTrend = Array.from({ length: trendPeriod === "day" ? 24 : trendPeriod === "week" ? 7 : 12 }, (_, index) => {
    if (trendPeriod === "day") {
      const count = currentRows.filter((row) => parseISO(row.submitted_at).getHours() === index).length;
      return { period: `${String(index).padStart(2, "0")}:00`, count };
    }
    if (trendPeriod === "year") {
      const monthStart = new Date(start.getFullYear(), index, 1);
      const monthEnd = endOfMonth(monthStart);
      return { period: format(monthStart, "MM月"), count: rows.filter((r) => inRange(r, monthStart, monthEnd)).length };
    }
    const point = trendPeriod === "week" ? addDays(start, index % 7) : new Date(start.getFullYear(), start.getMonth(), index + 1);
    if (point > end) return { period: format(point, "MM-dd"), count: 0 };
    const [ds, de] = periodBounds(point, "day");
    return { period: trendPeriod === "week" ? format(point, "EEE", { locale: zhCN }) : format(point, "MM-dd"), count: rows.filter((r) => inRange(r, ds, de)).length };
  });

  const typeNames = new Set([...currentRows, ...previousRows, ...yoyRows].map((row) => row.tag_name));
  const typeChanges = [...typeNames]
    .map((name) => ({
      name,
      ...change(
        currentRows.filter((row) => row.tag_name === name).length,
        previousRows.filter((row) => row.tag_name === name).length,
        yoyRows.filter((row) => row.tag_name === name).length
      )
    }))
    .sort((a, b) => b.current - a.current)
    .slice(0, 8);

  const highPriorityTrend = comparisonTrend.map((item, index) => {
    const point =
      comparisonPeriod === "day"
        ? subDays(previousDate(date, comparisonPeriod), 10 - index)
        : comparisonPeriod === "week"
          ? subWeeks(previousDate(date, comparisonPeriod), 10 - index)
          : comparisonPeriod === "month"
            ? subMonths(previousDate(date, comparisonPeriod), 10 - index)
            : subYears(previousDate(date, comparisonPeriod), 10 - index);
    const [cs, ce] = periodBounds(point, comparisonPeriod);
    const [ps, pe] = periodBounds(previousDate(point, comparisonPeriod), comparisonPeriod);
    const [ys, ye] = periodBounds(subYears(point, 1), comparisonPeriod);
    return {
      period: item.period,
      ...change(
        rows.filter((row) => inRange(row, cs, ce) && row.priority === "紧急").length,
        rows.filter((row) => inRange(row, ps, pe) && row.priority === "紧急").length,
        rows.filter((row) => inRange(row, ys, ye) && row.priority === "紧急").length
      )
    };
  });

  const alerts: { title: string; detail: string; rate: number; kind: string }[] = [];
  const totalChange = change(currentRows.length, previousRows.length, yoyRows.length);
  for (const [kind, value] of [["环比", totalChange.mom], ["同比", totalChange.yoy]] as const) {
    if (value !== null && value > 30)
      alerts.push({ title: `反馈总量${kind}异常上升`, detail: `本期${currentRows.length}条，变化${value.toFixed(1)}%`, rate: value, kind });
  }
  for (const item of typeChanges) {
    if (item.mom !== null && item.mom > 30)
      alerts.push({ title: `${item.name}环比上升`, detail: `由${item.previous}条增至${item.current}条`, rate: item.mom, kind: "环比" });
    if (item.yoy !== null && item.yoy > 30)
      alerts.push({ title: `${item.name}同比上升`, detail: `上年同期${item.yoyBase}条，本期${item.current}条`, rate: item.yoy, kind: "同比" });
  }

  const highPriority = currentRows.filter((row) => row.priority === "紧急").length;
  const complaints = currentRows.filter((row) => row.sentiment === "负面投诉").length;
  return {
    total: currentRows.length,
    highPriority,
    complaintRate: currentRows.length ? (complaints / currentRows.length) * 100 : 0,
    activeTags: Number((db.prepare("SELECT COUNT(*) count FROM business_rules WHERE active=1").get() as { count: number }).count),
    tagVersion: getRuleVersion(),
    typeDistribution,
    priorityDistribution,
    sentimentDistribution,
    keywordStats,
    buildingStats,
    timeTrend,
    comparisonTrend,
    typeChanges,
    highPriorityTrend,
    alerts,
    currentPeriod: `${format(start, "yyyy-MM-dd")} 至 ${format(end, "yyyy-MM-dd")}`,
    period,
    hasPreviousData: maskRowsExist(rows, start)
  };
};
