const accessGate = document.getElementById("access-gate");
const accessForm = document.getElementById("access-form");
const accessSubmit = document.getElementById("access-submit");
const accessMessage = document.getElementById("access-message");

const ACCESS_KEY = "californiaWellExplorerAccess";
const isLocalPreview = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

function unlockMap() {
  document.body.classList.remove("access-locked");
  document.body.classList.add("access-granted");
  accessGate?.setAttribute("aria-hidden", "true");
}

function rememberAccess() {
  try {
    sessionStorage.setItem(ACCESS_KEY, "granted");
  } catch (_) {}
}

function hasSessionAccess() {
  try {
    return sessionStorage.getItem(ACCESS_KEY) === "granted";
  } catch (_) {
    return false;
  }
}

function encodeForm(form) {
  return new URLSearchParams(new FormData(form)).toString();
}

if (hasSessionAccess()) {
  unlockMap();
}

accessForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!accessForm.reportValidity()) return;

  accessSubmit.disabled = true;
  accessMessage.textContent = isLocalPreview
    ? "Local preview — opening the map…"
    : "Submitting…";

  if (isLocalPreview) {
    rememberAccess();
    unlockMap();
    accessSubmit.disabled = false;
    accessMessage.textContent = "";
    return;
  }

  try {
    const response = await fetch("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: encodeForm(accessForm)
    });

    if (!response.ok) {
      throw new Error(`Submission failed with HTTP ${response.status}`);
    }

    rememberAccess();
    unlockMap();
    accessMessage.textContent = "";
  } catch (error) {
    console.error("Access form submission failed:", error);
    accessMessage.textContent = "We could not submit your information. Please try again.";
  } finally {
    accessSubmit.disabled = false;
  }
});
