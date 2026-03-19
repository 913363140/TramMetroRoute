export const LINES = {
  green: ["river_park", "city_square", "central_hub", "tech_park", "east_lake"],
  blue: ["north_gate", "museum", "central_hub", "south_station", "harbor"]
};

export const STATIONS = {
  river_park: { id: "river_park", name: "River Park", x: 1, y: 6, lines: ["green"] },
  city_square: { id: "city_square", name: "City Square", x: 3, y: 6, lines: ["green"] },
  central_hub: { id: "central_hub", name: "Central Hub", x: 5, y: 5, lines: ["green", "blue"] },
  tech_park: { id: "tech_park", name: "Tech Park", x: 7, y: 5, lines: ["green"] },
  east_lake: { id: "east_lake", name: "East Lake", x: 9, y: 5, lines: ["green"] },
  north_gate: { id: "north_gate", name: "North Gate", x: 5, y: 8, lines: ["blue"] },
  museum: { id: "museum", name: "Museum", x: 5, y: 6.5, lines: ["blue"] },
  south_station: { id: "south_station", name: "South Station", x: 5, y: 2.5, lines: ["blue"] },
  harbor: { id: "harbor", name: "Harbor", x: 5, y: 1, lines: ["blue"] }
};

export const ENTRANCES = [
  { id: "rp_west", stationId: "river_park", name: "A-West Gate", x: 0.8, y: 6, serves: ["green_backward"] },
  { id: "rp_east", stationId: "river_park", name: "B-East Gate", x: 1.2, y: 6, serves: ["green_forward"] },
  { id: "cs_west", stationId: "city_square", name: "A-West Gate", x: 2.8, y: 6, serves: ["green_backward"] },
  { id: "cs_east", stationId: "city_square", name: "D-East Gate", x: 3.2, y: 6, serves: ["green_forward"] },
  {
    id: "ch_north",
    stationId: "central_hub",
    name: "A-North Transfer Gate",
    x: 5,
    y: 5.2,
    serves: ["green_backward", "blue_backward"]
  },
  {
    id: "ch_south",
    stationId: "central_hub",
    name: "D-South Transfer Gate",
    x: 5,
    y: 4.8,
    serves: ["green_forward", "blue_forward"]
  },
  { id: "tp_west", stationId: "tech_park", name: "A-West Gate", x: 6.8, y: 5, serves: ["green_backward"] },
  { id: "tp_east", stationId: "tech_park", name: "B-East Gate", x: 7.2, y: 5, serves: ["green_forward"] },
  { id: "el_west", stationId: "east_lake", name: "A-West Gate", x: 8.8, y: 5, serves: ["green_backward"] },
  { id: "el_east", stationId: "east_lake", name: "B-East Gate", x: 9.2, y: 5, serves: ["green_forward"] },
  { id: "ng_north", stationId: "north_gate", name: "A-North Gate", x: 5, y: 8.2, serves: ["blue_backward"] },
  { id: "ng_south", stationId: "north_gate", name: "D-South Gate", x: 5, y: 7.8, serves: ["blue_forward"] },
  { id: "mu_north", stationId: "museum", name: "A-North Gate", x: 5, y: 6.7, serves: ["blue_backward"] },
  { id: "mu_south", stationId: "museum", name: "D-South Gate", x: 5, y: 6.3, serves: ["blue_forward"] },
  {
    id: "ss_north",
    stationId: "south_station",
    name: "A-North Gate",
    x: 5,
    y: 2.7,
    serves: ["blue_backward"]
  },
  {
    id: "ss_south",
    stationId: "south_station",
    name: "D-South Gate",
    x: 5,
    y: 2.3,
    serves: ["blue_forward"]
  },
  { id: "hb_north", stationId: "harbor", name: "A-North Gate", x: 5, y: 1.2, serves: ["blue_backward"] },
  { id: "hb_south", stationId: "harbor", name: "D-South Gate", x: 5, y: 0.8, serves: ["blue_forward"] }
];

export const PARKING_ZONES = [
  { id: "p_rp_1", stationId: "river_park", entranceId: "rp_east", name: "Riverside E-bike Lot", walkMin: 1.2 },
  { id: "p_cs_1", stationId: "city_square", entranceId: "cs_east", name: "City Square Parking Area", walkMin: 1.5 },
  { id: "p_ch_1", stationId: "central_hub", entranceId: "ch_south", name: "Central South E-bike Deck", walkMin: 1.8 },
  { id: "p_tp_1", stationId: "tech_park", entranceId: "tp_west", name: "Tech Park P2 Lot", walkMin: 1.1 },
  { id: "p_el_1", stationId: "east_lake", entranceId: "el_west", name: "East Lake Side Parking", walkMin: 1.4 },
  { id: "p_ng_1", stationId: "north_gate", entranceId: "ng_south", name: "North Gate Bike Hub", walkMin: 1.6 },
  { id: "p_mu_1", stationId: "museum", entranceId: "mu_south", name: "Museum Underground Bike Lot", walkMin: 1.3 },
  { id: "p_ss_1", stationId: "south_station", entranceId: "ss_north", name: "South Station East Lot", walkMin: 1.7 },
  { id: "p_hb_1", stationId: "harbor", entranceId: "hb_north", name: "Harbor Plaza Bike Parking", walkMin: 1.2 }
];

export const PLACE_HINTS = [
  { key: "科技园", x: 7.5, y: 5.5 },
  { key: "tech", x: 7.6, y: 5.4 },
  { key: "软件园", x: 7.2, y: 5.6 },
  { key: "大学城", x: 1.2, y: 6.3 },
  { key: "university", x: 1.2, y: 6.4 },
  { key: "市中心", x: 4.8, y: 5.5 },
  { key: "center", x: 4.9, y: 5.4 },
  { key: "南站", x: 5.4, y: 2.1 },
  { key: "south", x: 5.4, y: 2.1 },
  { key: "港口", x: 5.2, y: 1.1 },
  { key: "harbor", x: 5.1, y: 1.1 }
];
