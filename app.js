const [Map, MapView, FeatureLayer, GraphicsLayer, Graphic, Home, ScaleBar, reactiveUtils, Basemap, TileLayer] = await $arcgis.import([
  "@arcgis/core/Map.js",
  "@arcgis/core/views/MapView.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/layers/GraphicsLayer.js",
  "@arcgis/core/Graphic.js",
  "@arcgis/core/widgets/Home.js",
  "@arcgis/core/widgets/ScaleBar.js",
  "@arcgis/core/core/reactiveUtils.js",
  "@arcgis/core/Basemap.js",
  "@arcgis/core/layers/TileLayer.js"
]);

const WELL_LAYER_URL = "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0";
const CA_CITY_LAYER_URL = "https://gis.conservation.ca.gov/server/rest/services/Base/Base_BOECities/FeatureServer/0";

const WELL_FIELDS = [
  "OBJECTID", "Place", "API", "LeaseName", "WellNumber", "WellDesignation",
  "WellStatus", "WellTypeLabel", "OperatorName", "FieldName", "AreaName",
  "District", "CountyName", "SpudDate", "Latitude", "Longitude"
];

const KNOWN_STATUS_VALUES = ["Active", "Idle", "New", "Plugged", "PluggedOnly", "Canceled"];
const ALL_STATUS_CATEGORIES = ["Active", "Idle", "Permitted", "Plugged", "Canceled", "Other"];
const CLUSTER_MAX_SCALE = 30000;
const REST_CHUNK_SIZE = 1000;

const el = (id) => document.getElementById(id);
const dataState = el("data-state");
const dataStateText = el("data-state-text");
const zoomModeTitle = el("zoom-mode-title");
const zoomModeCopy = el("zoom-mode-copy");
const statusFilterContainer = el("status-filters");
const filterSummary = el("filter-summary");
const resetFiltersButton = el("reset-filters");
const searchInput = el("well-search");
const searchResults = el("search-results");
const clearSearchButton = el("clear-search");
const operatorInput = el("operator-filter");
const operatorResults = el("operator-results");
const operatorSummary = el("operator-summary");
const clearOperatorButton = el("clear-operator");
const commandForm = el("command-form");
const commandInput = el("command-input");
const commandSubmit = el("command-submit");
const commandResponse = el("command-response");

const selectedStatuses = new Set(ALL_STATUS_CATEGORIES);
let selectedOperator = null;
let selectedLocation = null;
let searchTimer = null;
let searchRequestId = 0;
let operatorTimer = null;
let operatorRequestId = 0;
let lastZoomMode = null;
let wellsLayerView = null;
let selectionHandle = null;
let selectionGraphic = null;

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function safeText(value, fallback = "—") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function roundMarker(color, size = 10, outlineColor = [255, 255, 255, 0.98], outlineWidth = 1.4) {
  return {
    type: "simple-marker",
    style: "circle",
    size,
    color,
    outline: { color: outlineColor, width: outlineWidth }
  };
}

function symbolForStatus(status) {
  if (status === "Active") return roundMarker([33, 150, 83, 0.98], 10);
  if (status === "Idle") return roundMarker([245, 158, 11, 0.98], 10);
  if (status === "New") return roundMarker([37, 99, 235, 0.98], 10);
  if (status === "Plugged" || status === "PluggedOnly") return roundMarker([107, 114, 128, 0.96], 9);
  if (status === "Canceled") return roundMarker([220, 38, 38, 0.98], 9);
  return roundMarker([75, 85, 99, 0.92], 9);
}

const statusRenderer = {
  type: "unique-value",
  field: "WellStatus",
  defaultSymbol: symbolForStatus(null),
  defaultLabel: "Unknown / other",
  uniqueValueInfos: [
    { value: "Active", label: "Active", symbol: symbolForStatus("Active") },
    { value: "Idle", label: "Idle", symbol: symbolForStatus("Idle") },
    { value: "New", label: "Permitted", symbol: symbolForStatus("New") },
    { value: "Plugged", label: "Plugged", symbol: symbolForStatus("Plugged") },
    { value: "PluggedOnly", label: "Plugged", symbol: symbolForStatus("PluggedOnly") },
    { value: "Canceled", label: "Canceled", symbol: symbolForStatus("Canceled") }
  ]
};

