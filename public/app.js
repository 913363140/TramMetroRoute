const form = document.querySelector("#plannerForm");
const resultEl = document.querySelector("#result");
const queryField = document.querySelector("#queryField");
const originField = document.querySelector("#originField");
const destinationField = document.querySelector("#destinationField");
const preferenceField = document.querySelector("#preferenceField");
const intentStatus = document.querySelector("#intentStatus");
const intentBadge = document.querySelector("#intentBadge");
const detectButton = document.querySelector("#detectButton");
const editButton = document.querySelector("#editButton");
const confirmButton = document.querySelector("#confirmButton");
const submitButton = document.querySelector("#submitButton");
const INTENT_CACHE_KEY = "trammetroroute.intent-cache.v1";
const PLAN_CACHE_KEY = "trammetroroute.plan-cache.v2";
const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
let runtimeConfigPromise = null;
let amapLoaderPromise = null;
let mapCardId = 0;
let loadingTimerId = null;

const state = {
  recognized: false,
  confirmed: false,
  editable: false,
  detectTimer: null,
  lastResolvedQuery: ""
};

function createCard(title, className = "card") {
  const card = document.createElement("article");
  card.className = className;
  const heading = document.createElement("h3");
  heading.textContent = title;
  card.appendChild(heading);
  return card;
}

function createMeta(text) {
  const div = document.createElement("div");
  div.className = "meta";
  div.textContent = text;
  return div;
}

function createRichMeta(html) {
  const div = document.createElement("div");
  div.className = "meta";
  div.innerHTML = html;
  return div;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function stopLoadingTimer() {
  if (loadingTimerId) {
    window.clearInterval(loadingTimerId);
    loadingTimerId = null;
  }
}

function createLoadingCard() {
  const loading = createCard("AI 正在思考 🤖🧠", "card loading-card");
  loading.appendChild(
    createMeta("正在分析骑行、换乘、步行和进站口，马上为你生成最优通勤方案 🗺️⚡")
  );

  const timer = document.createElement("div");
  timer.className = "loading-timer";
  timer.textContent = "已思考 00:00";
  loading.appendChild(timer);

  const startedAt = Date.now();
  stopLoadingTimer();
  loadingTimerId = window.setInterval(() => {
    timer.textContent = `已思考 ${formatElapsed(Date.now() - startedAt)}`;
  }, 1000);

  return loading;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let inCodeBlock = false;
  let codeLines = [];
  let paragraphLines = [];
  let listType = "";
  let listItems = [];

  function flushParagraph() {
    if (paragraphLines.length === 0) {
      return;
    }
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join("<br>"))}</p>`);
    paragraphLines = [];
  }

  function flushList() {
    if (listItems.length === 0) {
      return;
    }
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(
      `<${tag}>${listItems
        .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
        .join("")}</${tag}>`
    );
    listItems = [];
    listType = "";
  }

  function flushCodeBlock() {
    if (!inCodeBlock) {
      return;
    }
    blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    inCodeBlock = false;
    codeLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      blocks.push(`<h${level + 2}>${renderInlineMarkdown(headingMatch[2])}</h${level + 2}>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(orderedMatch[1]);
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCodeBlock();

  return blocks.join("");
}

function createBadge(text, tone = "") {
  const span = document.createElement("span");
  span.className = `pill ${tone}`.trim();
  span.textContent = text;
  return span;
}

function normalizeQuery(query) {
  return String(query || "").trim().replace(/\s+/g, " ");
}

