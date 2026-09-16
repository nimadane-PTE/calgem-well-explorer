const form = document.getElementById("admin-form");
const keyInput = document.getElementById("admin-key");
const dateInput = document.getElementById("admin-date");
const status = document.getElementById("status");
const body = document.getElementById("log-body");
const csvButton = document.getElementById("download-csv");

const today = new Date();
dateInput.value = today.toISOString().slice(0, 10);
keyInput.value = sessionStorage.getItem("wellstar_ai_admin_key") || "";

function td(value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value == null || value === "" ? "—" : String(value);
  if (className) cell.className = className;
  return cell;
}

function render(rows) {
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      td(row.timestamp),
      td(row.name),
      td(row.email),
      td(row.type),
      td(row.status),
      td(row.message, "message")
    );
    body.append(tr);
  }
}

async function loadLogs() {
  const adminKey = keyInput.value.trim();
  const date = dateInput.value;
  if (!adminKey || !date) return;
  sessionStorage.setItem("wellstar_ai_admin_key", adminKey);
  status.textContent = "Loading…";

  try {
    const response = await fetch(`/api/ai-admin-logs?date=${encodeURIComponent(date)}`, {
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    render(result.rows || []);
    status.textContent = `${result.count || 0} logged events for ${date}.`;
  } catch (error) {
    render([]);
    status.textContent = `Could not load log: ${error.message}`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadLogs();
});

csvButton.addEventListener("click", async () => {
  const adminKey = keyInput.value.trim();
  const date = dateInput.value;
  if (!adminKey || !date) return;
  sessionStorage.setItem("wellstar_ai_admin_key", adminKey);
  status.textContent = "Preparing CSV…";

  try {
    const response = await fetch(`/api/ai-admin-logs?date=${encodeURIComponent(date)}&format=csv`, {
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wellstar-ai-usage-${date}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    status.textContent = "CSV downloaded.";
  } catch (error) {
    status.textContent = `Could not download CSV: ${error.message}`;
  }
});