const wellPopup = {
  title: "{LeaseName} — Well {WellNumber}",
  content: [{
    type: "fields",
    fieldInfos: [
      { fieldName: "WellStatus", label: "Current status" },
      { fieldName: "SpudDate", label: "Drilled / spud date" },
      { fieldName: "API", label: "API number" },
      { fieldName: "WellTypeLabel", label: "Well type" },
      { fieldName: "OperatorName", label: "Operator" },
      { fieldName: "FieldName", label: "Field" },
      { fieldName: "AreaName", label: "Area" },
      { fieldName: "District", label: "CalGEM district" },
      { fieldName: "CountyName", label: "County" },
      { fieldName: "Place", label: "Place" },
      { fieldName: "Latitude", label: "Latitude", format: { places: 5, digitSeparator: false } },
      { fieldName: "Longitude", label: "Longitude", format: { places: 5, digitSeparator: false } }
    ]
  }],
  outFields: WELL_FIELDS
};

const clusterConfig = {
  type: "cluster",
  maxScale: CLUSTER_MAX_SCALE,
  clusterRadius: "46px",
  clusterMinSize: "20px",
  clusterMaxSize: "40px",
  symbol: roundMarker([35, 49, 66, 0.88], 24),
  labelingInfo: [{
    deconflictionStrategy: "none",
    labelExpressionInfo: { expression: "Text($feature.cluster_count, '#,###')" },
    symbol: {
      type: "text",
      color: "white",
      font: { family: "Arial", size: 10, weight: "bold" },
      haloSize: 0
    },
    labelPlacement: "center-center"
  }],
  popupTemplate: {
    title: "{cluster_count} wells at this map scale",
    content: "Zoom in to separate nearby wells and inspect individual records."
  }
};

const wells = new FeatureLayer({
  url: WELL_LAYER_URL,
  title: "CalGEM WellSTAR Wells",
  outFields: WELL_FIELDS,
  renderer: statusRenderer,
  popupTemplate: wellPopup,
  featureReduction: clusterConfig,
  minScale: 0,
  labelsVisible: false
});

const commandResultsLayer = new GraphicsLayer({
  title: "Map Assistant Results",
  visible: false,
  listMode: "hide"
});

const queryLayer = new FeatureLayer({
  url: WELL_LAYER_URL,
  outFields: WELL_FIELDS,
  popupTemplate: wellPopup
});

const cityLayer = new FeatureLayer({
  url: CA_CITY_LAYER_URL,
  outFields: ["CITY", "COUNTY"],
  visible: false
});

const streetBasemap = new Basemap({
  title: "Detailed Streets",
  baseLayers: [new TileLayer({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
    opacity: 0.92
  })]
});

const map = new Map({ basemap: streetBasemap, layers: [wells, commandResultsLayer] });
const view = new MapView({
  container: "viewDiv",
  map,
  center: [-119.45, 36.65],
  zoom: 5.8,
  constraints: { minZoom: 4, maxZoom: 20, snapToZoom: true },
  popup: { dockEnabled: false, collapseEnabled: false },
  highlightOptions: {
    color: [0, 122, 255, 1],
    fillOpacity: 0,
    haloColor: [0, 122, 255, 1],
    haloOpacity: 1
  }
});

view.ui.add(new Home({ view }), "top-left");
view.ui.add(new ScaleBar({ view, unit: "dual" }), "bottom-right");

function buildStatusExpression(statuses = selectedStatuses) {
  if (statuses.size === 0) return "1=0";
  if (statuses.size === ALL_STATUS_CATEGORIES.length) return "1=1";

  const clauses = [];
  if (statuses.has("Active")) clauses.push("WellStatus = 'Active'");
  if (statuses.has("Idle")) clauses.push("WellStatus = 'Idle'");
  if (statuses.has("Permitted")) clauses.push("WellStatus = 'New'");
  if (statuses.has("Plugged")) clauses.push("WellStatus IN ('Plugged', 'PluggedOnly')");
  if (statuses.has("Canceled")) clauses.push("WellStatus = 'Canceled'");
  if (statuses.has("Other")) {
    const known = KNOWN_STATUS_VALUES.map((status) => `'${status}'`).join(", ");
    clauses.push(`(WellStatus IS NULL OR WellStatus NOT IN (${known}))`);
  }
  return clauses.length ? `(${clauses.join(" OR ")})` : "1=0";
}

