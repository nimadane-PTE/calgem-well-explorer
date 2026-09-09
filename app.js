const [Map, MapView, FeatureLayer, Home, ScaleBar, reactiveUtils, Basemap, TileLayer, FeatureFilter] = await $arcgis.import([
  "@arcgis/core/Map.js",
  "@arcgis/core/views/MapView.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/widgets/Home.js",
  "@arcgis/core/widgets/ScaleBar.js",
  "@arcgis/core/core/reactiveUtils.js",
  "@arcgis/core/Basemap.js",
  "@arcgis/core/layers/TileLayer.js",
  "@arcgis/core/layers/support/FeatureFilter.js"
]);

const WELL_LAYER_URL = "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0";
const CA_CITY_LAYER_URL = "https://gis.conservation.ca.gov/server/rest/services/Base/Base_BOECities/FeatureServer/0";

const WELL_FIELDS = [
  "OBJECTID", "API", "LeaseName", "WellNumber", "WellDesignation", "WellStatus",
  "WellTypeLabel", "OperatorName", "FieldName", "AreaName", "District", "CountyName",
  "SpudDate", "Latitude", "Longitude"
];

const KNOWN_STATUS_VALUES = ["Active", "Idle", "New", "Plugged", "PluggedOnly", "Canceled"];
const ALL_STATUS_CATEGORIES = ["Active", "Idle", "Permitted", "Plugged", "Canceled", "Other"];
const CLUSTER_MAX_SCALE = 30000;

const dataState = document.getElementById("data-state");
const dataStateText = document.getElementById("data-state-text");
const zoomModeTitle = document.getElementById("zoom-mode-title");
const zoomModeCopy = document.getElementById("zoom-mode-copy");
const statusFilterContainer = document.getElementById("status-filters");
const filterSummary = document.getElementById("filter-summary");
const resetFiltersButton = document.getElementById("reset-filters");
const searchInput = document.getElementById("well-search");
const searchResults = document.getElementById("search-results");
const clearSearchButton = document.getElementById("clear-search");
const operatorInput = document.getElementById("operator-filter");
const operatorResults = document.getElementById("operator-results");
const operatorSummary = document.getElementById("operator-summary");
const clearOperatorButton = document.getElementById("clear-operator");
const commandForm = document.getElementById("command-form");
const commandInput = document.getElementById("command-input");
const commandSubmit = document.getElementById("command-submit");
const commandResponse = document.getElementById("command-response");

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

