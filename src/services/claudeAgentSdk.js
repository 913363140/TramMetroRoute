import { query } from "@anthropic-ai/claude-agent-sdk";

let sdkDisabledReason = "";

function buildSdkEnv(config) {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: config.apiKey || process.env.ANTHROPIC_API_KEY || "",
    ANTHROPIC_AUTH_TOKEN:
      process.env.ANTHROPIC_AUTH_TOKEN || config.apiKey || process.env.ANTHROPIC_API_KEY || "",
    ANTHROPIC_BASE_URL: config.baseUrl || process.env.ANTHROPIC_BASE_URL || ""
  };
}

function createAbortSignal(timeoutMs) {
  let timeoutId = null;
  return {
    timeoutMs,
    arm(onTimeout) {
      timeoutId = setTimeout(onTimeout, timeoutMs);
    },
    dispose() {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
  };
}

async function collectQueryResult(stream) {
  let finalResult = null;
  for await (const message of stream) {
    if (message?.type === "result") {
      finalResult = message;
    }
  }
  return finalResult;
}

export async function runClaudeStructuredQuery({
  prompt,
  systemPrompt,
  schema,
  model,
  cwd,
  timeoutMs,
  env,
  maxTurns = 1
}) {
  const timer = createAbortSignal(timeoutMs);
  const stream = query({
    prompt,
    options: {
      cwd,
      env,
      model,
      maxTurns,
      tools: [],
      permissionMode: "plan",
      systemPrompt,
      outputFormat: {
        type: "json_schema",
        schema
      }
    }
  });

  try {
    const result = await Promise.race([
      collectQueryResult(stream),
      new Promise((_, reject) => {
        timer.arm(() => {
          try {
            stream.close();
          } catch (error) {
            // Ignore close failures on timeout.
          }
          reject(new Error("request-timeout"));
        });
      })
    ]);

    if (!result) {
      throw new Error("Claude Agent SDK returned no result message");
    }

    if (result.is_error) {
      throw new Error(
        Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.join("; ")
          : result.subtype || "claude-agent-sdk-error"
      );
    }

    return result.structured_output;
  } finally {
    timer.dispose();
  }
}

export async function runClaudeTextQuery({
  prompt,
  systemPrompt,
  model,
  cwd,
  timeoutMs,
  env,
  maxTurns = 1
}) {
  const timer = createAbortSignal(timeoutMs);
  const stream = query({
    prompt,
    options: {
      cwd,
      env,
      model,
      maxTurns,
      tools: [],
      permissionMode: "plan",
      systemPrompt
    }
  });

  try {
    const result = await Promise.race([
      collectQueryResult(stream),
      new Promise((_, reject) => {
        timer.arm(() => {
          try {
            stream.close();
          } catch (error) {
            // Ignore close failures on timeout.
          }
          reject(new Error("request-timeout"));
        });
      })
    ]);

    if (!result) {
      throw new Error("Claude Agent SDK returned no result message");
    }

    if (result.is_error) {
      throw new Error(
        Array.isArray(result.errors) && result.errors.length > 0
          ? result.errors.join("; ")
          : result.subtype || "claude-agent-sdk-error"
      );
    }

    return String(result.result || "").trim();
  } finally {
    timer.dispose();
  }
}

export function isClaudeAgentSdkCompatible(config) {
  const sdkOptIn = String(process.env.CLAUDE_AGENT_SDK_ENABLED || "").trim().toLowerCase();
  return Boolean(
    sdkOptIn === "true" &&
    !sdkDisabledReason &&
      config?.enabled &&
      config?.provider === "anthropic" &&
      config?.apiKey &&
      config?.model
  );
}

export function createClaudeSdkRuntime(config) {
  return {
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
    env: buildSdkEnv(config),
    model: config.model
  };
}

export function markClaudeAgentSdkUnavailable(error) {
  const message = String(error?.message || error || "");
  if (/Object not disposable/i.test(message) || /Node\.js v18\.12\.1/i.test(message)) {
    sdkDisabledReason = message || "claude-agent-sdk-runtime-incompatible";
  }
}

export function getClaudeAgentSdkStatus() {
  return {
    enabled: !sdkDisabledReason,
    disabledReason: sdkDisabledReason || ""
  };
}
