import test from "node:test";
import assert from "node:assert/strict";
import { analyzeByRule } from "./analysis.js";
import { activeBusinessRules, seedBusinessRules } from "./business-rules.js";

await seedBusinessRules();

const input = (content: string) => ({
  userId: "U001",
  username: "测试用户",
  contact: "13800000000",
  submittedAt: "2026-06-23 10:00:00",
  building: "1号楼",
  content
});

test("投诉内容匹配投诉场景和紧急优先级", () => {
  const result = analyzeByRule(input("电压一直不稳，多次反映一直没人处理，我要投诉"));
  assert.equal(result.priority, "紧急");
  assert.equal(result.sentiment, "负面投诉");
  assert.ok(result.confidence >= 90);
  assert.ok(result.businessCode);
});

test("安全隐患匹配紧急优先级", () => {
  const result = analyzeByRule(input("楼道电线已经裸露并出现火花"));
  assert.equal(result.priority, "紧急");
  assert.ok(result.level1);
});

test("咨询和建议使用字典优先级", () => {
  assert.equal(analyzeByRule(input("咨询一下峰谷电价如何办理")).priority, "风险");
  assert.equal(analyzeByRule(input("建议增加地下车库充电设施")).priority, "一般");
});

test("业务规则分类返回两级路径和三段式住户话术", () => {
  const result = analyzeByRule(input("厨房墙面附近每天夜间出现不明规律现象"));
  assert.ok(result.level1 && result.level2);
  assert.ok(result.feedbackAnalysis.length >= 70 && result.feedbackAnalysis.length <= 120);
  assert.ok(result.residentMessage.length >= 160);
  assert.equal(result.residentMessage.split(/\n\n/).length, 3);
  assert.ok(result.selfCheck.every((item) => result.residentMessage.includes(item)));
  assert.match(result.residentMessage, /如排查后问题仍未解决，我们将安排专业人员与您联系并上门检查维修，请保持电话畅通/);
  assert.doesNotMatch(result.residentMessage, /高优先级|中优先级|低优先级|上午|下午|点到|小时内/);
  assert.ok(result.utilityMessage.length >= 150);
  assert.match(result.utilityMessage, /用户姓名：测试用户/);
  assert.match(result.utilityMessage, /联系方式：13800000000/);
  assert.match(result.utilityMessage, /用户已完成基础排查/);
});

test("电费异常质疑匹配电费电价咨询", () => {
  const result = analyzeByRule(input("这个月电费高得不正常，怀疑计算错误"));
  assert.equal(result.level1, "咨询查询");
  assert.equal(result.level2, "电费电价咨询");
  assert.equal(result.priority, "风险");
});

test("口语化停电询问匹配停电信息查询", () => {
  const result = analyzeByRule(input("友友们，是不是停电啦"));
  assert.equal(result.level1, "咨询查询");
  assert.equal(result.level2, "停电信息查询");
  assert.equal(result.priority, "一般");
  assert.ok(result.confidence >= 80);
});

test("高温口语化停电询问匹配停电信息查询", () => {
  const result = analyzeByRule(input("重么热的天咋停电了？"));
  assert.equal(result.level1, "咨询查询");
  assert.equal(result.level2, "停电信息查询");
  assert.equal(result.priority, "一般");
  assert.ok(result.confidence >= 80);
});

test("常见口语化表达覆盖主要业务场景", () => {
  const cases: [string, string][] = [
    ["电费怎么这么高，帮我查查账单", "电费电价咨询"],
    ["户号忘了在哪里查", "用户档案查询"],
    ["我想申请新装电表要怎么办", "用电报装"],
    ["这个户主能不能更名过户", "用户信息变更"],
    ["我想把电表移一下怎么申请", "电表业务办理"],
    ["我家突然没电了，电闸也跳了", "停电跳闸故障"],
    ["家里灯一直闪，电压是不是不稳", "电压异常"],
    ["电表黑屏不亮了", "电表故障"],
    ["楼道配电箱好像坏了", "线路设备故障"],
    ["报修这么久还没人来，多久修好", "故障抢修"],
    ["建议小区多装几个充电桩", "意见建议"],
    ["有人私拉电线偷电，我要举报", "举报与风险反馈"]
  ];
  for (const [content, level2] of cases) {
    const result = analyzeByRule(input(content));
    assert.equal(result.level2, level2, content);
    assert.ok(result.confidence >= 80, content);
  }
});

test("每个场景都有口语化规则覆盖", () => {
  const cases: [string, string][] = [
    ["麻烦给我查查这个月电费账单余额", "电费电价咨询"],
    ["这么热咋停电了，到底啥时候来电", "停电信息查询"],
    ["我家这个房子的户号忘了，帮忙查一下", "用户档案查询"],
    ["这个智能电表怎么看读数啊", "电表咨询"],
    ["供电所电话多少，营业厅几点上班", "供电服务咨询"],
    ["地下车库车位想装个充电桩咋弄", "充电桩服务"],
    ["新店铺要接电开电，报装咋走流程", "用电报装"],
    ["房子过户后电费户主想换成我", "用户信息变更"],
    ["电表想挪一下位置，怎么申请", "电表业务办理"],
    ["一开空调就跳闸，家里又没电了", "停电跳闸故障"],
    ["屋里灯老闪，一会亮一会暗，电不稳", "电压异常"],
    ["电表屏不亮，数字也不动了", "电表故障"],
    ["楼道电井那边线掉了，配电箱像是坏了", "线路设备故障"],
    ["插座摸着麻手，还闻到焦糊味", "用电安全隐患"],
    ["报过修了还没人联系，催一下工单进度", "故障抢修"],
    ["这事必须给个说法，我要投诉赔偿", "服务投诉与赔偿"],
    ["希望你们把服务流程改得方便点", "意见建议"],
    ["楼下商铺偷偷接电线，怀疑偷用电", "举报与风险反馈"],
    ["这个事你们系统分类里没有，需要新增场景人工确认", "新增场景待确认"],
    ["？？？", "无法识别"]
  ];
  for (const [content, level2] of cases) {
    const result = analyzeByRule(input(content));
    assert.equal(result.level2, level2, content);
  }
});

test("无法识别内容进入待定场景", () => {
  const result = analyzeByRule(input("在吗"));
  assert.equal(result.level1, "其他");
  assert.equal(result.level2, "无法识别");
  assert.equal(result.priority, "待定");
  assert.ok(result.confidence < 60);
});

test("每个场景包含口语化正例、反例和边界样本", () => {
  for (const rule of activeBusinessRules()) {
    assert.equal(rule.positiveExamples.length, 10, `${rule.level2}正例数量`);
    assert.equal(rule.negativeExamples.length, 10, `${rule.level2}反例数量`);
    assert.equal(rule.boundaryExamples.length, 5, `${rule.level2}边界样本数量`);
  }
});