function buildWhere(operator, location, statuses) {
  const clauses = [buildStatusExpression(statuses)];
  if (operator?.where) clauses.push(operator.where);
  if (location?.where) clauses.push(location.where);
  return clauses.join(" AND ");
}

function setStatusSelection(statuses) {
  selectedStatuses.clear();
  statuses.forEach((status) => selectedStatuses.add(status));
  statusFilterContainer.querySelectorAll(".status-chip").forEach((button) => {
    button.setAttribute("aria-pressed", String(selectedStatuses.has(button.dataset.status)));
  });
}

function updateFilterSummary() {
  const parts = [];
  if (selectedStatuses.size === ALL_STATUS_CATEGORIES.length) parts.push("All well statuses");
  else if (selectedStatuses.size === 0) parts.push("No statuses selected");
  else parts.push(`${selectedStatuses.size} of ${ALL_STATUS_CATEGORIES.length} status groups`);
  if (selectedOperator) parts.push(selectedOperator.label);
  if (selectedLocation) parts.push(`${selectedLocation.kind}: ${selectedLocation.label}`);
  filterSummary.textContent = parts.join(" · ");
}

function clearSelection() {
  selectionHandle?.remove();
  selectionHandle = null;
  if (selectionGraphic) {
    view.graphics.remove(selectionGraphic);
    selectionGraphic = null;
  }
}

function resetDisplayForNewCommand() {
  selectedOperator = null;
  selectedLocation = null;
  setStatusSelection(ALL_STATUS_CATEGORIES);
  operatorInput.value = "";
  operatorSummary.textContent = "All operators";
  operatorSummary.classList.remove("is-filtered");
  clearOperatorButton.hidden = true;
  clearSelection();
  commandResultsLayer.removeAll();
  commandResultsLayer.visible = false;
  wells.visible = true;
  wells.definitionExpression = "1=1";
  wells.featureReduction = clusterConfig;
  updateFilterSummary();
}

function leaveCommandMode() {
  commandResultsLayer.removeAll();
  commandResultsLayer.visible = false;
  wells.visible = true;
  wells.featureReduction = clusterConfig;
  selectedLocation = null;
}

function applyManualFilters() {
  leaveCommandMode();
  wells.definitionExpression = buildWhere(selectedOperator, null, selectedStatuses);
  updateFilterSummary();
}

statusFilterContainer.addEventListener("click", (event) => {
  const button = event.target.closest(".status-chip");
  if (!button) return;
  const status = button.dataset.status;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  if (enabled) selectedStatuses.add(status); else selectedStatuses.delete(status);
  applyManualFilters();
});

resetFiltersButton.addEventListener("click", () => {
  setStatusSelection(ALL_STATUS_CATEGORIES);
  applyManualFilters();
});

function hideSearchResults() {
  searchResults.hidden = true;
  searchResults.replaceChildren();
}

function showSearchMessage(message) {
  const row = document.createElement("div");
  row.className = "search-message";
  row.textContent = message;
  searchResults.replaceChildren(row);
  searchResults.hidden = false;
}

function searchWhere(term) {
  const like = `%${escapeSql(normalize(term))}%`;
  return ["API", "WellDesignation", "LeaseName", "WellNumber", "OperatorName", "FieldName", "Place"]
    .map((field) => `UPPER(${field}) LIKE '${like}'`)
    .join(" OR ");
}

function resultLabel(attributes) {
  const designation = safeText(attributes.WellDesignation, "");
  if (designation) return designation;
  const lease = safeText(attributes.LeaseName, "Unnamed lease");
  return attributes.WellNumber ? `${lease} — ${attributes.WellNumber}` : lease;
}

