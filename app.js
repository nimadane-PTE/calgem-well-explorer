const [Map, MapView, FeatureLayer, Home, ScaleBar, reactiveUtils, Basemap, TileLayer] = await $arcgis.import([
  "@arcgis/core/Map.js",
  "@arcgis/core/views/MapView.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/widgets/Home.js",
  "@arcgis/core/widgets/ScaleBar.js",
  "@arcgis/core/core/reactiveUtils.js",
  "@arcgis/core/Basemap.js",
  "@arcgis/core/layers/TileLayer.js"
]);

const WELL_LAYER_URL =
  "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0";

const WELL_FIELDS = [
  "API",
  "LeaseName",
  "WellNumber",
  "WellDesignation",
  "WellStatus",
  "WellTypeLabel",
  "OperatorName",
  "FieldName",
  "CountyName",
  "SpudDate",
  "Latitude",
  "Longitude"
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

const selectedStatuses = new Set(ALL_STATUS_CATEGORIES);
let selectedOperator = null;
let searchTimer = null;
let searchRequestId = 0;
let operatorTimer = null;
let operatorRequestId = 0;
let lastZoomMode = null;

function simpleMarker(style, color, size = 10) {
  return {
    type: "simple-marker",
    style,
    size,
    color,
    outline: {
      color: [255, 255, 255, 0.96],
      width: 1.1
    }
  };
}

function escapeSql(value) {
  return value.replaceAll("'", "''");
}

function safeText(value, fallback = "—") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

const statusRenderer = {
  type: "unique-value",
  field: "WellStatus",
  defaultSymbol: simpleMarker("circle", [75, 85, 99, 0.9], 9),
  defaultLabel: "Unknown / other",
  uniqueValueInfos: [
    { value: "Active", label: "Active", symbol: simpleMarker("circle", [33, 150, 83, 0.96], 10) },
    { value: "Idle", label: "Idle", symbol: simpleMarker("diamond", [245, 158, 11, 0.96], 11) },
    { value: "New", label: "Permitted", symbol: simpleMarker("triangle", [37, 99, 235, 0.96], 11) },
    { value: "Plugged", label: "Plugged", symbol: simpleMarker("square", [107, 114, 128, 0.94], 9) },
    { value: "PluggedOnly", label: "Plugged", symbol: simpleMarker("square", [107, 114, 128, 0.94], 9) },
    { value: "Canceled", label: "Canceled", symbol: simpleMarker("x", [220, 38, 38, 1], 10) }
  ]
};

const wellPopup = {
  title: "{LeaseName} — Well {WellNumber}",
  content: [
    {
      type: "fields",
      fieldInfos: [
        { fieldName: "API", label: "API number" },
        { fieldName: "WellStatus", label: "Status" },
        { fieldName: "WellTypeLabel", label: "Well type" },
        { fieldName: "OperatorName", label: "Operator" },
        { fieldName: "FieldName", label: "Field" },
        { fieldName: "CountyName", label: "County" },
        { fieldName: "SpudDate", label: "Spud date" },
        { fieldName: "Latitude", label: "Latitude", format: { places: 5, digitSeparator: false } },
        { fieldName: "Longitude", label: "Longitude", format: { places: 5, digitSeparator: false } }
      ]
    }
  ],
  outFields: WELL_FIELDS
};

const clusterConfig = {
  type: "cluster",
  maxScale: CLUSTER_MAX_SCALE,
  clusterRadius: "46px",
  clusterMinSize: "20px",
  clusterMaxSize: "40px",
  symbol: {
    type: "simple-marker",
    style: "circle",
    color: [35, 49, 66, 0.86],
    outline: { color: [255, 255, 255, 0.96], width: 1.4 }
  },
  labelingInfo: [
    {
      deconflictionStrategy: "none",
      labelExpressionInfo: { expression: "Text($feature.cluster_count, '#,###')" },
      symbol: {
        type: "text",
        color: "white",
        font: { family: "Arial", size: 10, weight: "bold" },
        haloSize: 0
      },
      labelPlacement: "center-center"
    }
  ],
  popupTemplate: {
    title: "{cluster_count} wells at this map scale",
    content: "Zoom in to separate nearby wells. Clustering also prevents dense well locations from appearing to disappear behind one another."
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

const searchLayer = new FeatureLayer({
  url: WELL_LAYER_URL,
  outFields: WELL_FIELDS,
  popupTemplate: wellPopup,
  labelsVisible: false
});

const streetBasemap = new Basemap({
  title: "Detailed Streets",
  baseLayers: [
    new TileLayer({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
      opacity: 0.92
    })
  ]
});

const map = new Map({
  basemap: streetBasemap,
  layers: [wells]
});

const view = new MapView({
  container: "viewDiv",
  map,
  center: [-119.45, 36.65],
  zoom: 5.8,
  constraints: {
    minZoom: 4,
    maxZoom: 20,
    snapToZoom: true
  },
  popup: {
    dockEnabled: false,
    collapseEnabled: false
  },
  highlightOptions: {
    fillOpacity: 0,
    haloOpacity: 0.9
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
    const known = KNOWN_STATUS_VALUES.map((status) => `'${status}'`).join(", ");
    clauses.push(`(WellStatus IS NULL OR WellStatus NOT IN (${known}))`);
  }

  return clauses.length ? `(${clauses.join(" OR ")})` : "1=0";
}

function buildDefinitionExpression() {
  const clauses = [buildStatusExpression()];

  if (selectedOperator) {
    clauses.push(`OperatorName = '${escapeSql(selectedOperator)}'`);
  }

  return clauses.join(" AND ");
}

function updateFilterSummary() {
  const count = selectedStatuses.size;
  let statusText;

  if (count === ALL_STATUS_CATEGORIES.length) statusText = "All well statuses";
  else if (count === 0) statusText = "No statuses selected";
  else statusText = `${count} of ${ALL_STATUS_CATEGORIES.length} status groups`;

  filterSummary.textContent = selectedOperator
    ? `${statusText} · ${selectedOperator}`
    : statusText;
}

function applyFilters() {
  wells.definitionExpression = buildDefinitionExpression();
  updateFilterSummary();
}

statusFilterContainer.addEventListener("click", (event) => {
  const button = event.target.closest(".status-chip");
  if (!button) return;

  const status = button.dataset.status;
  const willEnable = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(willEnable));

  if (willEnable) selectedStatuses.add(status);
  else selectedStatuses.delete(status);

  applyFilters();
});

resetFiltersButton.addEventListener("click", () => {
  selectedStatuses.clear();
  ALL_STATUS_CATEGORIES.forEach((status) => selectedStatuses.add(status));
  statusFilterContainer.querySelectorAll(".status-chip").forEach((button) => {
    button.setAttribute("aria-pressed", "true");
  });
  applyFilters();
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
  const escaped = escapeSql(term.trim().toUpperCase());
  const like = `%${escaped}%`;
  return [
    `UPPER(API) LIKE '${like}'`,
    `UPPER(WellDesignation) LIKE '${like}'`,
    `UPPER(LeaseName) LIKE '${like}'`,
    `UPPER(WellNumber) LIKE '${like}'`,
    `UPPER(OperatorName) LIKE '${like}'`,
    `UPPER(FieldName) LIKE '${like}'`
  ].join(" OR ");
}

function resultLabel(attributes) {
  const designation = safeText(attributes.WellDesignation, "");
  if (designation) return designation;

  const lease = safeText(attributes.LeaseName, "Unnamed lease");
  const wellNumber = safeText(attributes.WellNumber, "");
  return wellNumber ? `${lease} — ${wellNumber}` : lease;
}

function renderSearchResults(features) {
  if (!features.length) {
    showSearchMessage("No matching wells found.");
    return;
  }

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

      try {
        await view.goTo(
          { target: feature.geometry, zoom: 16 },
          { duration: 500, easing: "ease-out" }
        );

        feature.popupTemplate = wellPopup;
        view.openPopup({
          features: [feature],
          location: feature.geometry
        });
      } catch (error) {
        if (error?.name !== "AbortError") console.error("Could not zoom to well:", error);
      }
    });

    fragment.append(button);
  });

  searchResults.replaceChildren(fragment);
  searchResults.hidden = false;
}

