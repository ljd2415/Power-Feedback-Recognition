# 住户用电反馈数据分析系统

面向小区、电力运维和客服场景的本地数据分析工作台。系统支持导入住户用电反馈 Excel/CSV 数据，完成业务场景识别、反馈列表管理、可视化统计、分析报告生成和规则维护。

## 技术栈

- 前端：React、TypeScript、Vite、Recharts
- 后端：Node.js、Express、TypeScript
- 数据库：SQLite
- 文档导出：docx、pdfkit

## 安装依赖

```powershell
npm.cmd install
```

## 本地开发

启动前端和后端开发服务：

```powershell
npm.cmd run dev
```

默认访问地址：

```text
http://localhost:5173
```

也可以使用生产入口启动本地网站：

```powershell
npm.cmd run build
npm.cmd start
```

生产入口默认访问：

```text
http://127.0.0.1:3001
```

Windows 用户也可以双击 `start-website.bat` 启动本地网站。

## 构建

```powershell
npm.cmd run build
```

## 测试

```powershell
npm.cmd test
```

当前测试集中可能存在历史断言需要同步维护：部分业务规则样本数量已变化，但旧测试仍按固定数量断言。

## 环境变量

复制 `.env.example` 为 `.env`，再按实际环境填写。

```powershell
Copy-Item .env.example .env
```

支持的变量：

```text
PORT
OPENAI_BASE_URL
OPENAI_API_KEY
OPENAI_MODEL
AI_CONCURRENCY
```

如果未配置 `OPENAI_API_KEY`，系统会使用本地规则进行确定性分析。

## 数据与隐私

- 本地 SQLite 数据库默认位于 `data/power-feedback.db`。
- `.env`、数据库、日志、构建产物、报告文件和依赖目录不会提交到 Git。
- 上传代码前请确认 `.env.example` 不包含真实密钥。