function renderSearchResults(features) {
  if (!features.length) return showSearchMessage("No matching wells found.");
  const fragment = document.createDocumentFragment();
  features.forEach((feature) => {
    const a = feature.attributes;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.setAttribute("role", "option");

    const top = document.createElement("div");
    top.className = "result-top";
    const name = document.createElement("span");
    name.className = "result-name";
    name.textContent = resultLabel(a);
    const status = document.createElement("span");
    status.className = "result-status";
    status.textContent = safeText(a.WellStatus, "Unknown");
    const meta = document.createElement("div");
    meta.className = "result-meta";
    meta.textContent = `API ${safeText(a.API)} · ${safeText(a.OperatorName)} · ${safeText(a.FieldName)}`;
    top.append(name, status);
    button.append(top, meta);

    button.addEventListener("click", async () => {
      hideSearchResults();
      searchInput.value = resultLabel(a);
      clearSearchButton.hidden = false;
      await view.goTo({ target: feature.geometry, zoom: 16 }, { duration: 420, easing: "ease-out" });
      feature.popupTemplate = wellPopup;
      view.openPopup({ features: [feature], location: feature.geometry });
    });
    fragment.append(button);
  });
  searchResults.replaceChildren(fragment);
  searchResults.hidden = false;
}

async function runSearch(rawTerm) {
  const term = rawTerm.trim();
  if (term.length < 2) return hideSearchResults();
  const requestId = ++searchRequestId;
  showSearchMessage("Searching WellSTAR…");
  const query = queryLayer.createQuery();
  query.where = searchWhere(term);
  query.outFields = WELL_FIELDS;
  query.returnGeometry = true;
  query.num = 10;
  query.orderByFields = ["API ASC"];
  try {
    const response = await queryLayer.queryFeatures(query);
    if (requestId === searchRequestId) renderSearchResults(response.features.slice(0, 10));
  } catch (error) {
    if (requestId === searchRequestId) showSearchMessage("Search could not reach WellSTAR. Try again.");
  }
}

searchInput.addEventListener("input", () => {
  clearSearchButton.hidden = searchInput.value.length === 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInput.value), 300);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideSearchResults();
    searchInput.blur();
  }
});
clearSearchButton.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchButton.hidden = true;
  ++searchRequestId;
  hideSearchResults();
  searchInput.focus();
});

function hideOperatorResults() {
  operatorResults.hidden = true;
  operatorResults.replaceChildren();
}

function showOperatorMessage(message) {
  const row = document.createElement("div");
  row.className = "operator-message";
  row.textContent = message;
  operatorResults.replaceChildren(row);
  operatorResults.hidden = false;
}

function operatorFilterContains(term, label = term) {
  return { label, where: `UPPER(OperatorName) LIKE '%${escapeSql(normalize(term))}%'` };
}

function setOperatorExact(name) {
  selectedOperator = { label: name, where: `OperatorName = '${escapeSql(name)}'` };
  operatorInput.value = name;
  operatorSummary.textContent = `Filtering: ${name}`;
  operatorSummary.classList.add("is-filtered");
  clearOperatorButton.hidden = false;
  hideOperatorResults();
  applyManualFilters();
}

function clearOperator() {
  selectedOperator = null;
  operatorInput.value = "";
  operatorSummary.textContent = "All operators";
  operatorSummary.classList.remove("is-filtered");
  clearOperatorButton.hidden = true;
  ++operatorRequestId;
  hideOperatorResults();
  applyManualFilters();
}

function renderOperatorResults(names) {
  if (!names.length) return showOperatorMessage("No matching operators found.");
  const fragment = document.createDocumentFragment();
  names.forEach((name) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "operator-result";
    button.textContent = name;
    button.addEventListener("click", () => setOperatorExact(name));
    fragment.append(button);
  });
  operatorResults.replaceChildren(fragment);
  operatorResults.hidden = false;
}

