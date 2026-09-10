const aiForm = document.getElementById("ai-form");
const aiInput = document.getElementById("ai-input");
const aiSubmit = document.getElementById("ai-submit");
const aiResponse = document.getElementById("ai-response");
const aiResults = document.getElementById("ai-results");
const hiddenCommandForm = document.getElementById("command-form");
const hiddenCommandInput = document.getElementById("command-input");

function text(value) {
  return value == null || String(value).trim() === "" ? "—" : String(value);
}

function prettyField(field) {
  const labels = {
    API: "API number",
    WellNumber: "Well number",
    WellDesignation: "Well designation",
    WellStatus: "Status",
    OperatorName: "Operator",
    FieldName: "Field",
    AreaName: "Area",
    District: "District",
    CountyName: "County",
    Place: "Place",
    LeaseName: "Lease",
    WellTypeLabel: "Well type",
    SpudDate: "Spud date",
    Latitude: "Latitude",
    Longitude: "Longitude"
  };
  return labels[field] || field;
}

function describeCriteria(result) {
  const parts = [];
  if (result.plan?.status) parts.push(result.plan.status.toLowerCase());
  parts.push("wells");
  if (result.plan?.operator) parts.push(`operated by ${result.plan.operator}`);
  if (result.resolved_location?.label) parts.push(`in ${result.resolved_location.label}`);
  return parts.join(" ");
}

function runMapCommand(command) {
  if (!command || !hiddenCommandForm || !hiddenCommandInput) return;
  hiddenCommandInput.value = command;
  hiddenCommandForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function renderRows(result) {
  aiResults.replaceChildren();
  if (!result.rows?.length) return;

  const wrap = document.createElement("div");
  wrap.className = "ai-table-wrap";

  const table = document.createElement("table");
  table.className = "ai-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const field of result.fields) {
    const th = document.createElement("th");
    th.textContent = prettyField(field);
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    for (const field of result.fields) {
      const td = document.createElement("td");
      td.textContent = text(row[field]);
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrap.append(table);
  aiResults.append(wrap);
}

function renderAnswer(result) {
  const criteria = describeCriteria(result);
  const action = result.plan?.action;

  if (result.count === 0) {
    aiResponse.textContent = `I found 0 matching ${criteria} in CalGEM WellSTAR.`;
    aiResults.replaceChildren();
    return;
  }

  if (action === "count") {
    aiResponse.textContent = `CalGEM WellSTAR contains ${result.count.toLocaleString()} matching ${criteria}.`;
    aiResults.replaceChildren();
    return;
  }

  if (action === "list" || action === "map_and_list") {
    const suffix = result.truncated
      ? ` Showing the first ${result.rows.length.toLocaleString()} records.`
      : "";
    aiResponse.textContent = `I found ${result.count.toLocaleString()} matching ${criteria}.${suffix}`;
    renderRows(result);
    return;
  }

  aiResponse.textContent = `I found ${result.count.toLocaleString()} matching ${criteria} and updated the map.`;
  aiResults.replaceChildren();
}

async function askAI(message) {
  aiSubmit.disabled = true;
  aiResponse.textContent = "Understanding your question and querying WellSTAR…";
  aiResults.replaceChildren();

  try {
    const response = await fetch("/api/wellstar-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed with HTTP ${response.status}`);

    renderAnswer(result);

    if (["map", "map_and_list"].includes(result.plan?.action)) {
      runMapCommand(result.map_command);
    }
  } catch (error) {
    console.error("AI assistant request failed:", error);
    aiResponse.textContent = error.message || "The AI assistant could not complete that request.";
  } finally {
    aiSubmit.disabled = false;
  }
}

aiForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = aiInput.value.trim();
  if (message) askAI(message);
});

document.querySelectorAll("[data-ai-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const message = button.dataset.aiCommand;
    aiInput.value = message;
    askAI(message);
  });
});
