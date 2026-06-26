import crypto from "node:crypto";
import { activeBusinessRules, currentRuleVersion, type BusinessRule } from "./business-rules.js";
import { db } from "./db.js";

export type AnalysisInput = {
  id?: number;
  userId: string;
  username: string;
  contact: string;
  submittedAt: string;
  building: string;
  content: string;
};

export type Analysis = {
  keywords: string[];
  level1: string;
  level2: string;
  scenario: string;
  businessCode: string;
  priority: "紧急" | "风险" | "一般" | "待定";
  sentiment: "负面投诉" | "常规报修" | "优化建议" | "咨询内容";
  feedbackAnalysis: string;
  selfCheck: string[];
  resolution: string;
  residentMessage: string;
  utilityMessage: string;
  source: "ai" | "manual";
  ruleVersion: number;
  confidence: number;
};

const complaintWords = ["投诉", "多次反映", "一直没人处理", "无人处理", "严重影响", "必须解决", "举报"];
const dangerWords = ["冒烟", "起火", "漏电", "电击", "火花", "烧焦", "裸露", "安全隐患", "焦糊"];
const largeOutageWords = ["整栋", "全楼", "整个小区", "多栋", "大面积"];

const tokens = (text: string) =>
  [...new Set(text.replace(/[【】。，；：、（）()“”"'！？!?]/g, " ").split(/\s+/).filter((word) => word.length >= 2))];

const splitTerms = (value: string) =>
  value.split(/[、，,；;|/\s]+/).map((item) => item.trim()).filter((item) => item.length >= 2 && !["无", "否", "是"].includes(item));

const extractRuleField = (rule: BusinessRule, label: string) => {
  const line = rule.decisionRule.split(/\r?\n/).find((item) => item.startsWith(`${label}：`));
  return line ? line.slice(label.length + 1).trim() : "";
};

const ruleField = (rule: BusinessRule, field: "requiredCondition" | "excludedCondition" | "similarDifference", fallbackLabel: string) =>
  (rule[field] || extractRuleField(rule, fallbackLabel)).trim();

const grams = (text: string) =>
  new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));

const textSimilarity = (left: string, right: string) => {
  const a = left.replace(/\s/g, "");
  const b = right.replace(/\s/g, "");
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const aGrams = grams(a);
  const bGrams = grams(b);
  const overlap = [...aGrams].filter((gram) => bGrams.has(gram)).length;
  return overlap / Math.max(1, Math.min(aGrams.size, bGrams.size));
};

const bestSampleSimilarity = (content: string, samples: string[]) =>
  samples.reduce((best, sample) => Math.max(best, textSimilarity(content, sample)), 0);

const hasClearIntent = (content: string) =>
  content.trim().length >= 8 &&
  !/^(在吗|你好|您好|帮看看|看看|有人吗|[？?。！!\s]+)$/.test(content.trim()) &&
  /电|费|表|线|停|跳闸|故障|投诉|举报|建议|办理|查询|冒烟|火花|漏电|异常|坏|不稳|没|断|充电|户号|过户|报装|赔偿|补偿|抢修|现象/.test(content);

const colloquialPatterns: Record<string, RegExp[]> = {
  电费电价咨询: [
    /电费.*(多少|为啥|为什么|怎么|咋|贵|高|异常|不对|不正常|欠费|余额|账单|明细|怎么算)/,
    /(余额|欠费|缴费|交费|峰谷|分时|电价|账单|扣费|费用).*(查|查询|看看|多少|怎么|咋|为啥|为什么|不对|异常)/,
    /(怎么|咋|如何).*(交电费|缴电费|查电费|看电费|办峰谷|峰谷电价)/,
    /(帮我|给我|麻烦).{0,6}(看看|查查).{0,8}(电费|电价|账单|余额)/
  ],
  停电信息查询: [
    /(是不是|是否|有没有|是不是又|是不是在).{0,8}停电/,
    /(咋|怎么|为啥|为什么).{0,8}停电(了|啦|吗|呀|呢)?/,
    /停电(了|了吗|吗|啦|了没|没有|是不是|多久|什么时候|啥时候|何时).*(来电|复电|恢复)?/,
    /(来电|复电).*(了吗|没有|多久|什么时候|啥时候|何时)/,
    /(哪里|哪片|范围|原因).{0,8}停电/,
    /(热|冷|做饭|上班|小区).{0,8}停电(了|啦|吗|呀|呢)?/
  ],
  用户档案查询: [
    /(户号|客户编号|用户编号|档案|用户信息).*(查|查询|看看|是多少|忘了|不知道)/,
    /(怎么|咋|如何).*(查户号|查客户编号|查用户信息)/,
    /(我家|这个房子|这户).{0,8}(户号|用户编号|客户编号).{0,8}(多少|是啥|忘了|查一下)/
  ],
  电表咨询: [
    /电表.*(怎么|咋|如何|咨询|安装|更换|申请|办理|要不要|能不能)/,
    /(想|要|需要).*(装电表|换电表|咨询电表)/,
    /(电表).{0,8}(怎么看|咋看|读数|功能|说明|是不是智能)/
  ],
  供电服务咨询: [
    /(营业厅|供电所|供电公司|95598|客服电话|电话|联系方式|地址).*(在哪|哪里|多少|怎么联系|咨询|查询|上班|营业)/,
    /(怎么|咋|如何).*(联系|找).*(供电|电力|客服)/,
    /(供电|电力|营业厅|供电所).{0,8}(电话|地址|上班|几点|在哪|怎么去)/
  ],
  充电桩服务: [
    /充电桩.*(怎么|咋|如何|申请|办理|安装|容量|咨询|能不能|可不可以|装|报装)/,
    /(电动车|电动汽车|新能源车).*(充电|充电桩|装桩|容量)/,
    /(车位|地下车库|新能源).{0,10}(装桩|装个充电|充电桩|接电充车)/
  ],
  用电报装: [
    /(新装|报装|增容|减容|临时用电|接电|开户).*(怎么|咋|如何|申请|办理|流程|材料|能不能|可不可以)/,
    /(想|要|需要).*(新装电|报装|增容|临时用电|接电)/,
    /(店铺|新房|工地|摊位).{0,8}(接电|开电|新装|报装|增容)/
  ],
  用户信息变更: [
    /(过户|更名|户主变更|改名字|改户名|变更户主).*(怎么|咋|如何|申请|办理|流程|材料|能不能)/,
    /(想|要|需要).*(过户|更名|改户主|改户名)/,
    /(房子|电费户|户主).{0,8}(换成|改成|改到|过到|变更到).{0,8}(我|别人|新业主|家人)/
  ],
  电表业务办理: [
    /(移表|换表|拆表).*(怎么|咋|如何|申请|办理|流程|材料|能不能|可不可以)/,
    /(想|要|需要).*(移电表|换电表|拆电表)/,
    /(电表).{0,8}(挪一下|换一个|拆掉|移个位置|迁走)/
  ],
  停电跳闸故障: [
    /(家里|屋里|房间|我家|我们家|楼上|楼下).*(没电|断电|停电|跳闸|无电)/,
    /(突然|一直|反复).*(没电|断电|跳闸|停电)/,
    /(空气开关|电闸|漏保).*(跳|跳了|合不上)/,
    /(一用电|开空调|插上|做饭).{0,8}(就跳闸|就断电|没电了|闸掉了)/
  ],
  电压异常: [
    /(电压|灯|灯光|灯泡).*(低|高|不稳|忽高忽低|闪|闪烁|一闪一闪|暗|忽明忽暗)/,
    /(电器|空调|冰箱).*(重启|启动不了|忽停忽开).*(电压|供电)?/,
    /(灯|电器).{0,8}(一会亮一会暗|老闪|忽明忽暗|带不动|电不稳)/
  ],
  电表故障: [
    /电表.*(坏|不走|不亮|黑屏|显示异常|转太快|走太快|不准|计量异常|故障)/,
    /(表计|计量).*(不准|异常|故障|有问题)/,
    /(表|电表).{0,8}(没显示|屏不亮|数字乱跳|不动了|走得离谱)/
  ],
  线路设备故障: [
    /(电线|线路|电缆|变压器|配电箱|配电柜|开关).*(断|坏|故障|破损|掉了|烧了|冒火|有问题)/,
    /(设备|公共设备).*(坏了|故障|异常|损坏)/,
    /(楼道|小区|门口|电井).{0,8}(线断了|线掉了|箱子坏了|设备坏了|电缆破了)/
  ],
  用电安全隐患: [
    /(漏电|冒烟|火花|焦糊|烧焦|裸露|电到|触电|有电感|安全隐患)/,
    /(电线|插座|开关|配电箱).*(冒烟|火花|焦糊|漏电|裸露|发烫|烧焦)/,
    /(闻到|看到|摸着).{0,8}(焦味|糊味|冒烟|打火|麻手|有电)/
  ],
  故障抢修: [
    /(抢修|维修|师傅|工单).*(到哪|进度|多久|什么时候|啥时候|还没|催|快点|处理)/,
    /(报修|故障).*(多久修好|什么时候来|没人来|还没修|催修)/,
    /(已经报修|报过修|工单).{0,12}(还没来|啥进度|催一下|多久到|没人联系)/
  ],
  服务投诉与赔偿: [
    /(投诉|赔偿|补偿|服务差|态度差|没人处理|一直没人|多次反映|太慢|不满意|追责)/,
    /(要求|需要|必须).*(赔偿|补偿|处理|解释|道歉)/,
    /(我要|必须给|这事得).{0,8}(说法|赔|补偿|投诉|处理结果|道歉)/
  ],
  意见建议: [
    /(建议|希望|能不能|可不可以|最好|优化|改进|增加|加装|完善).*(服务|设施|线路|电表|充电|通知|流程)?/,
    /(我觉得|建议你们|希望你们).*(优化|改进|增加|完善|调整)/,
    /(能不能|最好|希望).{0,10}(多装|提前通知|改一下|方便点|完善一下)/
  ],
  举报与风险反馈: [
    /(偷电|窃电|举报|违章用电|私拉乱接|私接电线|违规用电)/,
    /(有人|邻居|商户).*(偷电|私拉|乱接|违章用电|违规用电)/,
    /(隔壁|楼下|商铺).{0,10}(乱接线|偷偷接电|偷用电|私自接线|违规用电)/
  ],
  新增场景待确认: [
    /(这个|这种|这个事|这种情况).{0,12}(没分类|没有对应|归哪类|不在现有|新增场景|人工确认)/,
    /(现有场景|你们系统|分类里).{0,12}(没有|不包含|找不到|匹配不上)/
  ],
  无法识别: [
    /^(在吗|你好|您好|帮看看|看看|有人吗|哈喽|hello|hi|[？?。！!\s]+)$/,
    /^[\u{1F300}-\u{1FAFF}\s]+$/u,
    /^(啊|嗯|哦|收到|好的|？？？|。。。)$/
  ]
};

type RuleMatch = {
  rule: BusinessRule;
  score: number;
  confidence: number;
  excludedHits: string[];
  promptHits: string[];
  requiredHits: string[];
};

const scoreRule = (content: string, rule: BusinessRule): RuleMatch => {
  const source = `${rule.level1}${rule.level2}${rule.standardPrompt}${rule.requiredCondition}${rule.excludedCondition}${rule.similarDifference}${rule.decisionRule}${rule.positiveExamples.join("")}${rule.boundaryExamples.join("")}`.replace(/\s/g, "");
  const contentGrams = grams(content);
  let score = [...grams(source)].reduce((total, gram) => total + (contentGrams.has(gram) ? 1 : 0), 0);
  const promptHits = splitTerms(rule.standardPrompt).filter((term) => content.includes(term));
  const requiredHits = splitTerms(ruleField(rule, "requiredCondition", "必须满足")).filter((term) => content.includes(term));
  const excludedHits = splitTerms(ruleField(rule, "excludedCondition", "排除条件")).filter((term) => content.includes(term));
  score += promptHits.length * 12 + requiredHits.length * 10;
  const positiveSimilarity = bestSampleSimilarity(content, rule.positiveExamples);
  const negativeSimilarity = bestSampleSimilarity(content, rule.negativeExamples);
  const boundarySimilarity = bestSampleSimilarity(content, rule.boundaryExamples);
  if (positiveSimilarity >= 0.75) score += 55;
  else if (positiveSimilarity >= 0.5) score += 35;
  else if (positiveSimilarity >= 0.35) score += 18;
  if (boundarySimilarity >= 0.7) score += 24;
  else if (boundarySimilarity >= 0.45) score += 12;
  if (negativeSimilarity >= 0.75) score -= 60;
  else if (negativeSimilarity >= 0.5) score -= 35;
  else if (negativeSimilarity >= 0.35) score -= 18;
  const colloquialHits = (colloquialPatterns[rule.level2] || []).filter((pattern) => pattern.test(content));
  score += colloquialHits.length ? 85 + (colloquialHits.length - 1) * 10 : 0;
  const intentBoosts: [RegExp, RegExp, number][] = [
    [/电费|电价|余额|欠费|峰谷/, /电费电价咨询/, 80],
    [/(是不是|是否|有没有).{0,6}停电|(咋|怎么|为啥|为什么).{0,8}停电|停电(了|了吗|吗|啦|了没)|停电.*(通知|多久|什么时候|来电|复电|原因)/, /停电信息查询/, 80],
    [/户号|客户编号|用户信息/, /用户档案查询/, 70],
    [/电表.*(安装|更换|咨询)/, /电表咨询/, 70],
    [/营业厅|95598|联系方式/, /供电服务咨询/, 70],
    [/充电桩|电动汽车/, /充电桩服务/, 70],
    [/新装|增容|减容|临时用电|报装/, /用电报装/, 80],
    [/过户|更名|户主变更/, /用户信息变更/, 80],
    [/移表|换表|拆表/, /电表业务办理/, 80],
    [/没电|跳闸|断电/, /停电跳闸故障/, 80],
    [/电压低|电压不稳|灯闪|闪烁/, /电压异常/, 80],
    [/电表坏|电表不走|计量异常|电表.*故障/, /电表故障/, 80],
    [/电线断|变压器故障|线路|设备故障/, /线路设备故障/, 80],
    [/漏电|冒烟|火花|焦糊|裸露/, /用电安全隐患/, 90],
    [/抢修|催修|多久修好|维修进度/, /故障抢修/, 80],
    [/投诉|赔偿|补偿|服务差|多次反映|无人处理|一直没人处理/, /服务投诉与赔偿/, 140],
    [/建议|优化|改进/, /意见建议/, 80],
    [/偷电|举报|违章用电/, /举报与风险反馈/, 90],
    [/在吗|帮看看|^\s*[\u{1F300}-\u{1FAFF}]+\s*$/u, /无法识别/, 90]
  ];
  for (const [contentPattern, scenarioPattern, boost] of intentBoosts) {
    if (contentPattern.test(content) && scenarioPattern.test(`${rule.scenario}${rule.decisionRule}`)) score += boost;
  }
  for (const phrase of ["电费", "欠费", "余额", "缴费", "电价", "峰谷", "户号", "停电", "电压", "电表", "充电桩", "跳闸", "线路", "噪音", "过户", "报装"]) {
    if (content.includes(phrase) && source.includes(phrase)) score += 8;
  }
  if (excludedHits.length) score -= 35 + excludedHits.length * 8;
  const confidence = Math.max(0, Math.min(100, Math.round(score)));
  return { rule, score, confidence, excludedHits, promptHits, requiredHits };
};

export const candidateRules = (content: string, limit = 12) =>
  activeBusinessRules()
    .map((rule) => scoreRule(content, rule))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.rule);

const selectRule = (content: string) => {
  const rules = activeBusinessRules();
  if (/偷电|窃电|违章用电|违规用电|私拉乱接|私接电线/.test(content)) {
    const reportRule = rules.find((rule) => rule.level2 === "举报与风险反馈");
    if (reportRule) return reportRule;
  }
  if (complaintWords.some((word) => content.includes(word))) {
    const complaintRule = rules.find((rule) => rule.level2 === "服务投诉与赔偿");
    if (complaintRule) return complaintRule;
  }
  if (dangerWords.some((word) => content.includes(word))) {
    const dangerRule = rules.find((rule) => rule.level2 === "用电安全隐患");
    if (dangerRule) return dangerRule;
  }
  if (/(移|换|拆).{0,3}电表|电表.{0,3}(移|换|拆)/.test(content)) {
    const meterBusinessRule = rules.find((rule) => rule.level2 === "电表业务办理");
    if (meterBusinessRule) return meterBusinessRule;
  }
  const scored = rules
    .map((rule) => scoreRule(content, rule))
    .sort((a, b) => b.score - a.score);
  const unknown = scored.find((item) => item.rule.level1 === "其他" && item.rule.level2 === "无法识别")?.rule;
  const newScene = scored.find((item) => item.rule.level1 === "其他" && item.rule.level2 === "新增场景待确认")?.rule;
  if (!scored[0]) return undefined;
  if (scored[0].confidence < 80 && hasClearIntent(content) && newScene) return newScene;
  if (scored[0].confidence < 60 && unknown) return unknown;
  return scored[0].rule;
};

const confidenceForRule = (input: AnalysisInput, rule: BusinessRule) => {
  if (rule.level2 === "服务投诉与赔偿" && complaintWords.some((word) => input.content.includes(word))) return 95;
  if (rule.level2 === "举报与风险反馈" && /偷电|窃电|违章用电|违规用电|私拉乱接|私接电线/.test(input.content)) return 95;
  if (rule.level2 === "用电安全隐患" && dangerWords.some((word) => input.content.includes(word))) return 95;
  if (rule.level2 === "电表业务办理" && /(移|换|拆).{0,3}电表|电表.{0,3}(移|换|拆)/.test(input.content)) return 95;
  if (isUnrecognizedRule(rule)) return rule.level2 === "新增场景待确认" ? 70 : 0;
  return scoreRule(input.content, rule).confidence;
};

export const isUnrecognizedRule = (rule: Pick<BusinessRule, "level1" | "level2">) =>
  rule.level1 === "其他" && ["无法识别", "新增场景待确认"].includes(rule.level2);

const classifySentiment = (input: AnalysisInput, rule: BusinessRule): Analysis["sentiment"] => {
  if (["服务投诉与赔偿", "举报与风险反馈"].includes(rule.level2) || complaintWords.some((word) => input.content.includes(word))) return "负面投诉";
  if (rule.level2 === "意见建议") return "优化建议";
  if (rule.level1 === "咨询查询") return "咨询内容";
  return "常规报修";
};

const fallbackSelfCheck = (input: AnalysisInput, rule: BusinessRule) => {
  if (isUnrecognizedRule(rule)) {
    return ["补充说明问题发生位置和具体表现", "记录异常出现的时间和频次", "保留现场现象照片或相关信息"];
  }
  if (dangerWords.some((word) => input.content.includes(word))) {
    return ["远离异常设备、裸露线路或积水区域", "记录冒烟、火花、焦糊味等现象", "提醒周边人员避开异常区域"];
  }
  if (/停电|断电|没电|跳闸/.test(input.content)) {
    return rule.level2 === "停电信息查询"
      ? ["确认是否收到计划停电通知", "记录停电开始的大致时间", "询问同楼栋住户是否同样停电"]
      : ["查看户内空气开关状态是否异常", "记录跳闸或断电发生的时间", "询问同楼层住户是否有相同情况"];
  }
  if (/电费|电价|余额|欠费|峰谷/.test(input.content) || rule.level2.includes("电费")) {
    return ["核对近期缴费记录和账单时间", "确认户号或缴费账户是否正确", "记录疑问金额和发生月份"];
  }
  if (/电表/.test(input.content) || rule.level2.includes("电表")) {
    return ["观察电表屏幕是否正常显示", "记录电表异常出现时间和现象", "不要自行拆卸或移动电表"];
  }
  if (/充电桩/.test(input.content) || rule.level2.includes("充电桩")) {
    return ["确认充电枪连接状态正常", "记录充电失败时间和提示信息", "不要拆卸充电桩或配电设施"];
  }
  if (rule.level2 === "用户档案查询") return ["确认需要查询的住户地址", "准备可核对的用户身份信息", "记录需要查询的档案事项"];
  if (rule.level2 === "供电服务咨询") return ["记录需咨询的具体服务事项", "确认所在楼栋和用电地址", "保留已联系渠道或工单信息"];
  if (rule.level2 === "用电报装") return ["确认申请用电地址和用途", "记录预计用电容量或设备情况", "准备产权或使用证明线索"];
  if (rule.level2 === "用户信息变更") return ["核对当前户名和需变更信息", "记录变更原因和生效时间", "准备可证明变更关系的资料"];
  if (rule.level2 === "线路设备故障") return ["远离异常线路或设备区域", "记录设备位置和异常表现", "不要触碰公共配电设施"];
  if (rule.level2 === "故障抢修") return ["记录已报修时间或工单编号", "确认现场问题是否仍存在", "保持联系电话畅通"];
  if (rule.level2 === "服务投诉与赔偿") return ["整理已反馈或报修记录", "记录影响时间和具体损失表现", "保留可证明现场情况的信息"];
  if (rule.level2 === "意见建议") return ["记录建议涉及的位置或流程", "说明希望改进的具体事项", "保留相关现场照片或描述"];
  if (rule.level2 === "举报与风险反馈") return ["记录风险发生位置和时间", "在安全距离外观察具体表现", "不要与相关人员发生现场冲突"];
  return ["确认故障设备电源和插头连接正常", "记录故障出现的时间、频次和具体表现", "不要自行拆卸电表、配电箱或公共线路"];
};

const detailedFeedbackAnalysis = (input: AnalysisInput, rule: BusinessRule) =>
  `用户反馈“${input.content}”。结合“${rule.level2}”场景的标准提示词与判定规则，核心诉求涉及${rule.level1}下的${rule.level2}，反馈现象、业务意图及适用边界与该场景相符。`.slice(0, 120);

const residentNotice = (input: AnalysisInput, rule: BusinessRule, selfCheck: string[]) =>
  [
    `${input.username || "住户"}您好，已收到您反馈的用电问题。`,
    `经分析，您的反馈初步对应“${rule.level1} / ${rule.level2}”场景。请先完成以下与该场景相关的基础排查：\n${selfCheck.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    `${dangerWords.some((word) => input.content.includes(word)) || rule.level2 === "用电安全隐患" ? "该问题存在安全风险，排查时请优先远离异常区域。" : "排查时请以记录和确认信息为主，不进行复杂或危险操作。"}请确保人身安全，不触碰裸露线路，不自行拆卸电表、配电箱或公共设备，并记录异常出现的时间、频次和具体表现。如发现冒烟、火花、焦糊味或漏电迹象，请立即停止并远离现场；如排查后问题仍未解决，我们将安排专业人员与您联系并上门检查维修，请保持电话畅通。`
  ].join("\n\n");

const utilityNotice = (input: AnalysisInput, rule: BusinessRule, selfCheck: string[]) =>
  [
    "电力业务专业报修说明：",
    `用户ID：${input.userId || "未知"}`,
    `用户姓名：${input.username || "未知"}`,
    `联系方式：${input.contact || "未知"}`,
    `反馈提交时间：${input.submittedAt || "未知"}`,
    `楼栋地点：${input.building || "未知"}`,
    `住户描述：${input.content || "未知"}`,
    `初始情况判断：${rule.level2 || "未知"}`,
    "",
    `用户已完成基础排查：\n${selfCheck.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    "上述问题仍未解决，需派遣专业人员上门检查处理，重点核实现场供电、线路连接及相关设备运行状态，并根据检测结果维修处置。"
  ].join("\n");

export const buildAnalysisFromRule = (input: AnalysisInput, rule: BusinessRule, options?: { priority?: Analysis["priority"]; source?: Analysis["source"]; confidence?: number }): Analysis => {
  const keywords = [...new Set([
    ...tokens(input.content).slice(0, 4),
    ...tokens(`${rule.level2} ${rule.scenario}`).filter((word) => input.content.includes(word))
  ])].slice(0, 6);
  const selfCheck = fallbackSelfCheck(input, rule);
  return {
    keywords,
    level1: rule.level1,
    level2: rule.level2,
    scenario: rule.scenario,
    businessCode: rule.businessCode,
    priority: options?.priority || rule.priority,
    sentiment: classifySentiment(input, rule),
    feedbackAnalysis: detailedFeedbackAnalysis(input, rule),
    selfCheck,
    resolution: `核实${rule.level2}对应业务信息和现场情况，按该场景标准流程登记工单并安排专业人员处置。`,
    residentMessage: residentNotice(input, rule, selfCheck),
    utilityMessage: utilityNotice(input, rule, selfCheck),
    source: options?.source || "ai",
    ruleVersion: currentRuleVersion(),
    confidence: options?.confidence ?? confidenceForRule(input, rule)
  };
};

export const analyzeByRule = (input: AnalysisInput) => {
  const rule = selectRule(input.content) || activeBusinessRules()[0];
  if (!rule) throw new Error("业务分析规则为空");
  return buildAnalysisFromRule(input, rule);
};

const callAi = async (input: AnalysisInput, candidates: BusinessRule[]): Promise<Analysis | null> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !candidates.length) return null;
  const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-Title": "Community Power Feedback"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `你是电力业务反馈分析助手。必须从候选场景中选择唯一businessCode，按以下顺序判断：AI协同读取场景字典、本地规则候选、特殊强规则、低置信度边界、候选中选择最合适分类、AI不可用时本地兜底、按置信度保存状态。结合反馈原文、标准提示词、必须满足条件、排除条件、相似场景区分、判定规则、口语化样本和ruleNodes理解完整语境，不可只匹配单词。返回JSON字段：businessCode、keywords(3-6个)、sentiment(负面投诉/常规报修/优化建议/咨询内容)、feedbackAnalysis、selfCheck、resolution。优先级必须使用候选场景自带priority，不要自行创造。feedbackAnalysis使用中文约100字，说明反馈现象、核心诉求和选择该场景的原因。selfCheck为3-4项安全、具体、简洁且住户能够独立完成的基础排查操作，每项不超过30字，禁止要求触碰裸露线路或拆卸电表、配电箱、公共设备。resolution说明后续专业处置重点。`
        },
        {
          role: "user",
          content: JSON.stringify({
            feedback: input,
            candidates: candidates.map((rule) => ({
              businessCode: rule.businessCode,
              level1: rule.level1,
              level2: rule.level2,
              scenario: rule.scenario,
              priority: rule.priority,
              standardPrompt: rule.standardPrompt,
              requiredCondition: rule.requiredCondition,
              excludedCondition: rule.excludedCondition,
              similarDifference: rule.similarDifference,
              decisionRule: rule.decisionRule,
              positiveExamples: rule.positiveExamples,
              negativeExamples: rule.negativeExamples,
              boundaryExamples: rule.boundaryExamples,
              ruleNodes: rule.ruleNodes.filter((node) => node.enabled).sort((a, b) => a.order - b.order)
            }))
          })
        }
      ]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new Error(`AI接口返回${response.status}`);
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}") as Record<string, unknown>;
  const rule = candidates.find((item) => item.businessCode === parsed.businessCode);
  if (!rule || !Array.isArray(parsed.keywords)) return null;
  const fallback = buildAnalysisFromRule(input, rule);
  const analysisText = String(parsed.feedbackAnalysis || "").trim();
  const selfCheck = Array.isArray(parsed.selfCheck)
    ? (parsed.selfCheck as unknown[]).map(String).map((item) => item.trim().replace(/[。；;]+$/, "")).filter(Boolean).slice(0, 4)
    : fallback.selfCheck;
  const finalSelfCheck = selfCheck.length >= 3 ? selfCheck : fallback.selfCheck;
  const feedbackAnalysis = analysisText.length >= 70
    ? analysisText.slice(0, 120)
    : `${analysisText ? `${analysisText}。` : ""}${detailedFeedbackAnalysis(input, rule)}`.slice(0, 120);
  return {
    ...fallback,
    keywords: (parsed.keywords as string[]).slice(0, 6),
    sentiment: (["负面投诉", "常规报修", "优化建议", "咨询内容"].includes(String(parsed.sentiment))
      ? parsed.sentiment
      : fallback.sentiment) as Analysis["sentiment"],
    feedbackAnalysis,
    selfCheck: finalSelfCheck,
    resolution: String(parsed.resolution || fallback.resolution),
    residentMessage: residentNotice(input, rule, finalSelfCheck),
    utilityMessage: utilityNotice(input, rule, finalSelfCheck),
    source: "ai"
  };
};

