# TramMetroRoute

电瓶车 + 地铁联合通勤导航 Agent MVP。

当前版本已经从“纯规则规划页”升级成“Agent 编排 + 规划工具”结构，并支持“高德真实数据优先，mock 自动兜底”：

- Agent 先理解通勤任务
- Agent 调用 `resolve_intent`
- Agent 调用 `plan_commute`
- 返回自然语言结论、执行轨迹、推荐方案和候选方案

## 当前能力

- 支持结构化输入：起点、终点、偏好
- 支持自然语言输入：例如“从大学城西门到港口商务区，尽量少换乘”
- 支持两段式交互：先自动识别起终点，用户确认后再执行 Agent
- 支持 Agent 执行轨迹展示
- 支持两种运行模式：
  - 远程 Agent：接 OpenAI-compatible 大模型接口
  - 本地 Fallback Agent：未配置模型时自动启用
- 支持高德真实数据：地理编码、骑行路径、步行路径、站点周边 POI 搜索
- 保留原有联合通勤规划器作为兜底：高德未配置或失败时自动回退

## 项目结构

```text
TramMetroRoute
├── public
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── src
│   ├── config.js
│   ├── data/mockNetwork.js
│   ├── server.js
│   └── services
│       ├── agent.js
│       ├── intent.js
│       └── planner.js
└── package.json
```

## 快速启动

```bash
cd /Users/happy/Documents/workspace_tec/TramMetroRoute
npm start
```

打开 `http://localhost:3060`。

## Agent 接入方式

默认情况下，项目会优先读取项目根目录的 `.env`。如果没有找到有效配置，则使用本地 Fallback Agent。

当前项目已经兼容两种远程 Agent：

- `Anthropic-compatible`
- `OpenAI-compatible`

如果你要手动配置真实 Agent，可以在启动前设置：

```bash
export AGENT_API_KEY="your_api_key"
export AGENT_BASE_URL="https://your-endpoint"
export AGENT_MODEL="your-model-name"
export AGENT_PROVIDER="anthropic"
npm start
```

如果你要启用高德真实数据，请额外配置：

```bash
export AMAP_WEB_SERVICE_KEY="your_amap_web_service_key"
npm start
```

兼容的变量别名：

- `LLM_API_KEY`
- `LLM_BASE_URL`
- `LLM_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_MODEL`

说明：

- `Anthropic-compatible` 会走 `/v1/messages + tools`
- `OpenAI-compatible` 会走 `/chat/completions + tools`
- 未配置成功时，会自动降级到本地 Agent，不会把页面跑挂

## API

### 健康检查

`GET /api/health`

返回服务状态、当前 Agent 模式和规划器模式。

### 原始规划接口

`POST /api/plan`

适合直接拿候选路线结果，不包含 Agent 执行信息。

### Agent 规划接口

`POST /api/agent-plan`

### 意图识别接口

`POST /api/resolve-intent`

用于从用户的通勤任务中先识别起点、终点和偏好模式，前端确认后再调用 Agent。

请求示例：

```json
{
  "query": "从大学城西门到港口商务区，尽量少换乘，可以多骑几分钟电瓶车。",
  "origin": "大学城西门",
  "destination": "港口商务区",
  "preference": "多骑几分钟，少换乘"
}
```

返回内容包括：

- `agent.mode`
- `agent.message`
- `agent.steps`
- `planning.summary`
- `planning.plans`

## 数据说明

- 已配置 `AMAP_WEB_SERVICE_KEY` 时：
  - 起终点地址解析来自高德地理编码
  - 骑行和步行时长来自高德真实路径规划
  - 地铁候选站、进站口、停车点来自站点周边真实 POI 搜索
- 未配置高德 key，或高德接口失败时：
  - 自动回退到 [`mockNetwork.js`](./src/data/mockNetwork.js) 的模拟路网
  - 接口返回里会显式标记 `dataSourceLabel` 和 `fallbackReason`

## 当前限制

- 高德 Web 服务接口能提供真实路径和周边 POI，但不直接提供“官方闸机级最优进站口”数据
- 当前进站口和停车点是基于真实 POI 搜索做近似匹配，不是地铁官方内部导航数据

## 下一步建议

- 接高德路径规划替换 mock 路网
- 接高德地铁站/出入口数据
- 接真实非机动车停车点 POI
- 把天气、拥堵、停车容量纳入 Agent 决策
