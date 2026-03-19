import { parseIntent } from "./intent.js";

const INTENT_CACHE_TTL_MS = Number(process.env.INTENT_CACHE_TTL_MS || 10 * 60 * 1000);
const intentCache = new Map();

const INTENT_SYSTEM_PROMPT = `
你是一个中文通勤任务识别助手。
请从用户输入中提取：
1. origin: 起点
2. destination: 终点
3. mode: balanced / less_transfer / faster / less_walk 之一
4. preferLongerRide: 是否接受多骑几分钟电瓶车来换更少换乘，true 或 false

规则：
- 必须理解口语表达，比如“我在A去B”“从A到B”“A去B上班”。
- 不要把“我在”“我要去”“帮我规划”这类语气词并入地点。
- 输出必须是 JSON，不要使用 markdown，不要解释。
- 如果某项无法确定，填空字符串或 false。
`.trim();

function nowIso() {
  return new Date().toISOString();
}

function logIntent(stage, detail = {}) {
  console.log(`[${nowIso()}] [intent-llm] ${stage} ${JSON.stringify(detail)}`);
}

function logIntentError(stage, detail = {}) {
  console.error(`[${nowIso()}] [intent-llm] ${stage} ${JSON.stringify(detail)}`);
}

function stripThinkingBlocks(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function truncate(value, max = 400) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}...<truncated>`;
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

function getIntentModelConfig() {
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
    timeoutMs: Number(process.env.INTENT_HTTP_TIMEOUT_MS || process.env.AGENT_HTTP_TIMEOUT_MS || 12000),
    enabled: Boolean(apiKey && model)
  };
}

function readIntentCache(key) {
  const cached = intentCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    intentCache.delete(key);
    return null;
  }
  return { ...cached.value };
}

function writeIntentCache(key, value) {
  intentCache.set(key, {
    expiresAt: Date.now() + INTENT_CACHE_TTL_MS,
    value: { ...value }
  });
  return { ...value };
}

function buildIntentCacheKey(input = {}) {
  return JSON.stringify({
    query: String(input.query || "").trim(),
    preference: String(input.preference || "").trim()
  });
}

function extractJsonObject(text) {
  const cleaned = stripThinkingBlocks(text);
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (innerError) {
      return null;
    }
  }
}

function normalizeMode(mode, input) {
  if (["balanced", "less_transfer", "faster", "less_walk"].includes(mode)) {
    return mode;
  }
  const normalized = parseIntent({
    origin: "",
    destination: "",
    preference: mode || input.preference || "",
    query: input.query || ""
  });
  return normalized.mode;
}

function normalizeIntentResult(raw, input, source) {
  const fallback = parseIntent(input);
  const origin = String(raw?.origin || "").trim();
  const destination = String(raw?.destination || "").trim();
  const mode = normalizeMode(String(raw?.mode || "").trim(), input);
  const preferLongerRide =
    typeof raw?.preferLongerRide === "boolean"
      ? raw.preferLongerRide
      : /多骑|骑久|ride more/.test(`${raw?.mode || ""} ${input.preference || ""} ${input.query || ""}`);

  const result = {
    origin: origin || fallback.origin,
    destination: destination || fallback.destination,
    mode: mode || fallback.mode,
    preferLongerRide,
    rawPreference: String(input.preference || "").trim(),
    query: String(input.query || "").trim(),
    recognized: Boolean((origin || fallback.origin) && (destination || fallback.destination)),
    source
  };

  return result;
}

async function requestOpenAIIntent(input, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request-timeout"), config.timeoutMs);
  const startedAt = Date.now();
  const url = `${config.baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: INTENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              query: input.query || "",
              preference: input.preference || ""
            })
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    logIntent("openai.finish", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      bodyPreview: truncate(rawText)
    });

    if (!response.ok) {
      throw new Error(`intent llm failed: ${response.status} ${rawText}`);
    }

    const data = JSON.parse(rawText);
    const content = data?.choices?.[0]?.message?.content || "";
    return extractJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAnthropicIntent(input, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request-timeout"), config.timeoutMs);
  const startedAt = Date.now();
  const url = `${config.baseUrl}/v1/messages`;

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
        max_tokens: 300,
        temperature: 0,
        system: INTENT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query: input.query || "",
                  preference: input.preference || ""
                })
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    logIntent("anthropic.finish", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
      bodyPreview: truncate(rawText)
    });

    if (!response.ok) {
      throw new Error(`intent llm failed: ${response.status} ${rawText}`);
    }

    const data = JSON.parse(rawText);
    const content = Array.isArray(data?.content) ? data.content : [];
    const text = content
      .filter((item) => item?.type === "text")
      .map((item) => item.text || "")
      .join("");
    return extractJsonObject(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestIntentWithModel(input, config) {
  logIntent("request.start", {
    provider: config.provider,
    model: config.model,
    timeoutMs: config.timeoutMs,
    query: input.query || ""
  });

  if (config.provider === "anthropic") {
    return requestAnthropicIntent(input, config);
  }
  return requestOpenAIIntent(input, config);
}

export async function resolveIntent(input) {
  const cacheKey = buildIntentCacheKey(input);
  const cached = readIntentCache(cacheKey);
  if (cached) {
    return cached;
  }

  const config = getIntentModelConfig();
  if (!config.enabled) {
    return writeIntentCache(cacheKey, {
      ...parseIntent(input),
      recognized: Boolean(parseIntent(input).origin && parseIntent(input).destination),
      source: "rule-fallback"
    });
  }

  try {
    const raw = await requestIntentWithModel(input, config);
    const normalized = normalizeIntentResult(raw, input, "llm");
    return writeIntentCache(cacheKey, normalized);
  } catch (error) {
    logIntentError("request.error", {
      provider: config.provider,
      model: config.model,
      message: error?.message || String(error)
    });
    const fallback = parseIntent(input);
    return writeIntentCache(cacheKey, {
      ...fallback,
      recognized: Boolean(fallback.origin && fallback.destination),
      source: "rule-fallback"
    });
  }
}