function readIntentCache() {
  try {
    const raw = window.localStorage.getItem(INTENT_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeIntentCache(data) {
  try {
    window.localStorage.setItem(INTENT_CACHE_KEY, JSON.stringify(data));
  } catch (error) {
    return;
  }
}

function readPlanCache() {
  try {
    const raw = window.localStorage.getItem(PLAN_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed?.key || !parsed?.data || !parsed?.savedAt) {
      return null;
    }
    if (Date.now() - Number(parsed.savedAt) > PLAN_CACHE_TTL_MS) {
      window.localStorage.removeItem(PLAN_CACHE_KEY);
      return null;
    }
    if (containsLegacyParkingLotPlan(parsed.data)) {
      window.localStorage.removeItem(PLAN_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function writePlanCache(key, data) {
  try {
    window.localStorage.setItem(
      PLAN_CACHE_KEY,
      JSON.stringify({
        key,
        data,
        savedAt: Date.now()
      })
    );
  } catch (error) {
    return;
  }
}

function buildPlanCacheKey(payload) {
  return JSON.stringify({
    origin: String(payload?.origin || "").trim(),
    destination: String(payload?.destination || "").trim(),
    preference: String(payload?.preference || "").trim()
  });
}

function containsLegacyParkingLotPlan(data) {
  const plans = Array.isArray(data?.planning?.plans) ? data.planning.plans : [];
  return plans.some((plan) => {
    const parkingZone = String(plan?.parkingZone || "");
    const ebikeRideMinutes = Number(plan?.ebikeRideMinutes || 0);
    if (ebikeRideMinutes <= 0) {
      return false;
    }
    return /停车场/.test(parkingZone) && !/非机动车|电动车|电瓶车|自行车/.test(parkingZone);
  });
}

async function fetchRuntimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch("/api/runtime-config")
      .then((response) => response.json())
      .catch(() => ({}));
  }
  return runtimeConfigPromise;
}

async function loadAmapSdk() {
  if (window.AMap) {
    return window.AMap;
  }

  if (!amapLoaderPromise) {
    amapLoaderPromise = fetchRuntimeConfig().then((config) => {
      const key = config?.amapJsApiKey || "";
      if (!key) {
        throw new Error("当前未配置浏览器端高德地图 Key，请补充 AMAP_JS_API_KEY。");
      }

      return new Promise((resolve, reject) => {
        if (window.AMap) {
          resolve(window.AMap);
          return;
        }

        const existing = document.querySelector('script[data-amap-sdk="true"]');
        if (existing) {
          existing.addEventListener("load", () => resolve(window.AMap));
          existing.addEventListener("error", () => {
            reject(new Error("高德地图 JS SDK 加载失败，当前 key 可能仅支持 Web 服务。"));
          });
          return;
        }

        const script = document.createElement("script");
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(
          key
        )}&plugin=AMap.Riding,AMap.Transfer,AMap.Walking,AMap.ToolBar`;
        script.async = true;
        script.dataset.amapSdk = "true";
        script.onload = () => {
          if (window.AMap) {
            resolve(window.AMap);
            return;
          }
          reject(new Error("高德地图 JS SDK 已加载，但浏览器端地图对象不可用。"));
        };
        script.onerror = () => {
          reject(new Error("高德地图 JS SDK 加载失败，当前 key 可能仅支持 Web 服务。"));
        };
        document.head.appendChild(script);
      });
    });
  }

  return amapLoaderPromise;
}

function updateIntentBadge(text, tone = "neutral") {
  if (!intentBadge) {
    return;
  }
  intentBadge.textContent = text;
  intentBadge.dataset.tone = tone;
}

function setIntentStatus(text, tone = "neutral") {
  intentStatus.textContent = text;
  intentStatus.dataset.tone = tone;
}

function syncReadonlyState() {
  originField.readOnly = !state.editable;
  destinationField.readOnly = !state.editable;
  editButton.textContent = state.editable ? "锁定编辑" : "手动修改";
  submitButton.disabled = !state.confirmed;
}

function resetConfirmation(message, tone = "neutral") {
  state.confirmed = false;
  submitButton.disabled = true;
  setIntentStatus(message, tone);
  updateIntentBadge(state.recognized ? "待确认" : "待识别", state.recognized ? "ready" : "neutral");
}

function applyModeToPreference(mode, preferLongerRide) {
  if (preferLongerRide) {
    preferenceField.value = "多骑几分钟，少换乘";
    return;
  }

  if (mode === "less_transfer") {
    preferenceField.value = "少换乘";
    return;
  }
  if (mode === "faster") {
    preferenceField.value = "最快";
    return;
  }
  if (mode === "less_walk") {
    preferenceField.value = "少走路";
    return;
  }
  preferenceField.value = "balanced";
}

function persistIntentCache({ recognized = state.recognized, confirmed = state.confirmed } = {}) {
  const query = normalizeQuery(queryField.value);
  if (!query) {
    return;
  }

  writeIntentCache({
    query,
    origin: originField.value.trim(),
    destination: destinationField.value.trim(),
    preference: preferenceField.value,
    recognized,
    confirmed
  });
}

function applyResolvedIntent(data, options = {}) {
  const fromCache = Boolean(options.fromCache);
  originField.value = data.origin || "";
  destinationField.value = data.destination || "";
  if (data.preference) {
    preferenceField.value = data.preference;
  } else {
    applyModeToPreference(data.mode, data.preferLongerRide);
  }

  state.recognized = Boolean(data.origin && data.destination);
  state.confirmed = Boolean(options.confirmed);
  state.editable = false;
  state.lastResolvedQuery = normalizeQuery(queryField.value);
  syncReadonlyState();

  if (state.confirmed) {
    setIntentStatus(
      options.statusText ||
        `已确认：从“${originField.value.trim()}”到“${destinationField.value.trim()}”。现在可以执行 Agent 分析方案。`,
      "confirmed"
    );
    updateIntentBadge(fromCache ? "已记住" : "已确认", "confirmed");
  } else {
    setIntentStatus(
      options.statusText ||
        `已识别起点“${originField.value.trim()}”和终点“${destinationField.value.trim()}”。请确认；如需修改，可先点“手动修改”。`,
      fromCache ? "confirmed" : "ready"
    );
    updateIntentBadge(fromCache ? "已复用" : "待确认", fromCache ? "confirmed" : "ready");
  }

  persistIntentCache();
}

function restoreCachedIntent(query, auto = false) {
  const normalized = normalizeQuery(query);
  const cached = readIntentCache();
  if (
    !normalized ||
    !cached ||
    cached.query !== normalized ||
    !cached.origin ||
    !cached.destination
  ) {
    return false;
  }

  applyResolvedIntent(
    {
      origin: cached.origin,
      destination: cached.destination,
      preference: cached.preference
    },
    {
      fromCache: true,
      confirmed: Boolean(cached.confirmed),
      statusText: cached.confirmed
        ? `通勤任务未变化，已直接沿用上次确认结果：从“${cached.origin}”到“${cached.destination}”。`
        : auto
          ? `通勤任务未变化，已复用上次识别结果：从“${cached.origin}”到“${cached.destination}”。请确认后继续。`
          : `已复用上次识别结果：从“${cached.origin}”到“${cached.destination}”。`
    }
  );
  return true;
}

function renderAgentPanel(data) {
  const panel = createCard("Agent 结论", "card agent-card");
  const markdown = document.createElement("div");
  markdown.className = "agent-markdown";
  markdown.innerHTML = markdownToHtml(data.agent.message);
  panel.appendChild(markdown);

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  badgeRow.appendChild(createBadge(`模式：${data.agent.mode}`));
  badgeRow.appendChild(createBadge(`模型：${data.agent.model}`));
  badgeRow.appendChild(
    createBadge(`数据：${data.planning.summary.dataSourceLabel || data.planning.summary.dataSource || "未知"}`)
  );
  panel.appendChild(badgeRow);

  if (data.planning.summary.approximation) {
    panel.appendChild(createMeta(`说明：${data.planning.summary.approximation}`));
  }
  if (data.planning.summary.fallbackReason) {
    panel.appendChild(createMeta(`回退原因：${data.planning.summary.fallbackReason}`));
  }

  const trace = document.createElement("div");
  trace.className = "trace";
  data.agent.steps.forEach((step, index) => {
    const item = document.createElement("div");
    item.className = "trace-item";
    const summaryHtml =
      step.name === "agent_response"
        ? `<div class="trace-summary agent-markdown">${markdownToHtml(step.summary)}</div>`
        : `<div class="trace-summary">${escapeHtml(step.summary)}</div>`;
    item.innerHTML = `
      <div class="trace-index">${index + 1}</div>
      <div>
        <div class="trace-name">${escapeHtml(step.name)}</div>
        ${summaryHtml}
      </div>
    `;
    trace.appendChild(item);
  });
  panel.appendChild(trace);
  return panel;
}

function renderLineGuide(lineGuide = []) {
  if (!Array.isArray(lineGuide) || lineGuide.length === 0) {
    return null;
  }

  const wrap = document.createElement("div");
  wrap.className = "line-guide";

  const title = document.createElement("div");
  title.className = "line-guide-title";
  title.textContent = "地铁线路说明";
  wrap.appendChild(title);

  const list = document.createElement("div");
  list.className = "line-guide-list";
  lineGuide.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "line-guide-item";
    row.innerHTML = `
      <span class="line-guide-index">${index + 1}</span>
      <span>${escapeHtml(item.description || `${item.lineName || "地铁线路"}：${item.from || ""} -> ${item.to || ""}`)}</span>
    `;
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function createMapCard(plan) {
  const card = createCard("高德地图方案", "card map-card");
  card.appendChild(
    createMeta("当前页直接使用高德官方地图容器和官方路线面板渲染方案。")
  );

  const status = document.createElement("div");
  status.className = "map-status";
  status.textContent = "正在载入地图...";
  card.appendChild(status);

  const shell = document.createElement("div");
  shell.className = "map-shell";

  const canvas = document.createElement("div");
  canvas.className = "map-canvas";
  canvas.id = `planMap-${Date.now()}-${mapCardId += 1}`;
  shell.appendChild(canvas);

  const panel = document.createElement("div");
  panel.className = "map-route-panel";
  panel.id = `planRoutePanel-${Date.now()}-${mapCardId += 1}`;
  panel.textContent = "高德官方路线面板加载中...";
  shell.appendChild(panel);

  card.appendChild(shell);

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  badgeRow.appendChild(createBadge(`小区出口 ${plan.originGate || "待匹配"}`));
  badgeRow.appendChild(createBadge(`停车点 ${plan.parkingZone}`));
  badgeRow.appendChild(createBadge(`进站口 ${plan.originEntrance}`));
  card.appendChild(badgeRow);

  return { card, canvas, panel, status };
}

function getSegmentStyle(mode) {
  if (mode === "bike") {
    return {
      strokeColor: "#0f766e",
      strokeWeight: 6,
      strokeOpacity: 0.95,
      strokeStyle: "solid"
    };
  }
  if (mode === "walk") {
    return {
      strokeColor: "#d97706",
      strokeWeight: 5,
      strokeOpacity: 0.9,
      strokeStyle: "dashed"
    };
  }
  return {
    strokeColor: "#166534",
    strokeWeight: 7,
    strokeOpacity: 0.92,
    strokeStyle: "solid"
  };
}

function getPlanMarker(plan, key) {
  return (plan?.mapData?.markers || []).find((marker) => marker.key === key) || null;
}

function loadAmapPlugins(AMap, plugins = []) {
  return new Promise((resolve, reject) => {
    AMap.plugin(plugins, () => resolve());
    window.setTimeout(() => {
      reject(new Error("高德路线插件加载超时。"));
    }, 8000);
  });
}

function serviceSearch(service, origin, destination) {
  return new Promise((resolve, reject) => {
    service.search(origin, destination, (status, result) => {
      if (status === "complete") {
        resolve(result);
        return;
      }
      reject(new Error(result?.info || "高德路线服务未返回可用结果。"));
    });
  });
}

async function renderManualMapRoute(AMap, map, plan) {
  const overlays = [];

  (plan.mapData?.segments || []).forEach((segment) => {
    if (!Array.isArray(segment.points) || segment.points.length < 2) {
      return;
    }
    const polyline = new AMap.Polyline({
      path: segment.points,
      ...getSegmentStyle(segment.mode)
    });
    map.add(polyline);
    overlays.push(polyline);
  });

  (plan.mapData?.markers || []).forEach((marker) => {
    if (!Array.isArray(marker.position) || marker.position.length !== 2) {
      return;
    }
    const overlay = new AMap.Marker({
      position: marker.position,
      title: marker.detail || marker.name,
      label: {
        direction: "top",
        content: `<div class="map-label map-label-${escapeHtml(marker.tone || "default")}">${escapeHtml(marker.name)}</div>`
      }
    });
    map.add(overlay);
    overlays.push(overlay);
  });

  if (overlays.length > 0) {
    map.setFitView(overlays, false, [64, 64, 64, 64], 14);
  }
}

async function renderMapRoute(plan, canvas, panel, status) {
  if (plan.dataSource !== "amap" || !plan.mapData) {
    status.textContent = "当前方案不是高德真实数据，暂不渲染地图。";
    if (panel) {
      panel.textContent = "当前方案不是高德真实数据，暂无官方路线面板。";
    }
    return;
  }

  try {
    const AMap = await loadAmapSdk();
    status.textContent = "地图已就绪，正在调用高德路线服务绘制真实方案...";
    if (panel) {
      panel.innerHTML = "";
    }

    const map = new AMap.Map(canvas, {
      viewMode: "3D",
      resizeEnable: true,
      zoom: 13,
      mapStyle: "amap://styles/normal",
      showLabel: true,
      features: ["bg", "road", "building", "point"]
    });

    const origin = getPlanMarker(plan, "origin");
    const originEntrance = getPlanMarker(plan, "originEntrance");
    const destination = getPlanMarker(plan, "destination");
    const destinationEntrance = getPlanMarker(plan, "destinationEntrance");
    const city = plan.routeCity || "";

    await loadAmapPlugins(AMap, ["AMap.Riding", "AMap.Transfer", "AMap.Walking", "AMap.ToolBar"]);
    map.addControl(new AMap.ToolBar({ position: "RB" }));

    let renderedBySdk = false;

    if (origin && destination) {
      if (plan.ebikeRideMinutes > 0 && originEntrance) {
        const riding = new AMap.Riding({
          map,
          panel: null,
          hideMarkers: false,
          isOutline: true,
          outlineColor: "#0f766e",
          strokeColor: "#0f766e",
          strokeWeight: 6,
          autoFitView: false
        });
        await serviceSearch(riding, origin.position, originEntrance.position);
        renderedBySdk = true;
      }

      const transferOrigin =
        plan.ebikeRideMinutes > 0 && originEntrance ? originEntrance.position : origin.position;
      const transfer = new AMap.Transfer({
        map,
        panel,
        city,
        policy: AMap.TransferPolicy.LEAST_TRANSFER,
        nightflag: false,
        hideMarkers: false,
        autoFitView: false
      });
      await serviceSearch(transfer, transferOrigin, destination.position);
      renderedBySdk = true;

    }

    if (!renderedBySdk) {
      await renderManualMapRoute(AMap, map, plan);
      status.textContent = "高德路线服务暂不可用，已回退为点位与路线草图渲染。";
      if (panel) {
        panel.textContent = "高德官方路线面板暂不可用，当前显示的是兜底草图。";
      }
      return;
    }

    map.setFitView();
    status.textContent = "已通过高德 SDK 渲染真实路线。";
  } catch (error) {
    console.error("[TramMetroRoute][AMapRenderError]", error);
    try {
      const AMap = await loadAmapSdk();
      const map = new AMap.Map(canvas, {
        viewMode: "3D",
        resizeEnable: true,
        zoom: 13,
        mapStyle: "amap://styles/normal",
        showLabel: true,
        features: ["bg", "road", "building", "point"]
      });
      await renderManualMapRoute(AMap, map, plan);
      status.textContent = `高德路线服务渲染失败，已回退为草图模式：${error.message || "未知错误"}`;
      if (panel) {
        panel.textContent = `高德官方路线面板加载失败：${error.message || "未知错误"}。当前显示的是兜底草图。`;
      }
    } catch (fallbackError) {
      console.error("[TramMetroRoute][AMapRenderFallbackError]", fallbackError);
      status.textContent = error.message || fallbackError.message || "高德地图渲染失败。";
      if (panel) {
        panel.textContent = `高德地图与路线面板都加载失败：${
          error.message || fallbackError.message || "未知错误"
        }`;
      }
    }
  }
}

function renderPlan(plan, index) {
  const card = createCard(index === 0 ? "推荐方案" : `候选方案 ${index + 1}`);
  card.appendChild(createMeta(`路线：${plan.routeStations.join(" -> ")}`));
  card.appendChild(
    createMeta(
      `电瓶车 ${plan.ebikeRideMinutes} 分钟 | 地铁 ${plan.subwayMinutes} 分钟 | 步行 ${plan.walkMinutes} 分钟`
    )
  );
  card.appendChild(
    createMeta(
      `总耗时 ${plan.totalMinutes} 分钟 | 换乘 ${plan.transfers} 次 | 综合评分 ${plan.score}`
    )
  );
  if (plan.originGate) {
    card.appendChild(createMeta(`推荐小区出口：${plan.originGate}`));
  }
  card.appendChild(createMeta(`停车点：${plan.parkingZone}`));
  card.appendChild(createMeta(`最佳进站口：${plan.originEntrance}`));
  card.appendChild(createMeta(`目标出站口：${plan.destinationEntrance}`));

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  badgeRow.appendChild(createBadge(`起始站 ${plan.originStation}`));
  badgeRow.appendChild(createBadge(`目标站 ${plan.destinationStation}`));
  if (index === 0) {
    badgeRow.appendChild(createBadge("Agent 推荐", "accent"));
  }
  if (plan.dataSource === "amap") {
    badgeRow.appendChild(createBadge("高德真实数据"));
  } else if (plan.dataSource) {
    badgeRow.appendChild(createBadge("Mock 兜底", "warn"));
  }
  card.appendChild(badgeRow);

  const lineGuide = renderLineGuide(plan.lineGuide);
  if (lineGuide) {
    card.appendChild(lineGuide);
  }

  if (Array.isArray(plan.notes)) {
    plan.notes.forEach((note) => {
      card.appendChild(createMeta(`说明：${note}`));
    });
  }
  return card;
}

function renderError(message) {
  resultEl.innerHTML = "";
  const card = createCard("请求失败");
  card.appendChild(createMeta(message));
  resultEl.appendChild(card);
}

function renderPlanningResult(data) {
  resultEl.innerHTML = "";
  resultEl.appendChild(renderAgentPanel(data));
  const recommendedPlan = data?.planning?.plans?.[0];
  if (recommendedPlan) {
    const mapPanel = createMapCard(recommendedPlan);
    resultEl.appendChild(mapPanel.card);
    renderMapRoute(recommendedPlan, mapPanel.canvas, mapPanel.panel, mapPanel.status);
  }
  data.planning.plans.forEach((plan, index) => {
    resultEl.appendChild(renderPlan(plan, index));
  });
}

async function fetchResolveIntent(payload) {
  const response = await fetch("/api/resolve-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "识别失败");
  }
  return data;
}

async function fetchAgentPlan(payload) {
  const response = await fetch("/api/agent-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "接口异常");
  }
  return data;
}

async function detectIntent(auto = false, forceRefresh = false) {
  const query = queryField.value.trim();
  if (!query) {
    state.recognized = false;
    state.lastResolvedQuery = "";
    resetConfirmation("先输入通勤任务，再识别起点和终点。", "warn");
    originField.value = "";
    destinationField.value = "";
    updateIntentBadge("待识别", "neutral");
    return;
  }

  if (!forceRefresh && restoreCachedIntent(query, auto)) {
    return;
  }

  setIntentStatus(
    auto ? "正在自动识别起点和终点..." : "正在识别起点和终点...",
    "neutral"
  );
  updateIntentBadge("识别中", "neutral");

  try {
    const data = await fetchResolveIntent({
      query,
      preference: preferenceField.value
    });

    if (!data.recognized) {
      state.recognized = false;
      state.lastResolvedQuery = "";
      resetConfirmation("暂时没能识别出完整起终点，请手动补充或修改通勤任务。", "warn");
      return;
    }

    applyResolvedIntent(data, { confirmed: false });
  } catch (error) {
    state.recognized = false;
    state.lastResolvedQuery = "";
    resetConfirmation(error.message || "识别失败，请稍后重试。", "error");
  }
}

function scheduleAutoDetect() {
  clearTimeout(state.detectTimer);
  state.detectTimer = setTimeout(() => {
    detectIntent(true);
  }, 500);
}

detectButton.addEventListener("click", async () => {
  await detectIntent(false, true);
});

editButton.addEventListener("click", () => {
  state.editable = !state.editable;
  syncReadonlyState();
  if (state.editable) {
    resetConfirmation("你可以手动修改起点和终点，修改后请重新确认。", "warn");
  } else if (!state.confirmed) {
    setIntentStatus("已锁定编辑。请确认当前起点和终点后再执行 Agent。", "neutral");
  }
});

confirmButton.addEventListener("click", () => {
  const origin = originField.value.trim();
  const destination = destinationField.value.trim();
  if (!origin || !destination) {
    resetConfirmation("起点和终点不能为空，请先识别或手动补充。", "error");
    return;
  }

  state.recognized = true;
  state.confirmed = true;
  state.editable = false;
  state.lastResolvedQuery = normalizeQuery(queryField.value);
  syncReadonlyState();
  setIntentStatus(`已确认：从“${origin}”到“${destination}”。现在可以执行 Agent 分析方案。`, "confirmed");
  updateIntentBadge("已确认", "confirmed");
  persistIntentCache({ recognized: true, confirmed: true });
});

queryField.addEventListener("input", () => {
  const normalized = normalizeQuery(queryField.value);
  if (normalized && restoreCachedIntent(normalized, true)) {
    return;
  }

  state.recognized = false;
  state.lastResolvedQuery = "";
  resetConfirmation("通勤任务已变更，系统会重新识别起点和终点。", "warn");
  scheduleAutoDetect();
});

originField.addEventListener("input", () => {
  if (state.editable) {
    resetConfirmation("起点已修改，请重新确认起终点。", "warn");
    persistIntentCache({ recognized: true, confirmed: false });
  }
});

destinationField.addEventListener("input", () => {
  if (state.editable) {
    resetConfirmation("终点已修改，请重新确认起终点。", "warn");
    persistIntentCache({ recognized: true, confirmed: false });
  }
});

preferenceField.addEventListener("change", () => {
  if (state.confirmed) {
    setIntentStatus("偏好已更新，不影响已确认的起终点，可以直接执行 Agent。", "confirmed");
    updateIntentBadge("已确认", "confirmed");
  } else if (state.recognized) {
    setIntentStatus("偏好已更新，起终点保持不变，无需重新识别。", "ready");
    updateIntentBadge("待确认", "ready");
  }
  persistIntentCache();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.confirmed) {
    resetConfirmation("请先确认识别出的起点和终点，再执行 Agent 分析。", "error");
    return;
  }

  const payload = {
    query: queryField.value.trim(),
    origin: originField.value.trim(),
    destination: destinationField.value.trim(),
    preference: preferenceField.value
  };
  const planCacheKey = buildPlanCacheKey(payload);
  const cachedPlan = readPlanCache();

  if (cachedPlan?.key === planCacheKey) {
    setIntentStatus("通勤任务和偏好未变化，已直接复用最近一次方案。", "confirmed");
    renderPlanningResult(cachedPlan.data);
    return;
  }

  resultEl.innerHTML = "";
  const loading = createLoadingCard();
  resultEl.appendChild(loading);

  try {
    const data = await fetchAgentPlan(payload);
    stopLoadingTimer();
    writePlanCache(planCacheKey, data);
    renderPlanningResult(data);
  } catch (error) {
    stopLoadingTimer();
    renderError(error.message || "网络异常，请检查服务是否启动");
  }
});

syncReadonlyState();
updateIntentBadge("待识别", "neutral");
detectIntent(true);