function roundMarker(color, size = 10) {
  return {
    type: "simple-marker",
    style: "circle",
    size,
    color,
    outline: { color: [255, 255, 255, 0.98], width: 1.4 }
  };
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function safeText(value, fallback = "—") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

const statusRenderer = {
  type: "unique-value",
  field: "WellStatus",
  defaultSymbol: roundMarker([75, 85, 99, 0.92], 9),
  defaultLabel: "Unknown / other",
  uniqueValueInfos: [
    { value: "Active", label: "Active", symbol: roundMarker([33, 150, 83, 0.98], 10) },
    { value: "Idle", label: "Idle", symbol: roundMarker([245, 158, 11, 0.98], 10) },
    { value: "New", label: "Permitted", symbol: roundMarker([37, 99, 235, 0.98], 10) },
    { value: "Plugged", label: "Plugged", symbol: roundMarker([107, 114, 128, 0.96], 9) },
    { value: "PluggedOnly", label: "Plugged", symbol: roundMarker([107, 114, 128, 0.96], 9) },
    { value: "Canceled", label: "Canceled", symbol: roundMarker([220, 38, 38, 0.98], 9) }
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
    symbol: { type: "text", color: "white", font: { family: "Arial", size: 10, weight: "bold" }, haloSize: 0 },
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

const queryLayer = new FeatureLayer({ url: WELL_LAYER_URL, outFields: WELL_FIELDS, popupTemplate: wellPopup });
const cityLayer = new FeatureLayer({ url: CA_CITY_LAYER_URL, outFields: ["CITY", "COUNTY"], visible: false });

const streetBasemap = new Basemap({
  title: "Detailed Streets",
  baseLayers: [new TileLayer({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
    opacity: 0.92
  })]
});

const map = new Map({ basemap: streetBasemap, layers: [wells] });
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

function buildStatusExpression() {
  if (selectedStatuses.size === 0) return "1=0";
  if (selectedStatuses.size === ALL_STATUS_CATEGORIES.length) return "1=1";
  const clauses = [];
  if (selectedStatuses.has("Active")) clauses.push("WellStatus = 'Active'");
  if (selectedStatuses.has("Idle")) clauses.push("WellStatus = 'Idle'");
  if (selectedStatuses.has("Permitted")) clauses.push("WellStatus = 'New'");
  if (selectedStatuses.has("Plugged")) clauses.push("WellStatus IN ('Plugged', 'PluggedOnly')");
  if (selectedStatuses.has("Canceled")) clauses.push("WellStatus = 'Canceled'");
  if (selectedStatuses.has("Other")) {
    const known = KNOWN_STATUS_VALUES.map((s) => `'${s}'`).join(", ");
    clauses.push(`(WellStatus IS NULL OR WellStatus NOT IN (${known}))`);
  }
  return clauses.length ? `(${clauses.join(" OR ")})` : "1=0";
}

function buildDefinitionExpression() {
  const clauses = [buildStatusExpression()];
  if (selectedOperator?.where) clauses.push(selectedOperator.where);
  if (selectedLocation?.where) clauses.push(selectedLocation.where);
  return clauses.join(" AND ");
}

function locationLabel() {
  return selectedLocation ? `${selectedLocation.kind}: ${selectedLocation.label}` : null;
}

function updateFilterSummary() {
  const count = selectedStatuses.size;
  const parts = [];
  if (count === ALL_STATUS_CATEGORIES.length) parts.push("All well statuses");
  else if (count === 0) parts.push("No statuses selected");
  else parts.push(`${count} of ${ALL_STATUS_CATEGORIES.length} status groups`);
  if (selectedOperator) parts.push(selectedOperator.label);
  if (selectedLocation) parts.push(locationLabel());
  filterSummary.textContent = parts.join(" · ");
}

function applySpatialFilter() {
  if (!wellsLayerView) return;
  wellsLayerView.filter = selectedLocation?.geometry
    ? new FeatureFilter({ geometry: selectedLocation.geometry, spatialRelationship: "intersects" })
    : null;
}

function applyFilters() {
  wells.definitionExpression = buildDefinitionExpression();
  applySpatialFilter();
  updateFilterSummary();
}

function setStatusSelection(statuses) {
  selectedStatuses.clear();
  statuses.forEach((s) => selectedStatuses.add(s));
  statusFilterContainer.querySelectorAll(".status-chip").forEach((button) => {
    button.setAttribute("aria-pressed", String(selectedStatuses.has(button.dataset.status)));
  });
}

statusFilterContainer.addEventListener("click", (event) => {
  const button = event.target.closest(".status-chip");
  if (!button) return;
  const status = button.dataset.status;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(enabled));
  if (enabled) selectedStatuses.add(status); else selectedStatuses.delete(status);
  applyFilters();
});

resetFiltersButton.addEventListener("click", () => {
  setStatusSelection(ALL_STATUS_CATEGORIES);
  applyFilters();
});

function hideSearchResults() { searchResults.hidden = true; searchResults.replaceChildren(); }
function showSearchMessage(message) {
  const row = document.createElement("div"); row.className = "search-message"; row.textContent = message;
  searchResults.replaceChildren(row); searchResults.hidden = false;
}

function searchWhere(term) {
  const like = `%${escapeSql(normalize(term))}%`;
  return ["API", "WellDesignation", "LeaseName", "WellNumber", "OperatorName", "FieldName"]
    .map((field) => `UPPER(${field}) LIKE '${like}'`).join(" OR ");
}

function resultLabel(a) {
  const designation = safeText(a.WellDesignation, "");
  if (designation) return designation;
  const lease = safeText(a.LeaseName, "Unnamed lease");
  return a.WellNumber ? `${lease} — ${a.WellNumber}` : lease;
}

function renderSearchResults(features) {
  if (!features.length) return showSearchMessage("No matching wells found.");
  const fragment = document.createDocumentFragment();
  features.forEach((feature) => {
    const a = feature.attributes;
    const button = document.createElement("button");
    button.type = "button"; button.className = "search-result"; button.setAttribute("role", "option");
    const top = document.createElement("div"); top.className = "result-top";
    const name = document.createElement("span"); name.className = "result-name"; name.textContent = resultLabel(a);
    const status = document.createElement("span"); status.className = "result-status"; status.textContent = safeText(a.WellStatus, "Unknown");
    const meta = document.createElement("div"); meta.className = "result-meta";
    meta.textContent = `API ${safeText(a.API)} · ${safeText(a.OperatorName)} · ${safeText(a.FieldName)}`;
    top.append(name, status); button.append(top, meta);
    button.addEventListener("click", async () => {
      hideSearchResults(); searchInput.value = resultLabel(a); clearSearchButton.hidden = false;
      await view.goTo({ target: feature.geometry, zoom: 16 }, { duration: 420, easing: "ease-out" });
      feature.popupTemplate = wellPopup;
      view.openPopup({ features: [feature], location: feature.geometry });
    });
    fragment.append(button);
  });
  searchResults.replaceChildren(fragment); searchResults.hidden = false;
}

async function runSearch(rawTerm) {
  const term = rawTerm.trim();
  if (term.length < 2) return hideSearchResults();
  const requestId = ++searchRequestId; showSearchMessage("Searching WellSTAR…");
  const query = queryLayer.createQuery();
  query.where = searchWhere(term); query.outFields = WELL_FIELDS; query.returnGeometry = true; query.num = 10; query.orderByFields = ["API ASC"];
  try {
    const response = await queryLayer.queryFeatures(query);
    if (requestId === searchRequestId) renderSearchResults(response.features.slice(0, 10));
  } catch (error) {
    if (requestId === searchRequestId) showSearchMessage("Search could not reach WellSTAR. Try again.");
  }
}

searchInput.addEventListener("input", () => {
  clearSearchButton.hidden = searchInput.value.length === 0;
  clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(searchInput.value), 300);
});
searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideSearchResults(); searchInput.blur(); } });
clearSearchButton.addEventListener("click", () => {
  searchInput.value = ""; clearSearchButton.hidden = true; ++searchRequestId; hideSearchResults(); searchInput.focus();
});

