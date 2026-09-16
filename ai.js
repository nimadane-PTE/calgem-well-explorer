const aiAccessPanel = document.getElementById("ai-access-panel");
const aiAssistantContent = document.getElementById("ai-assistant-content");
const aiAccessForm = document.getElementById("ai-access-form");
const aiAccessName = document.getElementById("ai-access-name");
const aiAccessEmail = document.getElementById("ai-access-email");
const aiAccessConsent = document.getElementById("ai-access-consent");
const aiAccessSubmit = document.getElementById("ai-access-submit");
const aiAccessResponse = document.getElementById("ai-access-response");
const aiSignOut = document.getElementById("ai-sign-out");
const aiUserLine = document.getElementById("ai-user-line");

const aiForm = document.getElementById("ai-form");
const aiInput = document.getElementById("ai-input");
const aiSubmit = document.getElementById("ai-submit");
const aiResponse = document.getElementById("ai-response");
const aiResults = document.getElementById("ai-results");
const hiddenCommandForm = document.getElementById("command-form");
const hiddenCommandInput = document.getElementById("command-input");

const TOKEN_KEY = "wellstar_ai_access_token";
const USER_KEY = "wellstar_ai_access_user";
const EXPIRY_KEY = "wellstar_ai_access_expiry";

function text(value) {
  return value == null || String(value).trim() === "" ? "—" : String(value);
}

function getSession() {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const expiry = Date.parse(localStorage.getItem(EXPIRY_KEY) || "");
  let user = null;
  try {
    user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch (_) {
    user = null;
  }
  if (!token || !user || !Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return { token, user, expiry };
}

function saveSession(result) {
  localStorage.setItem(TOKEN_KEY, result.token);
  localStorage.setItem(USER_KEY, JSON.stringify(result.user));
  localStorage.setItem(EXPIRY_KEY, result.expires_at);
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(EXPIRY_KEY);
}

function showAccessGate(message = "") {
  aiAccessPanel.hidden = false;
  aiAssistantContent.hidden = true;
  if (aiAccessResponse) aiAccessResponse.textContent = message;
}

function showAssistant(session) {
  aiAccessPanel.hidden = true;
  aiAssistantContent.hidden = false;
  if (aiUserLine) aiUserLine.textContent = `Signed in as ${session.user.name} · ${session.user.email}`;
  checkAIHealth();
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

async function readJsonResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error(`The AI function returned a non-JSON response (HTTP ${response.status}).`);
  }
}

async function checkAIHealth() {
  if (!aiResponse) return;
  aiResponse.textContent = "Checking AI service…";

  try {
    const response = await fetch("/api/wellstar-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ health: true })
    });
    const result = await readJsonResponse(response);

    if (!response.ok) throw new Error(result.error || `AI health check failed with HTTP ${response.status}`);
    if (!result.api_key_configured) {
      aiResponse.textContent = "AI function is live, but OPENAI_API_KEY is not configured for this Netlify project.";
      return;
    }
    if (result.ai_disabled) {
      aiResponse.textContent = "AI requests are temporarily disabled by the site owner.";
      return;
    }
    aiResponse.textContent = "AI service ready. Ask a WellSTAR question below.";
  } catch (error) {
    console.error("AI health check failed:", error);
    aiResponse.textContent = `AI connection problem: ${error.message || "Could not reach the serverless function."}`;
  }
}

async function askAI(message) {
  const session = getSession();
  if (!session) {
    clearSession();
    showAccessGate("Your AI access session has expired. Please sign in again.");
    return;
  }

  aiSubmit.disabled = true;
  aiResponse.textContent = "Understanding your question with AI and querying WellSTAR…";
  aiResults.replaceChildren();

  try {
    const response = await fetch("/api/wellstar-ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.token}`
      },
      body: JSON.stringify({ message })
    });

    const result = await readJsonResponse(response);
    if (response.status === 401) {
      clearSession();
      showAccessGate("Your AI access session is no longer valid. Please sign in again.");
      return;
    }
    if (!response.ok) throw new Error(result.error || `AI request failed with HTTP ${response.status}`);

    renderAnswer(result);
    if (["map", "map_and_list"].includes(result.plan?.action)) runMapCommand(result.map_command);
  } catch (error) {
    console.error("AI assistant request failed:", error);
    aiResponse.textContent = `AI request failed: ${error.message || "The AI assistant could not complete that request."}`;
  } finally {
    aiSubmit.disabled = false;
  }
}

aiAccessForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  aiAccessSubmit.disabled = true;
  aiAccessResponse.textContent = "Creating protected AI access…";

  try {
    const response = await fetch("/api/ai-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: aiAccessName.value.trim(),
        email: aiAccessEmail.value.trim(),
        consent: aiAccessConsent.checked
      })
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || `Access request failed with HTTP ${response.status}`);
    saveSession(result);
    showAssistant(getSession());
  } catch (error) {
    aiAccessResponse.textContent = error.message || "Could not create AI access.";
  } finally {
    aiAccessSubmit.disabled = false;
  }
});

aiSignOut?.addEventListener("click", () => {
  clearSession();
  if (aiResults) aiResults.replaceChildren();
  showAccessGate("Signed out.");
});

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

const initialSession = getSession();
if (initialSession) showAssistant(initialSession);
else showAccessGate();