async function runSearch(rawTerm) {
  const term = rawTerm.trim();
  if (term.length < 2) {
    hideSearchResults();
    return;
  }

  const requestId = ++searchRequestId;
  showSearchMessage("Searching WellSTAR…");

  const query = searchLayer.createQuery();
  query.where = searchWhere(term);
  query.outFields = WELL_FIELDS;
  query.returnGeometry = true;
  query.num = 10;
  query.orderByFields = ["API ASC"];

  try {
    const response = await searchLayer.queryFeatures(query);
    if (requestId !== searchRequestId) return;
    renderSearchResults(response.features.slice(0, 10));
  } catch (error) {
    if (requestId !== searchRequestId) return;
    console.error("Well search failed:", error);
    showSearchMessage("Search could not reach the WellSTAR service. Try again.");
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

function setOperator(operatorName) {
  selectedOperator = operatorName;
  operatorInput.value = operatorName;
  operatorSummary.textContent = `Filtering: ${operatorName}`;
  operatorSummary.classList.add("is-filtered");
  clearOperatorButton.hidden = false;
  hideOperatorResults();
  applyFilters();
}

function clearOperator() {
  selectedOperator = null;
  operatorInput.value = "";
  operatorSummary.textContent = "All operators";
  operatorSummary.classList.remove("is-filtered");
  clearOperatorButton.hidden = true;
  ++operatorRequestId;
  hideOperatorResults();
  applyFilters();
}

function renderOperatorResults(operatorNames) {
  if (!operatorNames.length) {
    showOperatorMessage("No matching operators found.");
    return;
  }

  const fragment = document.createDocumentFragment();

  operatorNames.forEach((operatorName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "operator-result";
    button.setAttribute("role", "option");
    button.textContent = operatorName;
    button.addEventListener("click", () => setOperator(operatorName));
    fragment.append(button);
  });

  operatorResults.replaceChildren(fragment);
  operatorResults.hidden = false;
}

async function runOperatorSearch(rawTerm) {
  const term = rawTerm.trim();
  if (term.length < 2) {
    hideOperatorResults();
    return;
  }

  const requestId = ++operatorRequestId;
  showOperatorMessage("Finding operators…");

  const escaped = escapeSql(term.toUpperCase());
  const query = searchLayer.createQuery();
  query.where = `UPPER(OperatorName) LIKE '%${escaped}%'`;
  query.outFields = ["OperatorName"];
  query.returnGeometry = false;
  query.returnDistinctValues = true;
  query.orderByFields = ["OperatorName ASC"];
  query.num = 20;

  try {
    const response = await searchLayer.queryFeatures(query);
    if (requestId !== operatorRequestId) return;

    const names = [...new Set(
      response.features
        .map((feature) => safeText(feature.attributes.OperatorName, ""))
        .filter(Boolean)
    )].slice(0, 20);

    renderOperatorResults(names);
  } catch (error) {
    if (requestId !== operatorRequestId) return;
    console.error("Operator search failed:", error);
    showOperatorMessage("Operator lookup failed. Try again.");
  }
}

operatorInput.addEventListener("input", () => {
  if (selectedOperator && operatorInput.value !== selectedOperator) {
    selectedOperator = null;
    operatorSummary.textContent = "Choose an operator from the results";
    operatorSummary.classList.remove("is-filtered");
    clearOperatorButton.hidden = true;
    applyFilters();
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

reactiveUtils.watch(
  () => view.scale,
  (scale) => {
    const mode = scale > CLUSTER_MAX_SCALE ? "regional" : "individual";
    if (mode === lastZoomMode) return;
    lastZoomMode = mode;

    if (mode === "regional") {
      zoomModeTitle.textContent = "Regional view";
      zoomModeCopy.textContent = "Nearby or coincident wells are clustered for speed and completeness. Zoom closer for individual well symbols.";
    } else {
      zoomModeTitle.textContent = "Individual-well view";
      zoomModeCopy.textContent = "Status symbols now represent individual wells. Click a symbol to see well details.";
    }
  },
  { initial: true }
);

reactiveUtils.watch(
  () => view.updating,
  (updating) => {
    if (updating) {
      dataState.classList.remove("ready", "error");
      dataStateText.textContent = "Updating map…";
    } else {
      dataState.classList.add("ready");
      dataState.classList.remove("error");
      dataStateText.textContent = "WellSTAR layer ready";
    }
  },
  { initial: true }
);

try {
  await Promise.all([wells.load(), searchLayer.load()]);
  applyFilters();
  dataState.classList.add("ready");
  dataStateText.textContent = "WellSTAR layer ready";
} catch (error) {
  console.error("Could not load the CalGEM WellSTAR layer:", error);
  dataState.classList.add("error");
  dataStateText.textContent = "WellSTAR layer unavailable";
}