function hideOperatorResults() { operatorResults.hidden = true; operatorResults.replaceChildren(); }
function showOperatorMessage(message) {
  const row = document.createElement("div"); row.className = "operator-message"; row.textContent = message;
  operatorResults.replaceChildren(row); operatorResults.hidden = false;
}

function setOperatorExact(name) {
  selectedOperator = { label: name, where: `OperatorName = '${escapeSql(name)}'` };
  operatorInput.value = name; operatorSummary.textContent = `Filtering: ${name}`;
  operatorSummary.classList.add("is-filtered"); clearOperatorButton.hidden = false;
  hideOperatorResults(); applyFilters();
}

function setOperatorContains(term, label = term) {
  selectedOperator = { label, where: `UPPER(OperatorName) LIKE '%${escapeSql(normalize(term))}%'` };
  operatorInput.value = label; operatorSummary.textContent = `Filtering: ${label}`;
  operatorSummary.classList.add("is-filtered"); clearOperatorButton.hidden = false; applyFilters();
}

function clearOperator() {
  selectedOperator = null; operatorInput.value = ""; operatorSummary.textContent = "All operators";
  operatorSummary.classList.remove("is-filtered"); clearOperatorButton.hidden = true; ++operatorRequestId;
  hideOperatorResults(); applyFilters();
}

function renderOperatorResults(names) {
  if (!names.length) return showOperatorMessage("No matching operators found.");
  const fragment = document.createDocumentFragment();
  names.forEach((name) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "operator-result";
    button.textContent = name; button.addEventListener("click", () => setOperatorExact(name)); fragment.append(button);
  });
  operatorResults.replaceChildren(fragment); operatorResults.hidden = false;
}

async function runOperatorSearch(rawTerm) {
  const term = rawTerm.trim(); if (term.length < 2) return hideOperatorResults();
  const requestId = ++operatorRequestId; showOperatorMessage("Finding operators…");
  const query = queryLayer.createQuery();
  query.where = `UPPER(OperatorName) LIKE '%${escapeSql(normalize(term))}%'`;
  query.outFields = ["OperatorName"]; query.returnGeometry = false; query.returnDistinctValues = true; query.orderByFields = ["OperatorName ASC"]; query.num = 20;
  try {
    const response = await queryLayer.queryFeatures(query); if (requestId !== operatorRequestId) return;
    const names = [...new Set(response.features.map((f) => safeText(f.attributes.OperatorName, "")).filter(Boolean))].slice(0, 20);
    renderOperatorResults(names);
  } catch (error) { if (requestId === operatorRequestId) showOperatorMessage("Operator lookup failed. Try again."); }
}