async function runOperatorSearch(rawTerm) {
  const term = rawTerm.trim();
  if (term.length < 2) return hideOperatorResults();
  const requestId = ++operatorRequestId;
  showOperatorMessage("Finding operators…");
  const query = queryLayer.createQuery();
  query.where = `UPPER(OperatorName) LIKE '%${escapeSql(normalize(term))}%'`;
  query.outFields = ["OperatorName"];
  query.returnGeometry = false;
  query.returnDistinctValues = true;
  query.orderByFields = ["OperatorName ASC"];
  query.num = 20;
  try {
    const response = await queryLayer.queryFeatures(query);
    if (requestId !== operatorRequestId) return;
    const names = [...new Set(response.features.map((feature) => safeText(feature.attributes.OperatorName, "")).filter(Boolean))].slice(0, 20);
    renderOperatorResults(names);
  } catch (error) {
    if (requestId === operatorRequestId) showOperatorMessage("Operator lookup failed. Try again.");
  }
}

operatorInput.addEventListener("input", () => {
  if (selectedOperator && operatorInput.value !== selectedOperator.label) {
    selectedOperator = null;
    operatorSummary.textContent = "Choose an operator from the results";
    operatorSummary.classList.remove("is-filtered");
    clearOperatorButton.hidden = true;
    applyManualFilters();
  }
  clearTimeout(operatorTimer);
  operatorTimer = setTimeout(() => runOperatorSearch(operatorInput.value), 250);
});
operatorInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideOperatorResults();
    operatorInput.blur();
  }
});
clearOperatorButton.addEventListener("click", clearOperator);

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search-section")) hideSearchResults();
  if (!event.target.closest(".operator-section")) hideOperatorResults();
});

