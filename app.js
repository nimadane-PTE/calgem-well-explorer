const [Map, MapView, FeatureLayer, Home, ScaleBar, reactiveUtils] = await $arcgis.import([
  "@arcgis/core/Map.js",
  "@arcgis/core/views/MapView.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/widgets/Home.js",
  "@arcgis/core/widgets/ScaleBar.js",
  "@arcgis/core/core/reactiveUtils.js"
]);

const WELL_LAYER_URL =
  "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0";

const KNOWN_STATUS_VALUES = ["Active", "Idle", "New", "Plugged", "PluggedOnly", "Canceled"];
const ALL_STATUS_CATEGORIES = ["Active", "Idle", "Permitted", "Plugged", "Canceled", "Other"];

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

const selectedStatuses = new Set(ALL_STATUS_CATEGORIES);
let searchTimer = null;
let searchRequestId = 0;

function simpleMarker(style, color, size = 10) {
  return {
    type: "simple-marker",
    style,
    size,
    color,
    outline: {
      color: [255, 255, 255, 0.95],
      width: 1.2
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

const statusExpression = `
  var s = Upper(DefaultValue($feature.WellStatus, ''));
  return When(
    s == 'ACTIVE', 'Active',
    s == 'IDLE', 'Idle',
    s == 'NEW', 'Permitted',
    Find('PLUGGED', s) > -1, 'Plugged',
    Find('CANCEL', s) > -1, 'Canceled',
    'Other'
  );
`;

const statusRenderer = {
  type: "unique-value",
  valueExpression: statusExpression,
  valueExpressionTitle: "Well status",
  defaultSymbol: simpleMarker("circle", [75, 85, 99, 0.9], 9),
  defaultLabel: "Unknown / other",
  uniqueValueInfos: [
    { value: "Active", label: "Active", symbol: simpleMarker("circle", [33, 150, 83, 0.95], 10) },
    { value: "Idle", label: "Idle", symbol: simpleMarker("diamond", [245, 158, 11, 0.95], 11) },
    { value: "Permitted", label: "Permitted", symbol: simpleMarker("triangle", [37, 99, 235, 0.95], 11) },
    { value: "Plugged", label: "Plugged", symbol: simpleMarker("square", [107, 114, 128, 0.92], 9) },
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
  outFields: [
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
  ]
};

const clusterConfig = {
  type: "cluster",
  clusterRadius: "64px",
  clusterMinSize: "22px",
  clusterMaxSize: "44px",
  symbol: {
    type: "simple-marker",
    style: "circle",
    color: [27, 43, 63, 0.86],
    outline: { color: [255, 255, 255, 0.92], width: 1.5 }
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
    title: "{cluster_count} wells in this area",
    content: "Zoom in to separate the cluster and inspect individual wells."
  }
};

const wells = new FeatureLayer({
  url: WELL_LAYER_URL,
  title: "CalGEM WellSTAR Wells",
  outFields: ["*"],
  renderer: statusRenderer,
  popupTemplate: wellPopup,
  featureReduction: clusterConfig,
  minScale: 0
});

const searchLayer = new FeatureLayer({
  url: WELL_LAYER_URL,
  outFields: [
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
  ],
  popupTemplate: wellPopup
});

const map = new Map({
  basemap: "osm",
  layers: [wells]
});

const view = new MapView({
  container: "viewDiv",
  map,
  center: [-119.45, 36.65],
  zoom: 5.6,
  constraints: {
    minZoom: 4,
    maxZoom: 20,
    snapToZoom: false
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

function buildDefinitionExpression() {
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

  return clauses.length ? clauses.join(" OR ") : "1=0";
}

function updateFilterSummary() {
  const count = selectedStatuses.size;
  if (count === ALL_STATUS_CATEGORIES.length) filterSummary.textContent = "Showing all well statuses";
  else if (count === 0) filterSummary.textContent = "No statuses selected";
  else filterSummary.textContent = `Showing ${count} of ${ALL_STATUS_CATEGORIES.length} status groups`;
}

function applyStatusFilters() {
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

  applyStatusFilters();
});

resetFiltersButton.addEventListener("click", () => {
  selectedStatuses.clear();
  ALL_STATUS_CATEGORIES.forEach((status) => selectedStatuses.add(status));
  statusFilterContainer.querySelectorAll(".status-chip").forEach((button) => {
    button.setAttribute("aria-pressed", "true");
  });
  applyStatusFilters();
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
          { target: feature.geometry, zoom: 15 },
          { duration: 850, easing: "ease-in-out" }
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
  query.outFields = searchLayer.outFields;
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
  searchTimer = setTimeout(() => runSearch(searchInput.value), 280);
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

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search-section")) hideSearchResults();
});

reactiveUtils.watch(
  () => view.scale,
  (scale) => {
    const regionalMode = scale > 150000;
    wells.featureReduction = regionalMode ? clusterConfig : null;

    if (regionalMode) {
      zoomModeTitle.textContent = "Regional view";
      zoomModeCopy.textContent = "Nearby wells are clustered for faster navigation. Zoom in for individual wells.";
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
  applyStatusFilters();
  dataState.classList.add("ready");
  dataStateText.textContent = "WellSTAR layer ready";
} catch (error) {
  console.error("Could not load the CalGEM WellSTAR layer:", error);
  dataState.classList.add("error");
  dataStateText.textContent = "Could not load WellSTAR data";
}