operatorInput.addEventListener("input", () => {
  if (selectedOperator && operatorInput.value !== selectedOperator.label) {
    selectedOperator = null; operatorSummary.textContent = "Choose an operator from the results";
    operatorSummary.classList.remove("is-filtered"); clearOperatorButton.hidden = true; applyFilters();
  }
  clearTimeout(operatorTimer); operatorTimer = setTimeout(() => runOperatorSearch(operatorInput.value), 250);
});
operatorInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideOperatorResults(); operatorInput.blur(); } });
clearOperatorButton.addEventListener("click", clearOperator);

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search-section")) hideSearchResults();
  if (!event.target.closest(".operator-section")) hideOperatorResults();
});

async function findExactWellAttribute(field, rawValue) {
  const value = normalize(rawValue);
  const query = queryLayer.createQuery();
  query.where = `UPPER(${field}) = '${escapeSql(value)}'`;
  query.outFields = [field]; query.returnGeometry = false; query.returnDistinctValues = true; query.num = 5;
  const response = await queryLayer.queryFeatures(query);
  const match = response.features.map((f) => safeText(f.attributes[field], "")).find(Boolean);
  return match || null;
}

async function resolveCity(rawValue) {
  const query = cityLayer.createQuery();
  query.where = `UPPER(CITY) = '${escapeSql(normalize(rawValue))}'`;
  query.outFields = ["CITY", "COUNTY"]; query.returnGeometry = true; query.num = 10;
  const response = await cityLayer.queryFeatures(query);
  if (!response.features.length) return null;
  const exact = response.features[0];
  return {
    kind: "California city",
    label: `${safeText(exact.attributes.CITY)} (${safeText(exact.attributes.COUNTY)} County)`,
    geometry: exact.geometry,
    where: null
  };
}

async function resolveLocation(rawLocation) {
  let text = rawLocation.trim().replace(/[.,]+$/, "");
  const lower = text.toLowerCase();
  const explicit = [
    { word: "field", field: "FieldName", kind: "CalGEM field" },
    { word: "district", field: "District", kind: "CalGEM district" },
    { word: "county", field: "CountyName", kind: "County" },
    { word: "area", field: "AreaName", kind: "CalGEM area" }
  ];

  for (const rule of explicit) {
    if (lower.endsWith(` ${rule.word}`)) {
      const name = text.slice(0, -(rule.word.length + 1)).trim();
      const exact = await findExactWellAttribute(rule.field, name);
      return exact ? { kind: rule.kind, label: exact, where: `${rule.field} = '${escapeSql(exact)}'`, geometry: null } : null;
    }
  }

  // Unqualified California place names: agency geography first, then California city.
  for (const rule of [
    { field: "FieldName", kind: "CalGEM field" },
    { field: "AreaName", kind: "CalGEM area" },
    { field: "CountyName", kind: "County" },
    { field: "District", kind: "CalGEM district" }
  ]) {
    const exact = await findExactWellAttribute(rule.field, text);
    if (exact) return { kind: rule.kind, label: exact, where: `${rule.field} = '${escapeSql(exact)}'`, geometry: null };
  }

  return resolveCity(text);
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
  const operator = operatorMatch ? operatorMatch[1].trim() : null;
  const locationMatch = clean.match(/\s+in\s+(.+)$/i);
  const location = locationMatch ? locationMatch[1].trim() : null;
  return { reset: false, status, operator, location };
}

async function zoomToCurrentResult() {
  if (selectedLocation?.geometry) {
    await view.goTo(selectedLocation.geometry.extent.expand(1.2), { duration: 500, easing: "ease-out" });
    return;
  }
  const query = queryLayer.createQuery();
  query.where = buildDefinitionExpression();
  query.returnGeometry = true;
  const extentResult = await queryLayer.queryExtent(query);
  if (extentResult.extent) await view.goTo(extentResult.extent.expand(1.15), { duration: 500, easing: "ease-out" });
}