async function postWellStarQuery(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  body.set("f", "json");

  const response = await fetch(`${WELL_LAYER_URL}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString()
  });

  if (!response.ok) throw new Error(`WellSTAR REST request failed with HTTP ${response.status}.`);
  const json = await response.json();
  if (json.error) {
    const details = Array.isArray(json.error.details) ? json.error.details.join(" ") : "";
    throw new Error(`${json.error.message || "WellSTAR REST error"}${details ? ` — ${details}` : ""}`);
  }
  return json;
}

function distinctAttributeValues(json, field) {
  return [...new Set((json.features || []).map((feature) => safeText(feature.attributes?.[field], "")).filter(Boolean))];
}

async function findMatchingAttributeViaRest(field, rawValue) {
  const wanted = normalize(rawValue);

  const exactJson = await postWellStarQuery({
    where: `UPPER(${field}) = '${escapeSql(wanted)}'`,
    outFields: field,
    returnGeometry: "false",
    resultRecordCount: 100
  });
  const exactValues = distinctAttributeValues(exactJson, field);
  if (exactValues.length) return exactValues[0];

  const containsJson = await postWellStarQuery({
    where: `UPPER(${field}) LIKE '%${escapeSql(wanted)}%'`,
    outFields: field,
    returnGeometry: "false",
    resultRecordCount: 500
  });
  const values = distinctAttributeValues(containsJson, field);
  if (!values.length) return null;

  const normalizedExact = values.find((value) => normalize(value) === wanted);
  if (normalizedExact) return normalizedExact;
  return values.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

async function resolveCity(rawValue) {
  const query = cityLayer.createQuery();
  query.where = `UPPER(CITY) = '${escapeSql(normalize(rawValue))}'`;
  query.outFields = ["CITY", "COUNTY"];
  query.returnGeometry = true;
  query.num = 100;
  const response = await cityLayer.queryFeatures(query);
  if (!response.features.length) return null;

  const cityName = safeText(response.features[0].attributes.CITY, rawValue);
  const counties = [...new Set(response.features.map((feature) => safeText(feature.attributes.COUNTY, "")).filter(Boolean))];
  return {
    kind: "California city",
    label: counties.length ? `${cityName} (${counties.join(" / ")} County)` : cityName,
    geometries: response.features.map((feature) => feature.geometry).filter(Boolean),
    where: null
  };
}

async function resolveAttributeLocation(field, rawValue, kind) {
  const match = await findMatchingAttributeViaRest(field, rawValue);
  if (!match) return null;
  return {
    kind,
    label: match,
    where: `${field} = '${escapeSql(match)}'`,
    geometries: null
  };
}

async function resolveLocation(rawLocation) {
  const text = rawLocation.trim().replace(/[.,]+$/, "");
  const lower = text.toLowerCase();
  const explicitRules = [
    { word: "field", field: "FieldName", kind: "CalGEM field" },
    { word: "district", field: "District", kind: "CalGEM district" },
    { word: "county", field: "CountyName", kind: "County" },
    { word: "area", field: "AreaName", kind: "CalGEM area" },
    { word: "place", field: "Place", kind: "CalGEM place" }
  ];

  for (const rule of explicitRules) {
    if (lower.endsWith(` ${rule.word}`)) {
      const name = text.slice(0, -(rule.word.length + 1)).trim();
      return resolveAttributeLocation(rule.field, name, rule.kind);
    }
  }

  if (lower.endsWith(" city")) return resolveCity(text.slice(0, -5).trim());

  const city = await resolveCity(text);
  if (city) return city;

  for (const rule of [
    { field: "Place", kind: "CalGEM place" },
    { field: "FieldName", kind: "CalGEM field" },
    { field: "AreaName", kind: "CalGEM area" },
    { field: "CountyName", kind: "County" },
    { field: "District", kind: "CalGEM district" }
  ]) {
    const match = await resolveAttributeLocation(rule.field, text, rule.kind);
    if (match) return match;
  }

  return null;
}

function parseCommand(text) {
  const clean = text.trim().replace(/\s+/g, " ");
  const lower = clean.toLowerCase();
  if (/^(show|display|map)?\s*(me\s*)?(all\s+)?wells\s*$/.test(lower) || lower === "reset map") return { reset: true };

  let status = null;
  if (/\bidle\b/.test(lower)) status = "Idle";
  else if (/\bactive\b/.test(lower)) status = "Active";
  else if (/\b(plugged|abandoned)\b/.test(lower)) status = "Plugged";
  else if (/\b(permitted|new)\b/.test(lower)) status = "Permitted";
  else if (/\bcanceled\b/.test(lower)) status = "Canceled";

  const operatorMatch = clean.match(/operated\s+by\s+(.+?)(?=\s+in\s+|$)/i);
  const locationMatch = clean.match(/\s+in\s+(.+)$/i);
  return {
    reset: false,
    status,
    operator: operatorMatch ? operatorMatch[1].trim() : null,
    location: locationMatch ? locationMatch[1].trim() : null
  };
}

async function getObjectIdsViaRest(where) {
  const json = await postWellStarQuery({ where, returnIdsOnly: "true" });
  return Array.isArray(json.objectIds) ? json.objectIds : [];
}

async function getSpatialObjectIdsViaRest(where, geometry) {
  const geometryJson = geometry.toJSON ? geometry.toJSON() : geometry;
  const wkid = geometry.spatialReference?.wkid || geometry.spatialReference?.latestWkid || 3857;
  const json = await postWellStarQuery({
    where,
    geometry: JSON.stringify(geometryJson),
    geometryType: "esriGeometryPolygon",
    inSR: wkid,
    spatialRel: "esriSpatialRelIntersects",
    returnIdsOnly: "true"
  });
  return Array.isArray(json.objectIds) ? json.objectIds : [];
}

async function getWellGraphicsByObjectIds(objectIds) {
  const graphics = [];
  for (let start = 0; start < objectIds.length; start += REST_CHUNK_SIZE) {
    const chunk = objectIds.slice(start, start + REST_CHUNK_SIZE);
    const json = await postWellStarQuery({
      objectIds: chunk.join(","),
      outFields: WELL_FIELDS.join(","),
      returnGeometry: "true",
      outSR: 3857
    });

    for (const feature of json.features || []) {
      if (!feature.geometry) continue;
      graphics.push(new Graphic({
        geometry: {
          type: "point",
          x: feature.geometry.x,
          y: feature.geometry.y,
          spatialReference: { wkid: 3857 }
        },
        attributes: feature.attributes || {},
        symbol: symbolForStatus(feature.attributes?.WellStatus),
        popupTemplate: wellPopup
      }));
    }
  }
  return graphics;
}

async function queryLocationCommandGraphics(where, location) {
  const ids = new Set();
  if (location?.geometries?.length) {
    for (const geometry of location.geometries) {
      const geometryIds = await getSpatialObjectIdsViaRest(where, geometry);
      geometryIds.forEach((id) => ids.add(id));
    }
  } else {
    const attributeIds = await getObjectIdsViaRest(where);
    attributeIds.forEach((id) => ids.add(id));
  }
  return getWellGraphicsByObjectIds([...ids]);
}

async function queryAttributeCommandSummary(where) {
  const countQuery = queryLayer.createQuery();
  countQuery.where = where;
  countQuery.returnGeometry = false;
  const count = await queryLayer.queryFeatureCount(countQuery);
  const extentQuery = queryLayer.createQuery();
  extentQuery.where = where;
  extentQuery.returnGeometry = true;
  const extentResult = await queryLayer.queryExtent(extentQuery);
  return { count, extent: extentResult.extent || null };
}

function setControlsFromCommand(operator, location, statuses) {
  selectedOperator = operator;
  selectedLocation = location;
  setStatusSelection([...statuses]);
  if (operator) {
    operatorInput.value = operator.label;
    operatorSummary.textContent = `Filtering: ${operator.label}`;
    operatorSummary.classList.add("is-filtered");
    clearOperatorButton.hidden = false;
  } else {
    operatorInput.value = "";
    operatorSummary.textContent = "All operators";
    operatorSummary.classList.remove("is-filtered");
    clearOperatorButton.hidden = true;
  }
  updateFilterSummary();
}

function renderExactCommandResults(graphics) {
  commandResultsLayer.removeAll();
  commandResultsLayer.addMany(graphics);
  wells.visible = false;
  commandResultsLayer.visible = true;
}

async function zoomToLocationResult(graphics, location) {
  if (graphics.length) {
    await view.goTo(graphics, { duration: 520, easing: "ease-out" });
  } else if (location?.geometries?.length) {
    await view.goTo(location.geometries, { duration: 520, easing: "ease-out" });
  }
}

function resetMapFromCommand() {
  resetDisplayForNewCommand();
  commandResponse.textContent = "Reset complete — showing all California wells.";
  view.goTo({ center: [-119.45, 36.65], zoom: 5.8 }, { duration: 450 });
}

async function runMapCommand(rawText) {
  const parsed = parseCommand(rawText);
  if (parsed.reset) return resetMapFromCommand();
  if (!parsed.operator && !parsed.status && !parsed.location) {
    commandResponse.textContent = "I could not match that command. Try an operator, status, and/or California location.";
    return;
  }

  commandSubmit.disabled = true;
  let stage = "resetting the previous command";
  try {
    resetDisplayForNewCommand();
    const nextOperator = parsed.operator ? operatorFilterContains(parsed.operator, parsed.operator) : null;
    const nextStatuses = new Set(parsed.status ? [parsed.status] : ALL_STATUS_CATEGORIES);

    stage = "resolving the California location";
    const nextLocation = parsed.location ? await resolveLocation(parsed.location) : null;
    if (parsed.location && !nextLocation) {
      commandResponse.textContent = `I could not resolve “${parsed.location}”. Try “${parsed.location} city”, “${parsed.location} field”, “${parsed.location} county”, or “${parsed.location} district”.`;
      return;
    }

    const where = buildWhere(nextOperator, nextLocation, nextStatuses);

    if (nextLocation) {
      stage = `querying exact WellSTAR matches for ${nextLocation.kind}`;
      const graphics = await queryLocationCommandGraphics(where, nextLocation);
      stage = "drawing the exact location results";
      setControlsFromCommand(nextOperator, nextLocation, nextStatuses);
      renderExactCommandResults(graphics);
      clearSelection();
      await zoomToLocationResult(graphics, nextLocation);

      const description = [
        parsed.status ? parsed.status.toLowerCase() : null,
        "wells",
        nextOperator ? `operated by ${nextOperator.label}` : null,
        `in ${nextLocation.label}`
      ].filter(Boolean).join(" ");

      commandResponse.textContent = graphics.length
        ? `Showing ${graphics.length.toLocaleString()} matching ${description}. The statewide layer is hidden; only the exact matches are drawn.`
        : `0 wells match ${description}. The statewide layer is hidden, so the map is intentionally empty.`;
      return;
    }

    stage = "querying the WellSTAR attribute filters";
    const summary = await queryAttributeCommandSummary(where);
    stage = "applying the new command";
    setControlsFromCommand(nextOperator, null, nextStatuses);
    wells.visible = true;
    wells.featureReduction = clusterConfig;
    wells.definitionExpression = where;
    clearSelection();
    if (summary.extent) await view.goTo(summary.extent.expand(1.15), { duration: 500, easing: "ease-out" });

    const description = [
      parsed.status ? parsed.status.toLowerCase() : null,
      "wells",
      nextOperator ? `operated by ${nextOperator.label}` : null
    ].filter(Boolean).join(" ");

    commandResponse.textContent = summary.count
      ? `Showing ${summary.count.toLocaleString()} matching ${description}. All non-matching wells are excluded.`
      : `0 wells match ${description}.`;
  } catch (error) {
    console.error(`Map command failed while ${stage}:`, error);
    const detail = error?.message ? ` ${error.message}` : "";
    commandResponse.textContent = `Command failed while ${stage}.${detail}`;
  } finally {
    commandSubmit.disabled = false;
  }
}

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (commandInput.value.trim()) runMapCommand(commandInput.value.trim());
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    commandInput.value = button.dataset.command;
    runMapCommand(button.dataset.command);
  });
});

view.on("pointer-move", async (event) => {
  try {
    const hit = await view.hitTest(event, { include: [wells, commandResultsLayer] });
    view.container.style.cursor = hit.results.some((result) => result.graphic?.layer === wells || result.graphic?.layer === commandResultsLayer)
      ? "pointer"
      : "default";
  } catch (_) {}
});

view.on("click", async (event) => {
  try {
    const hit = await view.hitTest(event, { include: [wells, commandResultsLayer] });
    const result = hit.results.find((item) =>
      (item.graphic?.layer === wells && !item.graphic?.isAggregate) || item.graphic?.layer === commandResultsLayer
    );
    clearSelection();
    if (!result) return;

    if (result.graphic.layer === wells && wellsLayerView) {
      selectionHandle = wellsLayerView.highlight(result.graphic);
    } else if (result.graphic.layer === commandResultsLayer) {
      selectionGraphic = result.graphic.clone();
      selectionGraphic.popupTemplate = null;
      selectionGraphic.symbol = roundMarker([0, 122, 255, 0], 18, [0, 122, 255, 1], 3);
      view.graphics.add(selectionGraphic);
    }
  } catch (_) {}
});

reactiveUtils.watch(() => view.scale, (scale) => {
  const mode = scale > CLUSTER_MAX_SCALE ? "regional" : "individual";
  if (mode === lastZoomMode && !commandResultsLayer.visible) return;
  lastZoomMode = mode;

  if (commandResultsLayer.visible) {
    zoomModeTitle.textContent = "Exact command results";
    zoomModeCopy.textContent = "Only wells returned by the current location command are drawn on the map.";
  } else if (mode === "regional") {
    zoomModeTitle.textContent = "Regional view";
    zoomModeCopy.textContent = "Nearby wells are clustered. Location commands switch to an exact result-only layer.";
  } else {
    zoomModeTitle.textContent = "Individual-well view";
    zoomModeCopy.textContent = "Click a round status marker to select and inspect the well.";
  }
}, { initial: true });

reactiveUtils.watch(() => view.updating, (updating) => {
  if (updating) {
    dataState.classList.remove("ready", "error");
    dataStateText.textContent = "Updating map…";
  } else {
    dataState.classList.add("ready");
    dataState.classList.remove("error");
    dataStateText.textContent = "WellSTAR layer ready";
  }
}, { initial: true });

try {
  await Promise.all([wells.load(), queryLayer.load(), cityLayer.load(), view.when()]);
  wellsLayerView = await view.whenLayerView(wells);
  wells.definitionExpression = "1=1";
  dataState.classList.add("ready");
  dataStateText.textContent = "WellSTAR layer ready";
} catch (error) {
  console.error("Could not initialize map:", error);
  dataState.classList.add("error");
  dataStateText.textContent = "WellSTAR layer unavailable";
}
