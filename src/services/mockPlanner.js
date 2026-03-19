import { SCORING_PRESETS, SEARCH_LIMITS, SPEED } from "../config.js";
import {
  ENTRANCES,
  LINES,
  PARKING_ZONES,
  PLACE_HINTS,
  STATIONS
} from "../data/mockNetwork.js";
import { parseIntent } from "./intent.js";

function round1(n) {
  return Math.round(n * 10) / 10;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function resolvePointByText(input, fallback) {
  const text = String(input || "").toLowerCase();
  const hint = PLACE_HINTS.find((item) => text.includes(item.key.toLowerCase()));
  if (hint) {
    return { x: hint.x, y: hint.y };
  }
  return fallback;
}

function buildGraph() {
  const edges = {};
  const addEdge = (from, to, line, minutes) => {
    if (!edges[from]) edges[from] = [];
    edges[from].push({ to, line, minutes });
  };

  const lineNames = Object.keys(LINES);
  for (const lineName of lineNames) {
    const stationList = LINES[lineName];
    for (let i = 0; i < stationList.length - 1; i += 1) {
      const a = stationList[i];
      const b = stationList[i + 1];
      addEdge(a, b, lineName, 4);
      addEdge(b, a, lineName, 4);
    }
  }
  return edges;
}

function findSubwayRoute(originStationId, destinationStationId) {
  if (originStationId === destinationStationId) {
    return {
      stations: [originStationId],
      subwayMinutes: 0,
      transfers: 0,
      firstLeg: null
    };
  }

  const graph = buildGraph();
  const queue = [
    {
      current: originStationId,
      stations: [originStationId],
      subwayMinutes: 0,
      transfers: 0,
      currentLine: null,
      firstLeg: null
    }
  ];
  const best = new Map();

  while (queue.length > 0) {
    queue.sort(
      (a, b) =>
        a.subwayMinutes + a.transfers * 8 - (b.subwayMinutes + b.transfers * 8)
    );
    const state = queue.shift();
    const stateKey = `${state.current}_${state.currentLine || "none"}`;
    const seenCost = best.get(stateKey);
    const nowCost = state.subwayMinutes + state.transfers * 8;
    if (seenCost !== undefined && seenCost <= nowCost) {
      continue;
    }
    best.set(stateKey, nowCost);

    if (state.current === destinationStationId) {
      return {
        stations: state.stations,
        subwayMinutes: state.subwayMinutes,
        transfers: state.transfers,
        firstLeg: state.firstLeg
      };
    }

    const nextEdges = graph[state.current] || [];
    for (const edge of nextEdges) {
      if (state.stations.includes(edge.to)) {
        continue;
      }
      const transferAdded =
        state.currentLine && state.currentLine !== edge.line ? 1 : 0;
      queue.push({
        current: edge.to,
        stations: [...state.stations, edge.to],
        subwayMinutes: state.subwayMinutes + edge.minutes,
        transfers: state.transfers + transferAdded,
        currentLine: edge.line,
        firstLeg: state.firstLeg || { from: state.current, to: edge.to, line: edge.line }
      });
    }
  }

  return null;
}

function getDirectionToken(firstLeg) {
  if (!firstLeg) return null;
  const lineStations = LINES[firstLeg.line] || [];
  const fromIndex = lineStations.indexOf(firstLeg.from);
  const toIndex = lineStations.indexOf(firstLeg.to);
  if (fromIndex === -1 || toIndex === -1) return null;
  return `${firstLeg.line}_${toIndex > fromIndex ? "forward" : "backward"}`;
}

function pickEntrance(stationId, directionToken, destinationPoint) {
  const entrances = ENTRANCES.filter((e) => e.stationId === stationId);
  if (entrances.length === 0) return null;

  if (directionToken) {
    const byDirection = entrances.find((e) => e.serves.includes(directionToken));
    if (byDirection) {
      return byDirection;
    }
  }

  let nearest = entrances[0];
  let bestDist = distance(entrances[0], destinationPoint);
  for (const entrance of entrances.slice(1)) {
    const currentDist = distance(entrance, destinationPoint);
    if (currentDist < bestDist) {
      nearest = entrance;
      bestDist = currentDist;
    }
  }
  return nearest;
}

function pickParking(stationId, entranceId) {
  const parkingList = PARKING_ZONES.filter((p) => p.stationId === stationId);
  if (parkingList.length === 0) {
    return null;
  }
  const exact = parkingList.find((p) => p.entranceId === entranceId);
  if (exact) {
    return exact;
  }
  return parkingList.reduce((best, current) =>
    current.walkMin < best.walkMin ? current : best
  );
}

function scorePlan(plan, mode, preferLongerRide) {
  const preset = SCORING_PRESETS[mode] || SCORING_PRESETS.balanced;
  let score =
    plan.subwayMinutes * preset.subwayPenalty +
    plan.ebikeRideMinutes * preset.ridePenalty +
    plan.walkMinutes * preset.walkPenalty +
    plan.transfers * preset.transferPenalty;

  if (preferLongerRide) {
    score -= Math.min(plan.ebikeRideMinutes, 10) * 0.3;
  }
  return round1(score);
}

function estimateWalk(stationExit, destinationPoint) {
  const km = distance(stationExit, destinationPoint);
  return round1(Math.max(1, km / SPEED.walkDistancePerMinute));
}

function rankStationsByAccess(point, mode = "origin") {
  const allStations = Object.values(STATIONS);
  const list = allStations.map((station) => {
    const dist = distance(point, station);
    const minutes =
      mode === "origin"
        ? round1(Math.max(2, dist / SPEED.ebikeDistancePerMinute))
        : round1(Math.max(1, dist / SPEED.walkDistancePerMinute));
    return { station, minutes };
  });
  list.sort((a, b) => a.minutes - b.minutes);
  return list;
}

export function buildMockCommutePlan(input) {
  const intent = parseIntent(input);
  const originPoint = resolvePointByText(intent.origin, { x: 2.5, y: 6.2 });
  const destinationPoint = resolvePointByText(intent.destination, { x: 5.3, y: 1.6 });

  const originCandidates = rankStationsByAccess(originPoint, "origin").slice(
    0,
    SEARCH_LIMITS.maxOriginStations
  );
  const destinationCandidates = rankStationsByAccess(destinationPoint, "destination").slice(
    0,
    SEARCH_LIMITS.maxDestinationStations
  );

  const plans = [];

  for (const originCandidate of originCandidates) {
    for (const destinationCandidate of destinationCandidates) {
      const route = findSubwayRoute(
        originCandidate.station.id,
        destinationCandidate.station.id
      );
      if (!route) {
        continue;
      }

      const directionToken = getDirectionToken(route.firstLeg);
      const originEntrance = pickEntrance(
        originCandidate.station.id,
        directionToken,
        destinationPoint
      );
      const destinationEntrance = pickEntrance(
        destinationCandidate.station.id,
        null,
        destinationPoint
      );
      const parking = pickParking(originCandidate.station.id, originEntrance?.id);

      const ebikeRideMinutes = originCandidate.minutes;
      const parkingWalkMinutes = parking?.walkMin || 2;
      const transferWalkMinutes = route.transfers * 4;
      const finalWalkMinutes = estimateWalk(
        destinationEntrance || destinationCandidate.station,
        destinationPoint
      );

      const walkMinutes = round1(parkingWalkMinutes + transferWalkMinutes + finalWalkMinutes);
      const totalMinutes = round1(ebikeRideMinutes + route.subwayMinutes + walkMinutes);

      const plan = {
        mode: intent.mode,
        origin: intent.origin,
        destination: intent.destination,
        routeStations: route.stations.map((id) => STATIONS[id].name),
        originStation: originCandidate.station.name,
        destinationStation: destinationCandidate.station.name,
        originEntrance: originEntrance?.name || "Default Entrance",
        destinationEntrance: destinationEntrance?.name || "Default Exit",
        parkingZone: parking?.name || "Nearest public e-bike area",
        ebikeRideMinutes,
        subwayMinutes: route.subwayMinutes,
        walkMinutes,
        transfers: route.transfers,
        totalMinutes,
        dataSource: "mock"
      };

      plan.score = scorePlan(plan, intent.mode, intent.preferLongerRide);
      plans.push(plan);
    }
  }

  plans.sort((a, b) => a.score - b.score);
  const topPlans = plans.slice(0, SEARCH_LIMITS.topPlans);

  return {
    summary: {
      mode: intent.mode,
      candidatePlans: plans.length,
      recommended: topPlans[0] || null,
      dataSource: "mock",
      dataSourceLabel: "Mock 模拟路网"
    },
    plans: topPlans
  };
}