function resetMapFromCommand() {
  selectedOperator = null; selectedLocation = null; setStatusSelection(ALL_STATUS_CATEGORIES);
  operatorInput.value = ""; operatorSummary.textContent = "All operators"; operatorSummary.classList.remove("is-filtered"); clearOperatorButton.hidden = true;
  applyFilters(); commandResponse.textContent = "Reset complete — showing all California wells.";
  view.goTo({ center: [-119.45, 36.65], zoom: 5.8 }, { duration: 450 });
}

async function runMapCommand(rawText) {
  const parsed = parseCommand(rawText);
  if (parsed.reset) return resetMapFromCommand();
  if (!parsed.operator && !parsed.status && !parsed.location) {
    commandResponse.textContent = "I could not match that command. Try an operator, status, and/or California location.";
    return;
  }

  commandSubmit.disabled = true; commandResponse.textContent = "Resolving CalGEM filters…";
  try {
    if (parsed.operator) setOperatorContains(parsed.operator, parsed.operator);
    else { selectedOperator = null; operatorInput.value = ""; operatorSummary.textContent = "All operators"; clearOperatorButton.hidden = true; }

    if (parsed.status) setStatusSelection([parsed.status]); else setStatusSelection(ALL_STATUS_CATEGORIES);

    selectedLocation = null;
    if (parsed.location) {
      selectedLocation = await resolveLocation(parsed.location);
      if (!selectedLocation) {
        applyFilters();
        commandResponse.textContent = `I could not resolve “${parsed.location}” as an exact CalGEM field/area/district/county or California city.`;
        return;
      }
    }

    applyFilters();
    await zoomToCurrentResult();
    const pieces = [];
    if (parsed.status) pieces.push(parsed.status.toLowerCase());
    pieces.push("wells");
    if (selectedOperator) pieces.push(`operated by ${selectedOperator.label}`);
    if (selectedLocation) pieces.push(`in ${selectedLocation.label}`);
    commandResponse.textContent = `Showing ${pieces.join(" ")}.`;
  } catch (error) {
    console.error("Map command failed:", error);
    commandResponse.textContent = "That command could not be completed from the CalGEM services. Try a more specific location name.";
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
    const hit = await view.hitTest(event, { include: wells });
    view.container.style.cursor = hit.results.some((r) => r.graphic?.layer === wells) ? "pointer" : "default";
  } catch (_) {}
});

view.on("click", async (event) => {
  try {
    const hit = await view.hitTest(event, { include: wells });
    const result = hit.results.find((r) => r.graphic?.layer === wells && !r.graphic?.isAggregate);
    selectionHandle?.remove(); selectionHandle = null;
    if (result && wellsLayerView) selectionHandle = wellsLayerView.highlight(result.graphic);
  } catch (_) {}
});

reactiveUtils.watch(() => view.scale, (scale) => {
  const mode = scale > CLUSTER_MAX_SCALE ? "regional" : "individual";
  if (mode === lastZoomMode) return; lastZoomMode = mode;
  if (mode === "regional") {
    zoomModeTitle.textContent = "Regional view";
    zoomModeCopy.textContent = "Nearby wells are clustered. Zoom closer for individual round status markers.";
  } else {
    zoomModeTitle.textContent = "Individual-well view";
    zoomModeCopy.textContent = "Click a round status marker to select and inspect the well.";
  }
}, { initial: true });

reactiveUtils.watch(() => view.updating, (updating) => {
  if (updating) {
    dataState.classList.remove("ready", "error"); dataStateText.textContent = "Updating map…";
  } else {
    dataState.classList.add("ready"); dataState.classList.remove("error"); dataStateText.textContent = "WellSTAR layer ready";
  }
}, { initial: true });

try {
  await Promise.all([wells.load(), queryLayer.load(), cityLayer.load(), view.when()]);
  wellsLayerView = await view.whenLayerView(wells);
  applyFilters();
  dataState.classList.add("ready"); dataStateText.textContent = "WellSTAR layer ready";
} catch (error) {
  console.error("Could not initialize map:", error);
  dataState.classList.add("error"); dataStateText.textContent = "WellSTAR layer unavailable";
}
