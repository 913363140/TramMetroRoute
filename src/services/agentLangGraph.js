import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { parseIntent } from "./intent.js";
import { resolveIntent as resolveIntentWithModel } from "./intentResolver.js";
import { buildCommutePlan } from "./planner.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_HTTP_TIMEOUT_MS || 15000);

const AgentGraphState = Annotation.Root({
  input: Annotation(),
  config: Annotation(),
  intent: Annotation(),
  planning: Annotation(),
  finalMessage: Annotation(),
  mode: Annotation(),
  provider: Annotation(),
  model: Annotation(),
  fallbackReason: Annotation(),
  steps: Annotation({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
});

function nowIso() {
  return new Date().toISOString();
}

function makeTraceId() {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(value, max = 600) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...<truncated>`;
}

function redactSecret(value) {
  const input = String(value || "");
  if (!input) {
    return "";
  }
  if (input.length <= 8) {
    return `${input.slice(0, 2)}***`;
  }
  return `${input.slice(0, 4)}***${input.slice(-4)}`;
}

function stripThinkingBlocks(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function detectProvider(baseUrl) {
  const explicit =
    process.env.AGENT_PROVIDER ||
    process.env.LLM_PROVIDER ||
    process.env.MODEL_PROVIDER ||
    "";
  if (explicit) {
    return explicit;
  }

  if (/anthropic/i.test(baseUrl || "")) {
    return "anthropic";
  }
  return "openai-compatible";
}

function getAgentConfig() {
  const baseUrl =
    process.env.AGENT_BASE_URL ||
    process.env.LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.openai.com/v1";

  const provider = detectProvider(baseUrl);
  const apiKey =
    process.env.AGENT_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    "";
  const model =
    process.env.AGENT_MODEL ||
    process.env.LLM_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    process.env.CLAUDE_DEFAULT_MODEL ||
    "";

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    provider,
    model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    executionMode: process.env.AGENT_EXECUTION_MODE || "remote",
    enabled: Boolean(apiKey && model)
  };
}

function logAgent(traceId, stage, detail = {}) {
  console.log(`[${nowIso()}] [agent-graph] [${traceId}] ${stage} ${JSON.stringify(detail)}`);
}

function logAgentError(traceId, stage, detail = {}) {
  console.error(`[${nowIso()}] [agent-graph] [${traceId}] ${stage} ${JSON.stringify(detail)}`);
}

function summarizeIntent(intent) {
  return `识别起点为“${intent.origin || "未识别"}”，终点为“${
    intent.destination || "未识别"
  }”，偏好模式为 ${intent.mode}。`;
}

function summarizePlanResult(result) {
  const recommended = result?.summary?.recommended;
  if (!recommended) {
    return "规划器没有找到可用的联合通勤方案。";
  }
  return `共生成 ${result.plans.length} 个候选方案，推荐从 ${recommended.originStation} 出发，预计 ${recommended.totalMinutes} 分钟，换乘 ${recommended.transfers} 次。`;
}

function buildFastSummary(planning) {
  const recommended = planning?.summary?.recommended;
  if (!recommended) {
    return "## 推荐结果\n\n暂时没有找到合适的电瓶车 + 地铁联合通勤方案。";
  }

  const lineGuide = Array.isArray(recommended.lineGuide)
    ? recommended.lineGuide.map((item) => `- ${item.description}`).join("\n")
    : "";

  const parts = [
    "## 推荐结果",
    "",
    `这次优先推荐 **${recommended.originStation} -> ${recommended.destinationStation}**，主要因为 **换乘 ${recommended.transfers} 次**，更符合“少换乘”的目标。`,
    "",
    "## 通勤步骤",
    "",
    `1. 从 **${recommended.originGate || recommended.origin}** 出发，骑电瓶车约 **${recommended.ebikeRideMinutes} 分钟**。`,
    `2. 把车停在 **${recommended.parkingZone}**，直接步行进站。`,
    `3. 从 **${recommended.originEntrance}** 进站，前往 **${recommended.destinationEntrance}** 出站。`,
    `4. 全程约 **${recommended.totalMinutes} 分钟**，其中地铁约 **${recommended.subwayMinutes} 分钟**，步行约 **${recommended.walkMinutes} 分钟**。`
  ];

  if (lineGuide) {
    parts.push("", "## 地铁线路说明", "", lineGuide);
  }

  return parts.join("\n");
}

function buildSummaryPrompt(intent, planning) {
  return [
    "请基于以下通勤规划结果，用中文输出简洁、可信的 Markdown 结论。",
    "要求：",
    "1. 不要编造工具结果之外的信息。",
    "2. 先说明为什么推荐第一条方案。",
    "3. 用 1-4 步写清楚通勤步骤。",
    "4. 明确写出停车点、进站口、总耗时、换乘次数。",
    "5. 如果有地铁线路说明，单独列一个小节。",
    "",
    "用户意图：",
    JSON.stringify(intent, null, 2),
    "",
    "规划结果：",
    JSON.stringify(planning, null, 2)
  ].join("\n");
}

async function requestOpenAISummary(config, prompt, traceId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request-timeout"), config.timeoutMs);
  const url = `${config.baseUrl}/chat/completions`;
  const startedAt = Date.now();

  logAgent(traceId, "openai.summary.start", {
    url,
    model: config.model,
    timeoutMs: config.timeoutMs,
    apiKey: redactSecret(config.apiKey)
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你是中文通勤规划助手。请严格基于给定规划结果输出答案，不要编造。"
          },
          {
            role: "user",
            content: prompt
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    logAgent(traceId, "openai.summary.finish", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      bodyPreview: truncate(rawText)
    });

    if (!response.ok) {
      throw new Error(`LLM summary failed: ${response.status} ${rawText}`);
    }

    const data = JSON.parse(rawText);
    return stripThinkingBlocks(data?.choices?.[0]?.message?.content || "");
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAnthropicSummary(config, prompt, traceId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request-timeout"), config.timeoutMs);
  const url = `${config.baseUrl}/v1/messages`;
  const startedAt = Date.now();

  logAgent(traceId, "anthropic.summary.start", {
    url,
    model: config.model,
    timeoutMs: config.timeoutMs,
    apiKey: redactSecret(config.apiKey)
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1200,
        temperature: 0.2,
        system: "你是中文通勤规划助手。请严格基于给定规划结果输出答案，不要编造。",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    logAgent(traceId, "anthropic.summary.finish", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      bodyPreview: truncate(rawText)
    });

    if (!response.ok) {
      throw new Error(`LLM summary failed: ${response.status} ${rawText}`);
    }

    const data = JSON.parse(rawText);
    const content = Array.isArray(data?.content) ? data.content : [];
    const text = content
      .filter((item) => item?.type === "text")
      .map((item) => item.text || "")
      .join("");
    return stripThinkingBlocks(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeWithModel(config, intent, planning, traceId) {
  const prompt = buildSummaryPrompt(intent, planning);
  if (config.provider === "anthropic") {
    return requestAnthropicSummary(config, prompt, traceId);
  }
  return requestOpenAISummary(config, prompt, traceId);
}

function routeFromStart(state) {
  if (state?.input?.origin && state?.input?.destination) {
    return "use_confirmed_intent";
  }
  return "resolve_intent";
}

function routeAfterPlanning(state) {
  if (state?.config?.executionMode === "remote" && state?.config?.enabled) {
    return "remote_summary";
  }
  return "local_summary";
}

async function useConfirmedIntentNode(state) {
  const intent = parseIntent(state.input);
  return {
    intent,
    steps: [
      {
        type: "tool",
        name: "resolve_intent",
        summary: `${summarizeIntent(intent)} 已使用已确认的起点和终点。`
      }
    ]
  };
}

async function resolveIntentNode(state) {
  const intent = await resolveIntentWithModel(state.input);
  return {
    intent,
    steps: [
      {
        type: "tool",
        name: "resolve_intent",
        summary: `${summarizeIntent(intent)} 来源：${intent.source || "llm"}。`
      }
    ]
  };
}

async function planCommuteNode(state) {
  const intent = state.intent || parseIntent(state.input);
  const planning = await buildCommutePlan({
    query: state.input.query || "",
    origin: intent.origin || state.input.origin || "",
    destination: intent.destination || state.input.destination || "",
    preference: state.input.preference || ""
  });

  return {
    planning,
    steps: [
      {
        type: "tool",
        name: "plan_commute",
        summary: summarizePlanResult(planning)
      }
    ]
  };
}

async function remoteSummaryNode(state) {
  const traceId = state.config.traceId || makeTraceId();

  try {
    const finalMessage =
      (await summarizeWithModel(state.config, state.intent, state.planning, traceId)) ||
      buildFastSummary(state.planning);

    return {
      finalMessage,
      mode: "langgraph-agent",
      provider: state.config.provider,
      model: state.config.model,
      steps: [
        {
          type: "final",
          name: "agent_response",
          summary: finalMessage
        }
      ]
    };
  } catch (error) {
    const fallbackMessage = buildFastSummary(state.planning);
    logAgentError(traceId, "summary.remote_failed", {
      provider: state.config.provider,
      model: state.config.model,
      message: error?.message || String(error)
    });

    return {
      finalMessage: fallbackMessage,
      mode: "local-fallback",
      provider: "built-in",
      model: "rule-based-agent",
      fallbackReason: error?.message || "remote-summary-failed",
      steps: [
        {
          type: "system",
          name: "fallback",
          summary: `大模型总结失败，已回退到本地总结。原因：${error?.message || String(error)}`
        },
        {
          type: "final",
          name: "agent_response",
          summary: fallbackMessage
        }
      ]
    };
  }
}

async function localSummaryNode(state) {
  const finalMessage = buildFastSummary(state.planning);
  const steps = [];

  if (state.fallbackReason) {
    steps.push({
      type: "system",
      name: "fallback",
      summary: `外部 Agent 不可用，已切换到本地 Agent。原因：${state.fallbackReason}`
    });
  }

  steps.push({
    type: "final",
    name: "agent_response",
    summary: finalMessage
  });

  return {
    finalMessage,
    mode: state.fallbackReason ? "local-fallback" : "local-fast",
    provider: "built-in",
    model: "rule-based-agent",
    steps
  };
}

const agentWorkflow = new StateGraph(AgentGraphState)
  .addNode("use_confirmed_intent", useConfirmedIntentNode)
  .addNode("resolve_intent", resolveIntentNode)
  .addNode("plan_commute", planCommuteNode)
  .addNode("remote_summary", remoteSummaryNode)
  .addNode("local_summary", localSummaryNode)
  .addConditionalEdges(START, routeFromStart)
  .addEdge("use_confirmed_intent", "plan_commute")
  .addEdge("resolve_intent", "plan_commute")
  .addConditionalEdges("plan_commute", routeAfterPlanning)
  .addEdge("remote_summary", END)
  .addEdge("local_summary", END)
  .compile();

export async function runPlanningAgent(input) {
  const config = getAgentConfig();
  const traceId = makeTraceId();
  config.traceId = traceId;

  logAgent(traceId, "run.start", {
    provider: config.provider,
    model: config.model,
    enabled: config.enabled,
    executionMode: config.executionMode,
    timeoutMs: config.timeoutMs,
    origin: input.origin || "",
    destination: input.destination || "",
    query: input.query || ""
  });

  const state = await agentWorkflow.invoke({
    input,
    config,
    steps: []
  });

  logAgent(traceId, "run.finish", {
    mode: state.mode,
    provider: state.provider,
    model: state.model,
    hasPlanning: Boolean(state.planning?.summary?.recommended)
  });

  return {
    agent: {
      mode: state.mode || "local-fast",
      provider: state.provider || "built-in",
      model: state.model || "rule-based-agent",
      message: state.finalMessage || buildFastSummary(state.planning),
      steps: state.steps || []
    },
    planning: state.planning
  };
}

export function getAgentStatus() {
  const config = getAgentConfig();
  return {
    mode:
      config.executionMode === "remote" && config.enabled
        ? "remote-agent"
        : config.executionMode === "remote"
          ? "local-fallback"
          : "local-fast",
    provider:
      config.executionMode === "remote" && config.enabled
        ? config.provider
        : "built-in",
    model:
      config.executionMode === "remote" && config.enabled
        ? config.model || "rule-based-agent"
        : "rule-based-agent"
  };
}
