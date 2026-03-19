export const SCORING_PRESETS = {
  balanced: {
    transferPenalty: 8,
    walkPenalty: 1.2,
    ridePenalty: 1,
    subwayPenalty: 1
  },
  less_transfer: {
    transferPenalty: 14,
    walkPenalty: 1.1,
    ridePenalty: 1,
    subwayPenalty: 1
  },
  faster: {
    transferPenalty: 6,
    walkPenalty: 1,
    ridePenalty: 1,
    subwayPenalty: 0.95
  },
  less_walk: {
    transferPenalty: 7,
    walkPenalty: 1.6,
    ridePenalty: 1,
    subwayPenalty: 1
  }
};

export const SEARCH_LIMITS = {
  maxOriginStations: 3,
  maxDestinationStations: 3,
  topPlans: 3
};

export const SPEED = {
  ebikeDistancePerMinute: 0.45,
  walkDistancePerMinute: 0.08
};