export const analyzeFeedback = async (input: AnalysisInput): Promise<Analysis> => {
  const candidates = candidateRules(input.content);
  const fallbackRule = selectRule(input.content) || candidates[0] || activeBusinessRules()[0];
  if (!fallbackRule) throw new Error("业务分析规则为空");
  if (isUnrecognizedRule(fallbackRule)) return buildAnalysisFromRule(input, fallbackRule);
  try {
    return (await callAi(input, candidates)) || buildAnalysisFromRule(input, fallbackRule);
  } catch {
    return buildAnalysisFromRule(input, fallbackRule);
  }
};

export const saveAnalysis = (id: number, result: Analysis) => {
  const status = result.confidence >= 80 && !isUnrecognizedRule(result)
    ? "已分析"
    : result.confidence >= 60
      ? "待确认"
      : "分析失败";
  if (status === "分析失败") {
    db.prepare(`
      UPDATE feedback SET keywords='[]',confidence=0,rationale='',self_check='[]',resolution='',
        resident_message='',utility_message='',status='分析失败',source=?,level1='',level2='',scenario='',
        business_code='',rule_version=?,analysis_error=?,analysis_updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(result.source, result.ruleVersion, "匹配度低于60，未形成有效场景分析", id);
    return;
  }
  db.prepare(`
    UPDATE feedback SET keywords=?,priority=?,sentiment=?,confidence=?,rationale=?,self_check=?,resolution=?,
      resident_message=?,utility_message=?,status=?,source=?,level1=?,level2=?,scenario=?,
      business_code=?,rule_version=?,analysis_error='',analysis_updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    JSON.stringify(result.keywords), result.priority, result.sentiment, result.confidence / 100, result.feedbackAnalysis,
    JSON.stringify(result.selfCheck), result.resolution, result.residentMessage, result.utilityMessage,
    status, result.source, result.level1, result.level2, result.scenario, result.businessCode, result.ruleVersion, id
  );
};

export const contentHash = (input: AnalysisInput) =>
  crypto.createHash("sha256").update(`${input.submittedAt}|${input.building}|${input.content}|${input.userId}`).digest("hex");
