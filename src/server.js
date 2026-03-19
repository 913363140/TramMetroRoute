import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./loadEnv.js";
import { runPlanningAgent, getAgentStatus } from "./services/agent.js";
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

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(port, () => {
  console.log(`TramMetroRoute server running at http://localhost:${port}`);
});
