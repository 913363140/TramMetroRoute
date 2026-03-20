import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./loadEnv.js";
import { runPlanningAgent, getAgentStatus } from "./services/agent.js";
import { buildFastSummary } from "./services/agentLangGraph.js";
import { parseIntent } from "./services/intent.js";
import { resolveIntent } from "./services/intentResolver.js";
import { buildCommutePlan, getPlannerStatus } from "./services/planner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const port = process.env.PORT || 3060;

function logServer(stage, detail = {}) {
  console.log(
    `[${new Date().toISOString()}] [server] ${stage} ${JSON.stringify(detail)}`
  );
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function startJsonStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
}

function sendStreamEvent(res, type, data = {}) {
  res.write(`${JSON.stringify({ type, ...data })}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildPlanningPreviewPayload(planning) {
  return {
    summary: {
      mode: planning?.summary?.mode || "balanced",
      candidatePlans: planning?.summary?.candidatePlans || 0,
      recommended: planning?.summary?.recommended
        ? {
            originStation: planning.summary.recommended.originStation,
            destinationStation: planning.summary.recommended.destinationStation,
            totalMinutes: planning.summary.recommended.totalMinutes,
            transfers: planning.summary.recommended.transfers,
            originEntrance: planning.summary.recommended.originEntrance
          }
        : null
    }
  };
}

async function streamMarkdownSummary(res, message) {
  const sections = String(message || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  let accumulated = "";

  for (const section of sections) {
    accumulated = accumulated ? `${accumulated}\n\n${section}` : section;
    sendStreamEvent(res, "agent.message.delta", {
      delta: section,
      accumulated
    });
    await sleep(90);
  }
}

async function serveStaticFile(res, relativePath, contentType = "text/html; charset=utf-8") {
  try {
    const filePath = path.join(publicDir, relativePath);
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (error) {
    sendJson(res, 404, { error: "Not Found" });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    await serveStaticFile(res, "index.html");
    return;
  }

  if (req.method === "GET" && url.pathname === "/styles.css") {
    await serveStaticFile(res, "styles.css", "text/css; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/app.js") {
    await serveStaticFile(res, "app.js", "text/javascript; charset=utf-8");
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "TramMetroRoute Planner API",
      agent: getAgentStatus(),
      planner: getPlannerStatus()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runtime-config") {
    sendJson(res, 200, {
      amapJsApiKey:
        process.env.AMAP_JS_API_KEY ||
        process.env.AMAP_WEB_JS_KEY ||
        process.env.AMAP_WEB_SERVICE_KEY ||
        ""
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/plan") {
    try {
      const body = await readBody(req);
      const intent = parseIntent(body);
      if (!intent.origin || !intent.destination) {
        sendJson(res, 400, { error: "origin and destination are required" });
        return;
      }
      const result = await buildCommutePlan({
        query: body.query || "",
        origin: body.origin,
        destination: body.destination,
        preference: body.preference || "balanced"
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: "invalid JSON payload" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resolve-intent") {
    try {
      const body = await readBody(req);
      const intent = await resolveIntent(body);
      sendJson(res, 200, {
        origin: intent.origin,
        destination: intent.destination,
        mode: intent.mode,
        preferLongerRide: intent.preferLongerRide,
        query: intent.query,
        recognized: Boolean(intent.origin && intent.destination),
        source: intent.source || "llm"
      });
    } catch (error) {
      sendJson(res, 400, { error: "invalid JSON payload" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-plan") {
    const startedAt = Date.now();
    try {
      const body = await readBody(req);
      const intent = parseIntent(body);
      logServer("agent-plan.request", {
        origin: intent.origin,
        destination: intent.destination,
        mode: intent.mode,
        query: body.query || ""
      });
      if (!intent.origin || !intent.destination) {
        sendJson(res, 400, {
          error: "please provide origin and destination, or write a query like 从A到B"
        });
        return;
      }
      const result = await runPlanningAgent({
        query: body.query || "",
        origin: body.origin || "",
        destination: body.destination || "",
        preference: body.preference || ""
      });
      logServer("agent-plan.response", {
        durationMs: Date.now() - startedAt,
        agentMode: result?.agent?.mode,
        provider: result?.agent?.provider,
        model: result?.agent?.model
      });
      sendJson(res, 200, result);
    } catch (error) {
      logServer("agent-plan.error", {
        durationMs: Date.now() - startedAt,
        message: error?.message || String(error)
      });
      sendJson(res, 400, { error: "invalid JSON payload" });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-plan-stream") {
    const startedAt = Date.now();
    try {
      const body = await readBody(req);
      const intent = parseIntent(body);
      if (!intent.origin || !intent.destination) {
        sendJson(res, 400, {
          error: "please provide origin and destination, or write a query like 从A到B"
        });
        return;
      }

      startJsonStream(res);
      sendStreamEvent(res, "status", {
        stage: "started",
        message: "任务已接收，开始分析通勤方案。"
      });
      sendStreamEvent(res, "step", {
        name: "resolve_intent",
        summary: `识别起点为“${intent.origin}”，终点为“${intent.destination}”，已使用确认后的起终点。`
      });
      sendStreamEvent(res, "status", {
        stage: "planning",
        message: "正在请求高德真实路线、站点出口和停车点。"
      });

      const planning = await buildCommutePlan({
        query: body.query || "",
        origin: body.origin || "",
        destination: body.destination || "",
        preference: body.preference || ""
      });

      sendStreamEvent(res, "planning.ready", {
        planningPreview: buildPlanningPreviewPayload(planning)
      });
      sendStreamEvent(res, "step", {
        name: "plan_commute",
        summary:
          planning?.summary?.recommended
            ? `已生成 ${planning.plans.length} 个候选方案，正在整理推荐结论。`
            : "规划器暂时没有找到可用方案，正在整理说明。"
      });

      const message = buildFastSummary(planning);
      sendStreamEvent(res, "status", {
        stage: "summarizing",
        message: "路线已生成，正在整理 Agent 结论。"
      });
      await streamMarkdownSummary(res, message);

      const result = {
        agent: {
          mode: "local-fast",
          provider: "built-in",
          model: "rule-based-agent",
          message,
          steps: [
            {
              type: "tool",
              name: "resolve_intent",
              summary: `识别起点为“${intent.origin}”，终点为“${intent.destination}”，已使用确认后的起终点。`
            },
            {
              type: "tool",
              name: "plan_commute",
              summary:
                planning?.summary?.recommended
                  ? `共生成 ${planning.plans.length} 个候选方案，推荐从 ${planning.summary.recommended.originStation} 出发，预计 ${planning.summary.recommended.totalMinutes} 分钟，换乘 ${planning.summary.recommended.transfers} 次。`
                  : "规划器没有找到可用的联合通勤方案。"
            },
            {
              type: "final",
              name: "agent_response",
              summary: message
            }
          ]
        },
        planning
      };

      sendStreamEvent(res, "done", {
        result,
        durationMs: Date.now() - startedAt
      });
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 400, { error: "invalid JSON payload" });
        return;
      }
      sendStreamEvent(res, "error", {
        message: error?.message || "流式规划失败"
      });
      res.end();
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(port, () => {
  console.log(`TramMetroRoute server running at http://localhost:${port}`);
});
