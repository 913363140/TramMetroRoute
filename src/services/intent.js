const PREFERENCE_KEYWORDS = [
  { type: "less_transfer", keys: ["少换乘", "不换乘", "换乘少"] },
  { type: "faster", keys: ["最快", "赶时间", "快一点", "省时"] },
  { type: "less_walk", keys: ["少走路", "不想走", "腿疼", "步行少"] }
];

function extractTripFromQuery(queryText) {
  const normalized = String(queryText || "").trim();
  if (!normalized) {
    return { origin: "", destination: "" };
  }

  const fromToMatch = normalized.match(/从(.+?)(?:出发)?到(.+?)(?:[，。,；;]|$)/);
  if (fromToMatch) {
    return {
      origin: fromToMatch[1].trim(),
      destination: fromToMatch[2].trim()
    };
  }

  const goToMatch = normalized.match(/(.+?)去(.+?)(?:[，。,；;]|$)/);
  if (goToMatch) {
    return {
      origin: goToMatch[1].trim(),
      destination: goToMatch[2].trim()
    };
  }

  return { origin: "", destination: "" };
}

export function parseIntent({ origin, destination, preference = "", query = "" }) {
  const trip = extractTripFromQuery(query);
  const mergedText = [query, preference].filter(Boolean).join(" ").toLowerCase();
  const preferenceText = String(mergedText || preference || "").toLowerCase();
  const detected = PREFERENCE_KEYWORDS.find((item) =>
    item.keys.some((key) => preferenceText.includes(key))
  );

  let mode = "balanced";
  if (detected) {
    mode = detected.type;
  }

  return {
    origin: String(origin || trip.origin || "").trim(),
    destination: String(destination || trip.destination || "").trim(),
    mode,
    preferLongerRide: /多骑|骑久|ride more/.test(preferenceText),
    rawPreference: preferenceText,
    query: String(query || "").trim()
  };
}
