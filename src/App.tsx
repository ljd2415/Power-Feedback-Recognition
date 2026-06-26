import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BellRing,
  BookOpenText,
  ChevronRight,
  ClipboardList,
  Download,
  Database,
  FileSpreadsheet,
  Gauge,
  History,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  Settings2,
  CheckSquare,
  Plus,
  ShieldAlert,
  Tags,
  LogOut,
  Upload,
  UploadCloud,
  Users,
  X
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { api } from "./api";
import type { AnalysisJob, AuthUser, BusinessRule, DashboardData, DataBatch, Feedback, RuleNode, Tag, TagSuggestion } from "./types";

const COLORS = ["#0b5d4b", "#1d8a70", "#62b59f", "#f0a33a", "#d94c4c", "#5977a9", "#8d6bb1", "#86968f"];
const fieldNames: Record<string, string> = {
  submittedAt: "反馈提交时间",
  building: "楼栋地点",
  content: "反馈内容",
  username: "用户名",
  userId: "用户ID",
  contact: "联系方式"
};

function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [area, setArea] = useState<"home" | "upload" | "history" | "rules">("home");
  const [tab, setTab] = useState<"list" | "dashboard" | "report">("list");
  const [batches, setBatches] = useState<DataBatch[]>([]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [period, setPeriod] = useState<"day" | "week" | "month" | "year" | "all">("month");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState("");
  const [sortBy, setSortBy] = useState<"time" | "priority">("time");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Feedback | null>(null);
  const [pendingRuleDraft, setPendingRuleDraft] = useState<Partial<BusinessRule> | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [tagVersion, setTagVersion] = useState(1);
  const [busy, setBusy] = useState(false);
  const [activeJob, setActiveJob] = useState<AnalysisJob | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [importState, setImportState] = useState<{
    file: File;
    headers: string[];
    mapping: Record<string, string>;
    preview: Record<string, unknown>[];
  } | null>(null);

  const loadDashboard = useCallback(async () => {
    if (!batchId) return setDashboard(null);
    setDashboard(await api.dashboard(period, batchId));
  }, [period, batchId]);
  const loadFeedback = useCallback(async () => {
    if (!batchId) return;
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    params.set("batchId", String(batchId));
    params.set("period", period);
    if (search) params.set("search", search);
    if (priority) params.set("priority", priority);
    params.set("sortBy", sortBy);
    params.set("sortOrder", sortOrder);
    const result = await api.feedback(`?${params}`);
    setFeedback(result.items);
    setTotal(result.total);
  }, [page, search, priority, sortBy, sortOrder, batchId, period]);
  const loadBatches = useCallback(async () => {
    const result = await api.batches();
    setBatches(result.batches);
    return result.batches;
  }, []);
  const loadTags = useCallback(async () => {
    const [legacy, business] = await Promise.all([api.tags(), api.businessRules()]);
    setTags(legacy.tags);
    setSuggestions(legacy.suggestions);
    setTagVersion(business.version);
  }, []);

  useEffect(() => {
    api.me().then((result) => setUser(result.user)).catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (user) Promise.all([loadBatches(), loadTags()]).catch(console.error);
  }, [user, loadBatches, loadTags]);
  useEffect(() => { if (user && batchId) loadDashboard().catch(console.error); }, [user, batchId, loadDashboard]);
  useEffect(() => { if (user && batchId) loadFeedback().catch(console.error); }, [user, batchId, loadFeedback]);
  useEffect(() => {
    if (!batchId) return;
    api.latestJob(batchId).then((result) => setActiveJob(result.job)).catch(console.error);
  }, [batchId]);
  useEffect(() => {
    if (!activeJob || !["pending", "running"].includes(activeJob.status)) return;
    const timer = window.setInterval(async () => {
      const job = await api.job(activeJob.id);
      setActiveJob(job);
      await loadFeedback();
      if (!["pending", "running"].includes(job.status)) {
        await Promise.all([loadDashboard(), loadBatches()]);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, loadFeedback, loadDashboard, loadBatches]);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(""), 3200);
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await api.importFile(file) as {
        headers: string[];
        mapping: Record<string, string>;
        preview: Record<string, unknown>[];
      };
      setImportState({ file, headers: result.headers, mapping: result.mapping, preview: result.preview });
    } catch (error) {
      notify(error instanceof Error ? error.message : "文件解析失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!importState) return;
    setBusy(true);
    try {
      const result = await api.importFile(importState.file, importState.mapping);
      if (!result.imported) {
        throw new Error(result.errors?.[0] || "未导入任何有效数据，请检查字段内容和日期格式");
      }
      notify(`已导入${result.imported || 0}条，正在后台逐条分析`);
      setImportState(null);
      await loadBatches();
      if (result.batchId) {
        setBatchId(result.batchId);
        if (result.jobId) setActiveJob({ id: result.jobId, batchId: result.batchId, status: "pending", total: result.imported || 0, completed: 0, succeeded: 0, failed: 0, percent: 0 });
        setArea("history");
        setTab("list");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  if (user === undefined) return <div className="auth-loading"><LoaderCircle className="spin" /><span>正在加载系统</span></div>;
  if (!user) return <Login onLogin={setUser} />;

  const nav: { id: typeof tab; label: string; icon: typeof BarChart3 }[] = [
    { id: "list", label: "反馈数据列表", icon: ClipboardList },
    { id: "dashboard", label: "可视化看板", icon: BarChart3 },
    { id: "report", label: "数据分析", icon: BookOpenText }
  ];
  const selectedBatch = batches.find((batch) => batch.id === batchId);

  const logout = async () => {
    await api.logout();
    setUser(null);
    setBatchId(null);
    setArea("home");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Activity size={22} /></div>
          <div><strong>小区电力智析</strong><span>运维决策工作台</span></div>
        </div>
        <nav>
          <button className={area === "home" ? "active" : ""} onClick={() => setArea("home")}><Layers3 size={19} /><span>工作台首页</span></button>
          <button className={area === "upload" ? "active" : ""} onClick={() => setArea("upload")}><UploadCloud size={19} /><span>上传 Excel</span></button>
          <button className={area === "history" ? "active" : ""} onClick={() => setArea("history")}><History size={19} /><span>查看往期数据</span></button>
          <button className={area === "rules" ? "active" : ""} onClick={() => setArea("rules")}><BookOpenText size={19} /><span>场景字典</span></button>
          {area === "history" && batchId && <div className="sub-nav">{nav.map((item, index) => (
            <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
              <span>{index + 1}.</span><item.icon size={16} /><span>{item.label}</span>
            </button>
          ))}</div>}
        </nav>
        <div className="sidebar-foot">
          <div className="account-menu-wrap">
            <button className="user-card" onClick={() => setAccountMenuOpen(!accountMenuOpen)}><Users size={17} /><div><span>管理员账号</span><strong>{user.username}</strong></div><ChevronRight size={15} /></button>
            {accountMenuOpen && <div className="account-menu">
              <button onClick={logout}><LogOut size={15} />退出登录</button>
              <button onClick={logout}><Users size={15} />切换账号</button>
            </div>}
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">POWER OPERATIONS · 反馈闭环管理</p>
            <h1>{area === "home" ? "管理员工作台" : area === "upload" ? "上传 Excel" : area === "rules" ? "场景字典" : selectedBatch ? `${selectedBatch.filename} · ${nav.find((item) => item.id === tab)?.label}` : "查看往期数据"}</h1>
          </div>
          <div className="top-actions">
            {area === "upload" && <label className="upload-button">
              {busy ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
              导入 Excel
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => chooseFile(event.target.files?.[0])} />
            </label>}
            <button className="icon-button" title="重新加载" onClick={() => Promise.all([loadBatches(), loadTags(), ...(batchId ? [loadDashboard(), loadFeedback()] : [])])}><RefreshCw size={18} /></button>
          </div>
        </header>

        <section className="content">
          {area === "home" && <Home setArea={setArea} batchCount={batches.length} />}
          {area === "upload" && <UploadCenter chooseFile={chooseFile} busy={busy} />}
          {area === "rules" && <BusinessRules notify={notify} onVersion={setTagVersion} initialDraft={pendingRuleDraft} onDraftConsumed={() => setPendingRuleDraft(null)} />}
          {area === "history" && !batchId && <BatchSelector batches={batches} select={(id) => { setBatchId(id); setTab("list"); setPage(1); }} remove={async (batch) => {
            if (!window.confirm(`确定删除数据表“${batch.filename}”及其中${batch.actualCount}条反馈吗？删除后无法恢复。`)) return;
            const result = await api.deleteBatch(batch.id);
            notify(`已删除数据表及${result.deletedRows}条反馈`);
            await loadBatches();
          }} />}
          {area === "history" && batchId && <div className="batch-context"><button onClick={() => setBatchId(null)}>← 重新选择数据表</button><span>{selectedBatch?.actualCount} 条原始反馈 · 上传于 {selectedBatch?.createdAt}</span></div>}
          {area === "history" && batchId && tab === "dashboard" && dashboard && <Dashboard data={dashboard} />}
          {area === "history" && batchId && tab === "list" && (
            <>
            {(activeJob || selectedBatch) && <AnalysisProgress job={activeJob} batch={selectedBatch} retry={async () => {
              if (!activeJob) return;
              const result = await api.retryJob(activeJob.id);
              const next = await api.job(result.jobId);
              setActiveJob(next);
            }} />}
            <FeedbackList
              rows={feedback} total={total} page={page} setPage={setPage} search={search}
              setSearch={setSearch} priority={priority} setPriority={setPriority} sortBy={sortBy}
              setSortBy={setSortBy} sortOrder={sortOrder} setSortOrder={setSortOrder} period={period}
              setPeriod={setPeriod}
              onSelect={setSelected}
              onAnalyze={async (scope, ids, targetPage) => {
                const filters = { search, priority, period, sortBy, sortOrder };
                const result = await api.analyze(batchId, scope === "selected" ? ids : undefined, filters, scope, targetPage, 20);
                setActiveJob({ id: result.jobId, batchId, status: "pending", total: result.total, completed: 0, succeeded: 0, failed: 0, percent: 0 });
                await loadFeedback();
                await loadBatches();
                notify(`已创建${result.total}条反馈的重新分析任务`);
              }}
            />
            </>
          )}
          {area === "history" && batchId && tab === "report" && dashboard && <Report data={dashboard} period={period} batchId={batchId} />}
        </section>
      </main>

      {selected && <FeedbackDrawer feedback={selected} close={() => setSelected(null)} notify={notify} openRuleDraft={(draft) => { setPendingRuleDraft(draft); setSelected(null); setArea("rules"); }} updated={async () => { await loadFeedback(); setSelected(null); }} />}
      {importState && <ImportModal state={importState} setState={setImportState} close={() => setImportState(null)} confirm={confirmImport} busy={busy} />}
      {message && <div className="toast">{message}</div>}
    </div>
  );
}

function Login({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try { onLogin((await api.login(username, password)).user); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  };
  return <div className="login-page"><div className="login-brand"><div className="brand-mark"><Activity /></div><span>小区电力智析</span></div><form className="login-card" onSubmit={submit}><p>POWER OPERATIONS</p><h1>管理员登录</h1><span>登录后查看个人上传的数据及分析结果</span><label>账号<input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="请输入管理员账号" /></label><label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="请输入密码" /></label>{error && <div className="login-error">{error}</div>}<button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : null}登录系统</button></form></div>;
}

function Home({ setArea, batchCount }: { setArea: (area: "upload" | "history") => void; batchCount: number }) {
  return <div className="home-page"><div className="welcome"><p>ADMIN WORKSPACE</p><h2>请选择要进行的操作</h2><span>上传新反馈数据，或进入历史数据表查看完整分析结果。</span></div><div className="portal-grid"><button onClick={() => setArea("upload")}><div className="portal-icon"><UploadCloud /></div><span>板块一</span><h3>上传 Excel</h3><p>导入住户反馈数据，自动完成AI分类、优先级评级和处置方案生成。</p><strong>开始上传 <ChevronRight /></strong></button><button onClick={() => setArea("history")}><div className="portal-icon blue"><Database /></div><span>板块二</span><h3>查看往期数据</h3><p>从{batchCount}个历史数据表中选择，依次查看数据列表、可视化看板与数据分析。</p><strong>选择数据表 <ChevronRight /></strong></button></div></div>;
}

function UploadCenter({ chooseFile, busy }: { chooseFile: (file?: File) => void; busy: boolean }) {
  return <div className="upload-center"><FileSpreadsheet size={44} /><h2>上传用户反馈 Excel</h2><p>支持 .xlsx 和 .csv，单次最多10000条。系统将自动识别字段并在确认后进行AI分析。</p><label className="upload-button">{busy ? <LoaderCircle className="spin" /> : <Upload />}选择 Excel 文件<input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => chooseFile(e.target.files?.[0])} /></label><div className="upload-fields"><strong>必填字段</strong><span>反馈提交时间</span><span>楼栋地点</span><span>用户反馈文本内容</span></div></div>;
}

function BatchSelector({ batches, select, remove }: { batches: DataBatch[]; select: (id: number) => void; remove: (batch: DataBatch) => void }) {
  return <div className="batch-page"><div className="welcome"><p>HISTORICAL DATA</p><h2>选择要查看的数据表</h2><span>选定数据表后，将按“数据列表 → 可视化看板 → 数据分析”顺序展示。</span></div>{batches.length ? <div className="batch-grid">{batches.map((batch) => <article key={batch.id}><button className="batch-open" onClick={() => select(batch.id)}><FileSpreadsheet /><div><h3>{batch.filename}</h3><p>{batch.createdAt}</p><BatchProgressBar batch={batch} /></div><ChevronRight /></button><button className="batch-delete" title="删除数据表" onClick={() => remove(batch)}><X size={15} />删除</button></article>)}</div> : <div className="empty"><Database /><p>暂无已上传数据表</p></div>}</div>;
}

function BatchProgressBar({ batch }: { batch: DataBatch }) {
  const analyzed = (batch.completedCount || 0) + (batch.confirmedCount || 0);
  const pending = (batch.pendingCount || 0) + (batch.analyzingCount || 0);
  const failed = batch.failedCount || 0;
  return <div className="batch-progress batch-metrics"><span><b>{batch.actualCount || 0}</b>总数</span><span><b>{analyzed}</b>已分析</span><span><b>{pending}</b>未分析</span>{failed > 0 && <span className="failed"><b>{failed}</b>失败</span>}</div>;
}

function Dashboard({ data }: { data: DashboardData }) {
  const kpis = [
    { label: "本期反馈总量", value: data.total, unit: "条", icon: ClipboardList, tone: "green" },
    { label: "紧急优先级事件", value: data.highPriority, unit: "条", icon: ShieldAlert, tone: "red" },
    { label: "负面投诉占比", value: data.complaintRate.toFixed(1), unit: "%", icon: Gauge, tone: "amber" },
    { label: "有效业务场景", value: data.activeTags, unit: "个", icon: Tags, tone: "blue" }
  ];
  return (
    <>
      <div className="context-bar">
        <div><span>统计周期</span><strong>{data.currentPeriod}</strong></div>
        <div className="scope-badge">{data.period === "day" ? "本日" : data.period === "week" ? "本周" : data.period === "month" ? "本月" : data.period === "year" ? "本年" : "全部数据"}</div>
      </div>
      <div className="kpi-grid">
        {kpis.map((item) => <div className="kpi-card" key={item.label}><div className={`kpi-icon ${item.tone}`}><item.icon size={21} /></div><div><span>{item.label}</span><strong>{item.value}<small>{item.unit}</small></strong></div></div>)}
      </div>
      {data.alerts.length > 0 && <div className="alert-strip"><BellRing size={19} /><strong>异常波动预警</strong><span>{data.alerts[0].title}，{data.alerts[0].detail}</span><em>共 {data.alerts.length} 项</em></div>}
      <div className="chart-grid">
        <ChartCard title="反馈总量同比 / 环比趋势" subtitle="柱形为本期数量，折线为变化率" wide>
          <ResponsiveContainer width="100%" height={310}>
            <LineChart data={data.comparisonTrend}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="period" tick={{ fontSize: 11 }} /><YAxis yAxisId="left" /><YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v}%`} /><Tooltip formatter={(value, name) => [name === "current" ? `${value}条` : `${Number(value).toFixed(1)}%`, name === "current" ? "反馈量" : name === "mom" ? "环比" : "同比"]} /><Legend formatter={(v) => v === "current" ? "反馈量" : v === "mom" ? "环比变化率" : "同比变化率"} /><Line yAxisId="left" type="monotone" dataKey="current" stroke="#0b5d4b" strokeWidth={3} dot={{ r: 3 }} /><Line yAxisId="right" type="monotone" dataKey="mom" stroke="#f0a33a" strokeWidth={2} /><Line yAxisId="right" type="monotone" dataKey="yoy" stroke="#5977a9" strokeWidth={2} /></LineChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="问题类型占比" subtitle="本期问题结构">
          <ResponsiveContainer width="100%" height={310}><PieChart><Pie data={data.typeDistribution} dataKey="value" nameKey="name" innerRadius={58} outerRadius={94} paddingAngle={2} label={({ percent }) => `${(percent * 100).toFixed(0)}%`}>{data.typeDistribution.map((_, index) => <Cell key={index} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
        </ChartCard>
        <ChartCard title="核心问题类型环比变化" subtitle="橙色虚线为30%预警阈值" wide>
          <ResponsiveContainer width="100%" height={300}><BarChart data={data.typeChanges} layout="vertical"><CartesianGrid strokeDasharray="3 3" horizontal={false} /><XAxis type="number" tickFormatter={(v) => `${v}%`} /><YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} /><Tooltip formatter={(v) => `${Number(v).toFixed(1)}%`} /><Bar dataKey="mom" name="环比变化率" radius={[0, 5, 5, 0]}>{data.typeChanges.map((item, index) => <Cell key={index} fill={(item.mom || 0) > 30 ? "#d94c4c" : "#1d8a70"} />)}</Bar></BarChart></ResponsiveContainer>
        </ChartCard>
        <ChartCard title="优先级分布" subtitle="按处置紧急程度">
          <ResponsiveContainer width="100%" height={300}><BarChart data={data.priorityDistribution}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="value" name="反馈数" radius={[6, 6, 0, 0]}>{data.priorityDistribution.map((item) => <Cell key={item.name} fill={item.name === "紧急" ? "#d94c4c" : item.name === "风险" ? "#f0a33a" : item.name === "待定" ? "#86968f" : "#1d8a70"} />)}</Bar></BarChart></ResponsiveContainer>
        </ChartCard>
        <ChartCard title="故障楼栋热力分布" subtitle="颜色越深代表反馈越集中">
          <div className="heat-grid">{data.buildingStats.map((item, index) => <div key={item.name} style={{ background: `rgba(11,93,75,${0.18 + (1 - index / Math.max(data.buildingStats.length, 1)) * 0.75})` }}><strong>{item.name}</strong><span>{item.value}条</span></div>)}</div>
        </ChartCard>
        <ChartCard title="故障发生时间趋势" subtitle="按当前统计粒度拆分">
          <ResponsiveContainer width="100%" height={280}><LineChart data={data.timeTrend}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="period" tick={{ fontSize: 10 }} /><YAxis allowDecimals={false} /><Tooltip /><Line type="monotone" dataKey="count" name="反馈数" stroke="#0b5d4b" strokeWidth={3} /></LineChart></ResponsiveContainer>
        </ChartCard>
        <ChartCard title="核心关键词" subtitle="基于反馈语境提取">
          <div className="keyword-cloud">{data.keywordStats.map((item, index) => <span key={item.name} style={{ fontSize: `${14 + Math.max(0, 16 - index * 1.2)}px` }}>{item.name}<small>{item.value}</small></span>)}</div>
        </ChartCard>
      </div>
    </>
  );
}

function ChartCard({ title, subtitle, wide, children }: { title: string; subtitle: string; wide?: boolean; children: React.ReactNode }) {
  return <article className={`chart-card ${wide ? "wide" : ""}`}><div className="card-title"><div><h3>{title}</h3><p>{subtitle}</p></div><Settings2 size={17} /></div>{children}</article>;
}

function FeedbackList(props: {
  rows: Feedback[]; total: number; page: number; setPage: (v: number) => void; search: string;
  setSearch: (v: string) => void; priority: string; setPriority: (v: string) => void;
  sortBy: "time" | "priority"; setSortBy: (v: "time" | "priority") => void;
  sortOrder: "asc" | "desc"; setSortOrder: (v: "asc" | "desc") => void;
  period: "day" | "week" | "month" | "year" | "all"; setPeriod: (v: "day" | "week" | "month" | "year" | "all") => void;
  onSelect: (v: Feedback) => void; onAnalyze: (scope: "batch" | "page" | "selected", ids: number[], page?: number) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [phoneRow, setPhoneRow] = useState<number | null>(null);
  const [analyzeMenu, setAnalyzeMenu] = useState(false);
  const [pageInput, setPageInput] = useState(String(props.page));
  const maxPage = Math.max(1, Math.ceil(props.total / 20));
  const runAnalyze = (scope: "batch" | "page" | "selected") => {
    if (scope === "selected" && !selectedIds.length) return;
    const targetPage = Math.min(maxPage, Math.max(1, Number(pageInput) || props.page));
    const countText = scope === "batch" ? props.total : scope === "page" ? `第${targetPage}页` : `${selectedIds.length}条`;
    if (window.confirm(`确认重新分析${countText}反馈吗？`)) {
      props.onAnalyze(scope, selectedIds, targetPage);
      setSelectedIds([]);
      setAnalyzeMenu(false);
    }
  };
  const statusText = (row: Feedback) => {
    if (row.status === "已分析") return `已分析·${row.source === "manual" ? "人工" : "AI"}`;
    if (row.status === "正在重新分析") return "正在重新分析";
    if (row.status === "待确认") return "待确认·人工处理";
    if (row.status === "分析失败") return "分析失败·待处理";
    return row.status;
  };
  return (
    <div className="panel">
      <div className="table-tools">
        <div className="result-count"><strong>{props.total}</strong><span>条</span></div>
        <div className="search-box"><Search size={17} /><input value={props.search} onChange={(e) => { props.setPage(1); props.setSearch(e.target.value); }} placeholder="搜索用户、楼栋或反馈内容" /></div>
        <div className="tool-group">
          <span>筛选</span>
          <select value={props.period} onChange={(e) => { props.setPage(1); props.setPeriod(e.target.value as "day" | "week" | "month" | "year" | "all"); }}><option value="day">本日</option><option value="week">本周</option><option value="month">本月</option><option value="year">本年</option><option value="all">全部时间</option></select>
          <select value={props.priority} onChange={(e) => { props.setPage(1); props.setPriority(e.target.value); }}><option value="">全部优先级</option><option value="紧急">紧急</option><option value="风险">风险</option><option value="一般">一般</option><option value="待定">待定</option></select>
        </div>
        <div className="tool-group">
          <span>排序</span>
          <select value={props.sortBy} onChange={(e) => { props.setPage(1); props.setSortBy(e.target.value as "time" | "priority"); }}><option value="time">按时间</option><option value="priority">按优先级</option></select>
          <select value={props.sortOrder} onChange={(e) => { props.setPage(1); props.setSortOrder(e.target.value as "asc" | "desc"); }}><option value="desc">倒序</option><option value="asc">正序</option></select>
        </div>
        <div className="analyze-menu-wrap">
          <button className="secondary" onClick={() => setAnalyzeMenu(!analyzeMenu)}><RefreshCw size={16} />重新分析</button>
          {analyzeMenu && <div className="analyze-menu"><button onClick={() => runAnalyze("batch")}>重新分析整个数据表</button><label>重新分析页码<input value={pageInput} onChange={(e) => setPageInput(e.target.value)} /></label><button onClick={() => runAnalyze("page")}>重新分析该页</button><button disabled={!selectedIds.length} onClick={() => runAnalyze("selected")}>重新分析已勾选数据</button></div>}
        </div>
      </div>
      <div className="table-wrap">
        <table><thead><tr><th></th><th>住户ID</th><th>用户姓名</th><th>提交时间 / 楼栋</th><th>反馈内容</th><th>业务分类</th><th>优先级</th><th>状态</th><th /></tr></thead>
          <tbody>{props.rows.map((row) => <tr key={row.id}><td><input type="checkbox" checked={selectedIds.includes(row.id)} onChange={() => setSelectedIds(selectedIds.includes(row.id) ? selectedIds.filter((id) => id !== row.id) : [...selectedIds, row.id])} /></td><td><strong>{row.userId || "未知"}</strong></td><td className="name-cell"><button onClick={() => setPhoneRow(phoneRow === row.id ? null : row.id)}>{row.username || "未提供"}</button>{phoneRow === row.id && <div className="phone-pop"><span>{row.contact || "电话未知"}</span><button onClick={() => navigator.clipboard.writeText(row.contact || "")}>复制</button></div>}</td><td><strong>{row.submittedAt.slice(0, 16)}</strong><span>{row.building}</span></td><td className="content-cell"><p>{row.content}</p></td><td>{row.level1 ? <><span className="tag-pill">{row.level1}</span><small>{row.level2}</small></> : <span className="pending-tag">等待分析</span>}</td><td><span className={`priority ${row.priority}`}>{row.priority}</span></td><td><span className={`status-dot ${row.status}`} title={row.status === "分析失败" ? row.analysisError || "未记录失败原因" : ""}>{statusText(row)}</span></td><td><button className="row-action" onClick={() => props.onSelect(row)}>查看<ChevronRight size={15} /></button></td></tr>)}</tbody>
        </table>
      </div>
      {selectedIds.length > 0 && <div className="selection-bar"><strong>已选择 {selectedIds.length} 条</strong><button onClick={() => runAnalyze("selected")}><RefreshCw size={15} />重新分析已选</button><button onClick={() => setSelectedIds([])}>清空选择</button></div>}
      <div className="pagination"><span>共 {props.total} 条</span><div><button disabled={props.page === 1} onClick={() => props.setPage(props.page - 1)}>上一页</button><strong>第 {props.page} / {Math.max(1, Math.ceil(props.total / 20))} 页</strong><button disabled={props.page * 20 >= props.total} onClick={() => props.setPage(props.page + 1)}>下一页</button></div></div>
    </div>
  );
}

function AnalysisProgress({ job, batch, retry }: { job: AnalysisJob | null; batch?: DataBatch; retry: () => void }) {
  const total = batch?.actualCount || job?.total || 0;
  const segments = [
    { key: "done", label: "已分析", value: batch?.completedCount || 0 },
    { key: "confirm", label: "待确认", value: batch?.confirmedCount || 0 },
    { key: "running", label: "分析中", value: batch?.analyzingCount || 0 },
    { key: "failed", label: "分析失败", value: batch?.failedCount || job?.failed || 0 },
    { key: "pending", label: "待处理", value: batch?.pendingCount || 0 }
  ];
  const analyzed = (batch?.completedCount || 0) + (batch?.confirmedCount || 0);
  const percent = total ? Math.round(analyzed / total * 100) : 0;
  return <div className="analysis-progress segmented-progress"><div className="progress-count"><strong>{total}</strong><span>总数</span></div><div className="progress-body"><div><strong>分析进度 {percent}%</strong></div><div className="progress-track multi">{segments.map((segment) => segment.value > 0 && <span key={segment.key} className={segment.key} title={`${segment.label}${segment.value}`} aria-label={`${segment.label}${segment.value}`} style={{ width: `${total ? segment.value / total * 100 : 0}%` }} />)}</div><div className="progress-legend">{segments.map((segment) => segment.value > 0 && <span key={segment.key}><i className={segment.key} />{segment.label} {segment.value}</span>)}</div>{job && job.failed > 0 && !["pending","running"].includes(job.status) && <button onClick={retry}>重试失败项</button>}</div></div>;
}

function FeedbackDrawer({ feedback, close, updated, notify, openRuleDraft }: { feedback: Feedback; close: () => void; updated: () => void; notify: (text: string) => void; openRuleDraft: (draft: Partial<BusinessRule>) => void }) {
  const [priority, setPriority] = useState(feedback.priority);
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [businessRuleId, setBusinessRuleId] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const isNewSceneCandidate = feedback.level1 === "其他" && feedback.level2 === "新增场景待确认";
  useEffect(() => {
    api.businessRules().then(({ rules: rows }) => {
      const active = rows.filter((rule) => rule.active);
      setRules(active);
      const current = active.find((rule) => rule.businessCode === feedback.businessCode);
      setBusinessRuleId(current ? String(current.id) : "");
    }).catch(console.error);
  }, [feedback.businessCode]);
  const save = async () => {
    await api.updateFeedback(feedback.id, {
      priority,
      ...(businessRuleId ? { businessRuleId: Number(businessRuleId), addPositiveExample: isNewSceneCandidate } : {})
    });
    if (isNewSceneCandidate) notify("已修正到已有场景，并将该反馈加入所选场景正例");
    await updated();
  };
  const createScene = async () => {
    const name = window.prompt("请输入并确认新场景名称");
    if (!name?.trim()) return;
    setDraftBusy(true);
    try {
      const { draft } = await api.generateBusinessRuleDraft(feedback.id, name.trim(), "其他");
      notify("新场景草稿已生成，请检查后保存应用");
      openRuleDraft(draft);
    } catch (error) {
      notify(error instanceof Error ? error.message : "新场景草稿生成失败");
    } finally {
      setDraftBusy(false);
    }
  };
  return <div className="overlay" onMouseDown={close}><aside className="drawer" onMouseDown={(e) => e.stopPropagation()}><div className="drawer-head"><div><span>反馈 #{feedback.id}</span><h2>智能分析与处置方案</h2></div><button onClick={close}><X /></button></div><div className="drawer-body">
    <section className="identity"><div><span>用户</span><strong>{feedback.username} · {feedback.userId}</strong></div><div><span>联系电话</span><strong>{feedback.contact}</strong></div><div><span>位置</span><strong>{feedback.building}</strong></div><div><span>提交时间</span><strong>{feedback.submittedAt}</strong></div></section>
    <section><h3>原始反馈</h3><blockquote>{feedback.content}</blockquote></section>
    <section className="classification-editor"><div className="classification-summary"><span>当前业务分类</span><strong>{feedback.level1 || "待分析"} / {feedback.level2 || "待处理"}</strong><em>规则V{feedback.ruleVersion}</em></div>{isNewSceneCandidate && <div className="new-scene-choice"><button type="button" className="filter-selected">选择已有场景</button><button type="button" onClick={createScene} disabled={draftBusy}>{draftBusy ? "生成中..." : "新建场景"}</button></div>}<div className="edit-grid combined-edit"><label>业务分类<select value={businessRuleId} onChange={(e) => { setBusinessRuleId(e.target.value); const next = rules.find((rule) => String(rule.id) === e.target.value); if (next) setPriority(next.priority); }}><option value="">请选择业务分类</option>{rules.filter((rule) => !(rule.level1 === "其他" && rule.level2 === "新增场景待确认")).map((rule) => <option key={rule.id} value={rule.id}>{rule.level1} / {rule.level2}</option>)}</select></label><label>优先级<select value={priority} onChange={(e) => setPriority(e.target.value as Feedback["priority"])}><option value="紧急">紧急</option><option value="风险">风险</option><option value="一般">一般</option><option value="待定">待定</option></select></label><button className="primary" disabled={!businessRuleId} onClick={save}>{isNewSceneCandidate ? "保存到已有场景并加入正例" : "保存修正"}</button></div></section>
    <section><h3>反馈分析</h3><p>{feedback.rationale}</p></section>
    <CopySolution title="住户可复制话术" text={feedback.residentMessage} step="01" first />
    <CopySolution title="专业报修可复制话术" text={feedback.utilityMessage} step="02" />
  </div></aside></div>;
}

function CopySolution({ title, text, step, first }: { title: string; text: string; step: string; first?: boolean }) {
  return <section className={`solution copy-solution ${first ? "first" : ""}`}><div className="step">{step}</div><div><div className="solution-title"><h3>{title}</h3><button onClick={() => navigator.clipboard.writeText(text)}>复制话术</button></div><p>{text}</p></div></section>;
}

function AutoTextarea({ value, onChange, minRows = 1 }: { value: string; onChange: (value: string) => void; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
    const verticalPadding = textarea.offsetHeight - textarea.clientHeight;
    textarea.style.height = `${Math.max(textarea.scrollHeight, minRows * lineHeight + verticalPadding)}px`;
  }, [value, minRows]);
  return <textarea ref={ref} className="auto-textarea" value={value} onChange={(event) => onChange(event.target.value)} />;
}

const promptTerms = (value = "") =>
  value.split(/[、，,；;|/\n\s]+/).map((item) => item.trim()).filter(Boolean);

function PromptTermChips({ value, onChange, editable = false }: { value: string; onChange?: (value: string) => void; editable?: boolean }) {
  const terms = promptTerms(value);
  const update = (next: string[]) => onChange?.(next.map((item) => item.trim()).filter(Boolean).join("、"));
  if (!editable) {
    return <span className="prompt-chips">{terms.map((term) => <span key={term}>{term}</span>)}</span>;
  }
  return (
    <div className="prompt-chip-editor">
      {terms.map((term, index) => (
        <span key={`${term}-${index}`} className="prompt-chip-input">
          <input value={term} onChange={(event) => update(terms.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} />
          <button type="button" onClick={() => update(terms.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </span>
      ))}
      <button type="button" className="add-chip" onClick={() => update([...terms, "新提示词"])}>新增提示词</button>
    </div>
  );
}

const defaultRuleNodesFor = (rule: Partial<BusinessRule>): RuleNode[] => [
  {
    id: "ai-dictionary",
    title: "AI 协同读取场景字典",
    order: 1,
    enabled: true,
    content: `一级分类：${rule.level1 || ""}\n二级分类：${rule.level2 || ""}\n标准提示词：${rule.standardPrompt || ""}`
  },
  {
    id: "local-score",
    title: "本地规则打分生成候选场景",
    order: 2,
    enabled: true,
    content: `必须满足：${rule.requiredCondition || ""}\n排除条件：${rule.excludedCondition || ""}\n相似场景区分：${rule.similarDifference || ""}\n判定规则：${rule.decisionRule || ""}`
  },
  {
    id: "strong-rule",
    title: "特殊强规则优先",
    order: 3,
    enabled: true,
    content: "命中明确安全风险、举报、投诉、停电等强意图时，提高对应场景优先级。"
  },
  {
    id: "low-confidence",
    title: "低置信度转新增场景待确认/无法识别",
    order: 4,
    enabled: true,
    content: "匹配度≥90直接分类；80-89高可信分类；60-79待确认；低于60不匹配；全部低于80但诉求明确时进入新增场景待确认。"
  },
  {
    id: "ai-candidate",
    title: "AI 在候选场景中选择最合适分类并生成说明",
    order: 5,
    enabled: true,
    content: `口语化正例：${(rule.positiveExamples || []).join("；")}\n口语化反例：${(rule.negativeExamples || []).join("；")}\n边界样本：${(rule.boundaryExamples || []).join("；")}`
  },
  {
    id: "fallback",
    title: "AI 不可用时使用本地规则兜底",
    order: 6,
    enabled: true,
    content: "AI接口异常、超时或返回无效时，使用本地最高分候选场景生成分析结果。"
  },
  {
    id: "save-status",
    title: "按置信度保存状态",
    order: 7,
    enabled: true,
    content: "置信度≥80保存为已分析；60-79保存为待确认；低于60保存为分析失败并清空派生分析字段。"
  }
];

const nodesFor = (rule: Partial<BusinessRule>) =>
  (rule.ruleNodes?.length ? rule.ruleNodes : defaultRuleNodesFor(rule)).slice().sort((a, b) => a.order - b.order);

const textAfterLabel = (content: string, label: string) => {
  const match = content.match(new RegExp(`${label}[:：]([^\\n]*)`));
  return match?.[1]?.trim();
};

const splitSamples = (value = "") => value.split(/[；;\n]+/).map((item) => item.trim()).filter(Boolean);

const syncRuleFromNodes = (rule: Partial<BusinessRule>) => {
  const nodes = nodesFor(rule);
  const dictionary = nodes.find((node) => node.id === "ai-dictionary")?.content || "";
  const localScore = nodes.find((node) => node.id === "local-score")?.content || "";
  const aiCandidate = nodes.find((node) => node.id === "ai-candidate")?.content || "";
  return {
    ...rule,
    ruleNodes: nodes,
    standardPrompt: textAfterLabel(dictionary, "标准提示词") || rule.standardPrompt || "",
    requiredCondition: textAfterLabel(localScore, "必须满足") || rule.requiredCondition || "",
    excludedCondition: textAfterLabel(localScore, "排除条件") || rule.excludedCondition || "",
    similarDifference: textAfterLabel(localScore, "相似场景区分") || rule.similarDifference || "",
    decisionRule: textAfterLabel(localScore, "判定规则") || rule.decisionRule || "",
    positiveExamples: splitSamples(textAfterLabel(aiCandidate, "口语化正例") || "").length ? splitSamples(textAfterLabel(aiCandidate, "口语化正例") || "") : rule.positiveExamples || [],
    negativeExamples: splitSamples(textAfterLabel(aiCandidate, "口语化反例") || "").length ? splitSamples(textAfterLabel(aiCandidate, "口语化反例") || "") : rule.negativeExamples || [],
    boundaryExamples: splitSamples(textAfterLabel(aiCandidate, "边界样本") || "").length ? splitSamples(textAfterLabel(aiCandidate, "边界样本") || "") : rule.boundaryExamples || []
  };
};

function RuleNodesEditor({ rule, onChange, readonly = false }: { rule: Partial<BusinessRule>; onChange?: (rule: Partial<BusinessRule>) => void; readonly?: boolean }) {
  const nodes = nodesFor(rule);
  const updateNode = (id: string, patch: Partial<RuleNode>) => {
    onChange?.({ ...rule, ruleNodes: nodes.map((node) => node.id === id ? { ...node, ...patch } : node).sort((a, b) => a.order - b.order) });
  };
  const removeNode = (id: string) => onChange?.({ ...rule, ruleNodes: nodes.filter((node) => node.id !== id).map((node, index) => ({ ...node, order: index + 1 })) });
  const addNode = () => onChange?.({
    ...rule,
    ruleNodes: [...nodes, { id: `custom-${Date.now()}`, title: "自定义规则节点", content: "", enabled: true, order: nodes.length + 1 }]
  });
  return (
    <div className="rule-node-list">
      {nodes.map((node) => (
        <section key={node.id} className={!node.enabled ? "disabled" : ""}>
          <div className="node-head">
            <span>{node.order}</span>
            {readonly ? <strong>{node.title}</strong> : <input value={node.title} onChange={(event) => updateNode(node.id, { title: event.target.value })} />}
            {!readonly && <label><input type="checkbox" checked={node.enabled} onChange={(event) => updateNode(node.id, { enabled: event.target.checked })} />启用</label>}
          </div>
          {readonly ? <p>{node.content}</p> : <AutoTextarea value={node.content} onChange={(value) => updateNode(node.id, { content: value })} />}
          {!readonly && <div className="node-actions"><label>顺序<input type="number" min={1} value={node.order} onChange={(event) => updateNode(node.id, { order: Number(event.target.value) || node.order })} /></label><button type="button" onClick={() => removeNode(node.id)}>删除节点</button></div>}
        </section>
      ))}
      {!readonly && <button type="button" className="add-node" onClick={addNode}>新增规则节点</button>}
    </div>
  );
}

function BusinessRules({ notify, onVersion, initialDraft, onDraftConsumed }: { notify: (text: string) => void; onVersion: (version: number) => void; initialDraft?: Partial<BusinessRule> | null; onDraftConsumed?: () => void }) {
  const emptyRule: Partial<BusinessRule> = {
    level1: "",
    level2: "",
    priority: "一般",
    standardPrompt: "",
    requiredCondition: "",
    excludedCondition: "",
    similarDifference: "",
    decisionRule: "",
    positiveExamples: [],
    negativeExamples: [],
    boundaryExamples: [],
    ruleNodes: [],
    active: true
  };
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [level1, setLevel1] = useState("");
  const [level2, setLevel2] = useState("");
  const [viewing, setViewing] = useState<BusinessRule | null>(null);
  const [editing, setEditing] = useState<Partial<BusinessRule> | null>(null);
  const lines = (value?: string[]) => (value || []).join("\n");
  const splitLines = (value: string) => value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const load = useCallback(async () => {
    const result = await api.businessRules(level1, level2);
    setRules(result.rules);
    onVersion(result.version);
  }, [level1, level2, onVersion]);
  useEffect(() => { load().catch(console.error); }, [load]);
  useEffect(() => {
    if (!initialDraft) return;
    setEditing({ ...initialDraft, ruleNodes: nodesFor(initialDraft), active: initialDraft.active !== false });
    onDraftConsumed?.();
  }, [initialDraft, onDraftConsumed]);
  const level1Options = [...new Set(rules.map((rule) => rule.level1))];
  const level2Options = [...new Set(rules.filter((rule) => !level1 || rule.level1 === level1).map((rule) => rule.level2))];
  const save = async () => {
    if (!editing) return;
    try {
      const payload = syncRuleFromNodes({ ...editing, scenario: editing.level2 });
      const result = await api.saveBusinessRule(payload);
      onVersion(result.version);
      setEditing(null);
      await load();
      notify("场景字典已更新，后续分析将使用最新规则");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };
  const remove = async (rule: BusinessRule) => {
    if (!window.confirm(`确定删除“${rule.level1} / ${rule.level2}”吗？使用该场景的历史反馈将变为待重新分析。`)) return;
    try {
      const result = await api.deleteBusinessRule(rule.id);
      onVersion(result.version);
      await load();
      notify("场景已删除，后续分析将使用最新字典");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };
  return (
    <div className="rules-page">
      <div className="tag-hero">
        <div>
          <p>SCENE DICTIONARY</p>
          <h2>电力业务场景字典</h2>
          <span>{level1Options.length}个一级分类 · {rules.length}个二级场景 · 每次修改即时更新后续分析</span>
        </div>
        <button className="primary" onClick={() => setEditing(emptyRule)}><Plus size={16} />新增场景</button>
      </div>
      <div className="panel rules-panel">
        <div className="table-tools">
          <select value={level1} onChange={(e) => { setLevel1(e.target.value); setLevel2(""); }}>
            <option value="">全部一级分类</option>
            {level1Options.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select value={level2} onChange={(e) => setLevel2(e.target.value)}>
            <option value="">全部二级分类</option>
            {level2Options.map((value) => <option key={value}>{value}</option>)}
          </select>
          <span>共 {rules.length} 条场景</span>
        </div>
        <div className="rules-list">
          {rules.map((rule) => (
            <article key={rule.id} className={!rule.active ? "disabled" : ""}>
              <div>
                <span>{rule.level1}</span>
                <strong>{rule.level2}</strong>
                <p className="prompt-row"><b>提示词：</b><PromptTermChips value={rule.standardPrompt} /></p>
              </div>
              <div className="rule-actions">
                <button onClick={() => setViewing(rule)}>查看</button>
                <button onClick={() => setEditing({ ...rule, ruleNodes: nodesFor(rule) })}>修改</button>
                <button className="danger-text" onClick={() => remove(rule)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      </div>
      {viewing && (
        <div className="overlay">
          <div className="modal rule-modal">
            <div className="drawer-head">
              <div><span>场景详情</span><h2>{viewing.level1} / {viewing.level2}</h2></div>
              <button onClick={() => setViewing(null)}><X /></button>
            </div>
            <div className="rule-view">
              <p><b>优先级：</b>{viewing.priority}</p>
              <p className="prompt-row"><b>标准提示词：</b><PromptTermChips value={viewing.standardPrompt} /></p>
              <RuleNodesEditor rule={viewing} readonly />
            </div>
            <div className="modal-actions">
              <button onClick={() => setViewing(null)}>关闭</button>
              <button className="primary" onClick={() => { setEditing({ ...viewing, ruleNodes: nodesFor(viewing) }); setViewing(null); }}>进入修改</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="overlay">
          <div className="modal rule-modal">
            <div className="drawer-head">
              <div>
                <span>场景字典</span>
                <h2>{editing.id ? "修改场景" : "新增场景"}</h2>
              </div>
              <button onClick={() => setEditing(null)}><X /></button>
            </div>
            <div className="rule-form">
              <label>一级分类<input value={String(editing.level1 || "")} onChange={(e) => setEditing({ ...editing, level1: e.target.value })} /></label>
              <label>二级分类<input value={String(editing.level2 || "")} onChange={(e) => setEditing({ ...editing, level2: e.target.value })} /></label>
              <label>优先级<select value={editing.priority || "一般"} onChange={(e) => setEditing({ ...editing, priority: e.target.value as BusinessRule["priority"] })}><option value="紧急">紧急</option><option value="风险">风险</option><option value="一般">一般</option><option value="待定">待定</option></select></label>
              <label className="wide">标准提示词<PromptTermChips editable value={editing.standardPrompt || ""} onChange={(value) => setEditing({ ...editing, standardPrompt: value })} /></label>
              <label className="wide">必须满足条件<AutoTextarea value={editing.requiredCondition || ""} onChange={(value) => setEditing({ ...editing, requiredCondition: value })} /></label>
              <label className="wide">排除条件<AutoTextarea value={editing.excludedCondition || ""} onChange={(value) => setEditing({ ...editing, excludedCondition: value })} /></label>
              <label className="wide">相似场景区分<AutoTextarea value={editing.similarDifference || ""} onChange={(value) => setEditing({ ...editing, similarDifference: value })} /></label>
              <label className="wide">判定规则<AutoTextarea value={editing.decisionRule || ""} onChange={(value) => setEditing({ ...editing, decisionRule: value })} /></label>
              <label className="wide">口语化正例样本（每行一条）<AutoTextarea minRows={3} value={lines(editing.positiveExamples)} onChange={(value) => setEditing({ ...editing, positiveExamples: splitLines(value) })} /></label>
              <label className="wide">口语化反例样本（每行一条）<AutoTextarea minRows={3} value={lines(editing.negativeExamples)} onChange={(value) => setEditing({ ...editing, negativeExamples: splitLines(value) })} /></label>
              <label className="wide">边界样本（每行一条）<AutoTextarea minRows={3} value={lines(editing.boundaryExamples)} onChange={(value) => setEditing({ ...editing, boundaryExamples: splitLines(value) })} /></label>
              <div className="wide">
                <div className="node-section-title"><strong>识别逻辑规则节点</strong><span>按执行顺序展示，保存后用于后续场景识别</span></div>
                <RuleNodesEditor rule={editing} onChange={setEditing} />
              </div>
              <label className="rule-active"><input type="checkbox" checked={editing.active !== false} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />启用该场景</label>
            </div>
            <div className="modal-actions">
              <button onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={save}>保存并更新分析规则</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Report({ data, period, batchId }: { data: DashboardData; period: string; batchId: number }) {
  const topType = data.typeDistribution[0];
  const topBuilding = data.buildingStats[0];
  const [aiReport, setAiReport] = useState<{ status: string; content: Record<string, string>; stale: boolean } | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const loadReport = useCallback(async () => setAiReport((await api.aiReport(batchId, period)).report), [batchId, period]);
  useEffect(() => { loadReport().catch(console.error); }, [loadReport]);
  useEffect(() => {
    if (aiReport?.status !== "running") return;
    const timer = window.setInterval(loadReport, 1200);
    return () => window.clearInterval(timer);
  }, [aiReport?.status, loadReport]);
  const generate = async () => {
    setReportBusy(true);
    await api.generateAiReport(batchId, period);
    await loadReport();
    setReportBusy(false);
  };
  const text = (key: string, fallback: React.ReactNode) => aiReport?.content?.[key] || fallback;
  return <div className="report-layout"><aside className="report-nav"><span>报告目录</span>{["数据概览","关键词与问题分类分析","优先级分布分析","时空分布分析","同比环比专项分析","情感分析","故障原因研判","故障预警","整改处置建议"].map((item, i) => <a key={item} href={`#report-${i}`}>{String(i + 1).padStart(2, "0")} {item}</a>)}</aside><article className="report-paper">
    <div className="report-cover"><p>POWER OPERATIONS ANALYSIS</p><h2>小区电力用户反馈<br />总体分析报告</h2><div><span>统计周期</span><strong>{data.currentPeriod}</strong><span>规则版本</span><strong>V{data.tagVersion}</strong></div><div className="report-actions"><button className="primary" disabled={reportBusy || aiReport?.status === "running"} onClick={generate}>{aiReport?.status === "running" ? "AI报告生成中" : aiReport?.stale ? "规则已变化，重新生成" : aiReport ? "重新生成AI报告" : "生成AI详细报告"}</button><a href={`/api/reports/word?period=${period}&batchId=${batchId}`}><Download size={16} />Word</a><a href={`/api/reports/pdf?period=${period}&batchId=${batchId}`}><Download size={16} />PDF</a></div></div>
    <ReportSection id={0} title="数据概览"><div className="report-kpis"><div><strong>{data.total}</strong><span>反馈总量</span></div><div><strong>{data.highPriority}</strong><span>紧急优先级</span></div><div><strong>{data.complaintRate.toFixed(1)}%</strong><span>负面投诉占比</span></div></div><p>{text("overview", `本期共${data.total}条反馈，紧急优先级${data.highPriority}条。`)}</p></ReportSection>
    <ReportSection id={1} title="关键词与问题分类分析"><p>{text("classification", `问题数量最高的是${topType?.name || "暂无"}，共${topType?.value || 0}条。`)}</p><MiniTable rows={data.typeDistribution.slice(0, 8).map((x) => [x.name, `${x.value}条`, data.total ? `${(x.value / data.total * 100).toFixed(1)}%` : "0%"])} /></ReportSection>
    <ReportSection id={2} title="优先级分布分析"><p>{text("priority", `紧急优先级${data.highPriority}条，应立即确认风险并派单。`)}</p></ReportSection>
    <ReportSection id={3} title="时空分布分析"><p>{text("spacetime", topBuilding ? `${topBuilding.name}反馈最多，共${topBuilding.value}条。` : "当前周期暂无楼栋反馈。")}</p></ReportSection>
    <ReportSection id={4} title="同比环比专项分析"><p>{text("comparison", `反馈量环比${data.comparisonTrend.at(-1)?.momLabel}，同比${data.comparisonTrend.at(-1)?.yoyLabel}。`)}</p><MiniTable rows={data.typeChanges.slice(0, 6).map((x) => [x.name, `环比 ${x.momLabel}`, `同比 ${x.yoyLabel}`])} /></ReportSection>
    <ReportSection id={5} title="情感分析"><p>{text("sentiment", `负面投诉占比为${data.complaintRate.toFixed(1)}%。`)}</p></ReportSection>
    <ReportSection id={6} title="故障原因研判（综合推断）"><p>{text("diagnosis", "当前数据不足以确认具体故障原因，应结合现场检测验证。")}</p></ReportSection>
    <ReportSection id={7} title="故障预警"><p>{text("alerts", data.alerts.length ? data.alerts.map((a) => `${a.title}：${a.detail}`).join("；") : "本期未触发异常预警。")}</p></ReportSection>
    <ReportSection id={8} title="批量整改处置建议"><p>{text("actions", "按优先级和高频业务场景制定工单与巡检计划。")}</p></ReportSection>
  </article></div>;
}

function ReportSection({ id, title, children }: { id: number; title: string; children: React.ReactNode }) {
  return <section id={`report-${id}`} className="report-section"><span>{String(id + 1).padStart(2, "0")}</span><h3>{title}</h3>{children}</section>;
}
function MiniTable({ rows }: { rows: string[][] }) { return <div className="mini-table">{rows.map((row, i) => <div key={i}>{row.map((cell) => <span key={cell}>{cell}</span>)}</div>)}</div>; }

function TagManagement({ tags, suggestions, version, reload, notify }: { tags: Tag[]; suggestions: TagSuggestion[]; version: number; reload: () => Promise<void>; notify: (s: string) => void }) {
  const [mergeTargets, setMergeTargets] = useState<Record<number, number>>({});
  const pending = suggestions.filter((item) => item.status === "待审核");
  const act = async (fn: () => Promise<unknown>, text: string) => { try { await fn(); await reload(); notify(text); } catch (e) { notify(e instanceof Error ? e.message : "操作失败"); } };
  return <div className="tag-page"><div className="tag-hero"><div><p>动态分类治理</p><h2>标签体系 V{version}</h2><span>AI提出建议，人工审核后进入正式统计口径</span></div><div><strong>{tags.filter((t) => t.active).length}</strong><span>有效标签</span><strong>{pending.length}</strong><span>待审核建议</span></div></div>
    <section className="panel"><div className="section-head"><div><h3>待审核标签建议</h3><p>审核通过、合并或驳回，避免同义标签导致口径漂移</p></div></div>
      {pending.length === 0 ? <div className="empty"><Tags /><p>暂无待审核标签建议</p></div> : <div className="suggestion-grid">{pending.map((item) => <article key={item.id}><div className="suggestion-title"><span>AI建议</span><h3>{item.proposedName}</h3></div><p>{item.definition}</p><dl><dt>适用边界</dt><dd>{item.boundary}</dd><dt>建议依据</dt><dd>{item.rationale}</dd><dt>相近标签</dt><dd>{item.similarTag}</dd></dl><div className="chips">{item.keywords.map((x) => <em key={x}>{x}</em>)}</div><div className="suggestion-actions"><button className="primary" onClick={() => act(() => api.approveSuggestion(item.id), "新标签已加入正式标签库")}>审核通过</button><select value={mergeTargets[item.id] || ""} onChange={(e) => setMergeTargets({ ...mergeTargets, [item.id]: Number(e.target.value) })}><option value="">选择合并目标</option>{tags.filter((t) => t.active).map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}</select><button disabled={!mergeTargets[item.id]} onClick={() => act(() => api.mergeSuggestion(item.id, mergeTargets[item.id]), "建议已合并为标签别名")}>合并</button><button className="danger-text" onClick={() => act(() => api.rejectSuggestion(item.id), "建议已驳回")}>驳回</button></div></article>)}</div>}
    </section>
    <section className="panel"><div className="section-head"><div><h3>正式标签库</h3><p>停用标签保留历史结果，但不参与新反馈分类</p></div></div><div className="tag-list">{tags.map((tag) => <div key={tag.id} className={!tag.active ? "disabled" : ""}><div className="tag-main"><strong>{tag.name}</strong><span>{tag.source === "preset" ? "预设标签" : "审核新增"} · V{tag.version}</span><p>{tag.description}</p><div className="chips">{[...tag.keywords, ...tag.aliases].slice(0, 8).map((x) => <em key={x}>{x}</em>)}</div></div><label className="switch"><input type="checkbox" checked={tag.active} onChange={(e) => act(() => api.toggleTag(tag.id, e.target.checked), e.target.checked ? "标签已启用" : "标签已停用")} /><span /></label></div>)}</div></section>
  </div>;
}

function ImportModal({ state, setState, close, confirm, busy }: { state: { file: File; headers: string[]; mapping: Record<string, string>; preview: Record<string, unknown>[] }; setState: (v: typeof state) => void; close: () => void; confirm: () => void; busy: boolean }) {
  const requiredReady = ["submittedAt", "building", "content"].every((key) => state.mapping[key]);
  return <div className="overlay"><div className="modal import-modal"><div className="drawer-head"><div><span>数据导入向导</span><h2>确认字段映射</h2></div><button onClick={close}><X /></button></div><div className="mapping-grid">{Object.entries(fieldNames).map(([key, label]) => <label key={key}>{label}{["submittedAt","building","content"].includes(key) && <b>*</b>}<select value={state.mapping[key] || ""} onChange={(e) => setState({ ...state, mapping: { ...state.mapping, [key]: e.target.value } })}><option value="">未映射</option>{state.headers.map((header) => <option value={header} key={header}>{header}</option>)}</select></label>)}</div><div className="preview"><h3>数据预览（前 {state.preview.length} 行）</h3><div className="table-wrap"><table><thead><tr>{state.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{state.preview.map((row, i) => <tr key={i}>{state.headers.map((h) => <td key={h}>{String(row[h] ?? "")}</td>)}</tr>)}</tbody></table></div></div><div className="modal-actions"><button onClick={close}>取消</button><button className="primary" disabled={!requiredReady || busy} onClick={confirm}>{busy ? <LoaderCircle className="spin" /> : <FileSpreadsheet />}确认导入并分析</button></div></div></div>;
}

export default App;
