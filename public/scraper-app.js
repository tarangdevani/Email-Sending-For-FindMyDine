/* ═══════════════════════════════════════════════════════════
   Email Scraper — Client Application
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    firestorePath: $("#firestorePath"),
    btnStart: $("#btnStart"),
    btnStop: $("#btnStop"),
    btnDownload: $("#btnDownload"),
    rescrapContainer: $("#rescrapContainer"),
    forceRescrapCheckbox: $("#forceRescrapCheckbox"),

    // Stats
    statProcessed: $("#statProcessed"),
    statEmails: $("#statEmails"),
    statMobiles: $("#statMobiles"),
    statErrors: $("#statErrors"),
    statStatus: $("#statStatus"),

    // Progress
    progressFill: $("#progressFill"),
    progressPercent: $("#progressPercent"),
    currentBusiness: $("#currentBusiness"),

    // Log
    logContainer: $("#logContainer"),

    // Emails
    emailsSection: $("#emailsSection"),
    emailsSummary: $("#emailsSummary"),
    emailsList: $("#emailsList"),
    emailsSubmitBar: $("#emailsSubmitBar"),
    emailPathBadge: $("#emailPathBadge"),
    btnSubmitEmails: $("#btnSubmitEmails"),

    // Check Emails
    checkEmailPath: $("#checkEmailPath"),
    btnCheckEmails: $("#btnCheckEmails"),

    // Validate
    btnValidateEmails: $("#btnValidateEmails"),

    // Toast
    toastContainer: $("#toastContainer"),
  };

  let pollInterval = null;
  let lastLogCount = 0;
  let currentEmailPath = ""; // Tracks which Firestore path the email list belongs to
  let editableEmails = []; // In-memory editable email list
  let validationResults = new Map(); // email -> { valid, reason }

  // ── Init ────────────────────────────────────────────────
  function init() {
    els.btnStart.addEventListener("click", startScraping);
    els.btnStop.addEventListener("click", stopScraping);
    els.btnDownload.addEventListener("click", downloadEmails);
    els.btnCheckEmails.addEventListener("click", checkEmails);
    els.btnSubmitEmails.addEventListener("click", submitEmails);
    els.btnValidateEmails.addEventListener("click", validateEmails);

    // Check if scraper is already running on load
    fetchStatus();

    // Check path on input with debounce
    let pathTimeout;
    els.firestorePath.addEventListener("input", () => {
      clearTimeout(pathTimeout);
      els.rescrapContainer.style.display = "none";
      els.forceRescrapCheckbox.checked = false;
      pathTimeout = setTimeout(checkIfPathIsScraped, 500);
    });
    
    // Check path on initial load if present
    if (els.firestorePath.value.trim()) {
      checkIfPathIsScraped();
    }
  }

  // ── Check if Path is Scraped ───────────────────────────
  async function checkIfPathIsScraped() {
    const path = els.firestorePath.value.trim();
    if (!path) return;

    try {
      const res = await fetch("/api/scraper/check-unscraped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firestorePath: path }),
      });
      const data = await res.json();
      
      if (data.success && data.total > 0 && data.remaining === 0) {
        els.rescrapContainer.style.display = "block";
      } else {
        els.rescrapContainer.style.display = "none";
        els.forceRescrapCheckbox.checked = false;
      }
    } catch (err) {
      console.error("Failed to check path status:", err);
    }
  }

  // ── Start Scraping ─────────────────────────────────────
  async function startScraping() {
    const path = els.firestorePath.value.trim();
    if (!path) {
      showToast("Please enter a Firestore path", "error");
      els.firestorePath.classList.add("error");
      els.firestorePath.addEventListener("input", () => els.firestorePath.classList.remove("error"), { once: true });
      return;
    }

    els.btnStart.classList.add("sending");
    els.btnStart.querySelector(".btn-content span:last-child").textContent = "Starting...";

    try {
      const res = await fetch("/api/scraper/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          firestorePath: path,
          forceRescrap: els.forceRescrapCheckbox.checked
        }),
      });

      const data = await res.json();

      if (data.success) {
        showToast("Scraper started! 🚀", "success");
        setRunningUI(true);
        startPolling();
      } else {
        showToast(data.message || "Failed to start scraper", "error");
      }
    } catch (err) {
      showToast("Network error — could not start scraper", "error");
    } finally {
      els.btnStart.classList.remove("sending");
      els.btnStart.querySelector(".btn-content span:last-child").textContent = "Start Scraping";
    }
  }

  // ── Stop Scraping ──────────────────────────────────────
  async function stopScraping() {
    try {
      const res = await fetch("/api/scraper/stop", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        showToast("Stop signal sent ⏸️", "info");
        els.btnStop.disabled = true;
        els.btnStop.textContent = "⏸️ Stopping...";
      } else {
        showToast(data.message || "Failed to stop", "error");
      }
    } catch (err) {
      showToast("Network error", "error");
    }
  }

  // ── Polling ────────────────────────────────────────────
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    lastLogCount = 0;
    pollInterval = setInterval(fetchStatus, 2000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch("/api/scraper/status");
      const data = await res.json();
      updateUI(data);

      if (data.isRunning && !pollInterval) {
        setRunningUI(true);
        startPolling();
      }

      if (!data.isRunning && pollInterval) {
        stopPolling();
        setRunningUI(false);

        if (data.completedAt) {
          showToast("Scraping complete! ✅", "success");
        }
      }
    } catch (err) {
      // Silent fail on polling
    }
  }

  // ── UI Updates ─────────────────────────────────────────
  function setRunningUI(isRunning) {
    els.btnStart.disabled = isRunning;
    els.btnStop.disabled = !isRunning;
    els.firestorePath.disabled = isRunning;
    els.btnStop.textContent = isRunning ? "⏹️ Stop" : "⏹️ Stop";

    if (isRunning) {
      els.btnStart.classList.add("sending");
      els.btnStart.querySelector(".btn-content span:last-child").textContent = "Running...";
    } else {
      els.btnStart.classList.remove("sending");
      els.btnStart.querySelector(".btn-content span:last-child").textContent = "Start Scraping";
      els.btnStart.disabled = false;
    }
  }

  function updateUI(data) {
    // Stats
    els.statProcessed.textContent = `${data.processed} / ${data.total}`;
    els.statEmails.textContent = data.foundEmailsCount;
    els.statMobiles.textContent = data.foundMobilesCount || 0;
    els.statErrors.textContent = data.errorsCount;

    if (data.isRunning) {
      els.statStatus.textContent = "Running...";
      els.statStatus.style.color = "var(--accent)";
    } else if (data.completedAt) {
      els.statStatus.textContent = "Complete ✅";
      els.statStatus.style.color = "var(--success, #4ade80)";
    } else {
      els.statStatus.textContent = "Idle";
      els.statStatus.style.color = "";
    }

    // Progress
    const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
    els.progressFill.style.width = pct + "%";
    els.progressPercent.textContent = pct + "%";
    els.currentBusiness.textContent = data.currentBusiness || "—";

    // Logs
    if (data.logs && data.logs.length > 0) {
      renderLogs(data.logs);
    }

    // Emails — show editable list when scraper has found emails
    if (data.foundEmails && data.foundEmails.length > 0) {
      currentEmailPath = data.firestorePath || els.firestorePath.value.trim();
      editableEmails = [...data.foundEmails];
      renderEditableEmails();
    }
  }

  function renderLogs(logs) {
    const typeIcons = {
      info: "ℹ️",
      success: "✅",
      error: "❌",
      warning: "⚠️",
    };

    els.logContainer.innerHTML = logs
      .map((log) => {
        const time = new Date(log.time).toLocaleTimeString();
        const icon = typeIcons[log.type] || "ℹ️";
        return `
          <div class="log-entry log-${log.type}">
            <span class="log-time">${time}</span>
            <span class="log-icon">${icon}</span>
            <span class="log-msg">${escapeHtml(log.message)}</span>
          </div>
        `;
      })
      .join("");

    // Auto scroll to bottom
    els.logContainer.scrollTop = els.logContainer.scrollHeight;
  }

  // ── Editable Email List ────────────────────────────────
  function renderEditableEmails() {
    els.emailsSection.style.display = "block";

    const validCount = [...validationResults.values()].filter((v) => v.valid).length;
    const invalidCount = [...validationResults.values()].filter((v) => !v.valid).length;

    let summaryText = `${editableEmails.length} unique email(s)`;
    if (validationResults.size > 0) {
      summaryText += ` — ✅ ${validCount} valid, ❌ ${invalidCount} invalid`;
    }
    els.emailsSummary.textContent = summaryText;

    // Show the path badge if available
    if (currentEmailPath) {
      els.emailPathBadge.textContent = `📂 ${currentEmailPath}`;
      els.emailPathBadge.style.display = "inline-block";
    } else {
      els.emailPathBadge.style.display = "none";
    }

    if (editableEmails.length === 0) {
      els.emailsList.innerHTML = `
        <div class="emails-empty">
          <span>📭</span> No emails in the list.
        </div>
      `;
      els.emailsSubmitBar.style.display = "none";
      return;
    }

    els.emailsList.innerHTML = editableEmails
      .map((email, index) => {
        const vResult = validationResults.get(email);
        let statusHtml = "";
        let rowClass = "email-editable-row";

        if (vResult) {
          if (vResult.valid) {
            statusHtml = `<span class="email-status email-status-valid" title="${escapeHtml(vResult.reason)}">✅</span>`;
            rowClass += " email-row-valid";
          } else {
            statusHtml = `<span class="email-status email-status-invalid" title="${escapeHtml(vResult.reason)}">❌ ${escapeHtml(vResult.reason)}</span>`;
            rowClass += " email-row-invalid";
          }
        }

        return `
        <div class="${rowClass}" data-index="${index}">
          <span class="email-row-number">${index + 1}</span>
          <input
            type="email"
            class="email-editable-input"
            value="${escapeHtml(email)}"
            data-index="${index}"
          >
          ${statusHtml}
          <button type="button" class="email-delete-btn" data-index="${index}" title="Delete this email">
            🗑️
          </button>
        </div>
      `;
      })
      .join("");

    // Show submit bar
    els.emailsSubmitBar.style.display = "flex";

    // Attach event listeners
    els.emailsList.querySelectorAll(".email-editable-input").forEach((input) => {
      input.addEventListener("change", (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        editableEmails[idx] = e.target.value.trim();
      });
    });

    els.emailsList.querySelectorAll(".email-delete-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.currentTarget.dataset.index, 10);
        deleteEmail(idx);
      });
    });
  }

  function deleteEmail(index) {
    editableEmails.splice(index, 1);
    renderEditableEmails();
    showToast("Email removed from list", "info");
  }

  // ── Validate Emails (MX + keyword + dedup) ─────────────
  async function validateEmails() {
    // Sync any currently edited inputs
    els.emailsList.querySelectorAll(".email-editable-input").forEach((input) => {
      const idx = parseInt(input.dataset.index, 10);
      editableEmails[idx] = input.value.trim();
    });

    const cleanEmails = editableEmails.filter((e) => e && e.length > 0);
    if (cleanEmails.length === 0) {
      showToast("No emails to validate", "error");
      return;
    }

    els.btnValidateEmails.classList.add("sending");
    els.btnValidateEmails.querySelector(".btn-content span:last-child").textContent = "Validating...";

    try {
      const res = await fetch("/api/scraper/validate-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: cleanEmails }),
      });

      const data = await res.json();

      if (data.success) {
        // Clear old results
        validationResults.clear();

        // Auto-remove emails rejected by keyword filter or substring dedup
        const autoRemoved = data.invalidEmails.filter(
          (r) => r.reason === "Blacklisted keyword" || r.reason === "Substring duplicate"
        );
        const autoRemovedSet = new Set(autoRemoved.map((r) => r.email));

        // Keep only emails not auto-removed
        editableEmails = cleanEmails.filter((e) => !autoRemovedSet.has(e));

        // Store MX validation results for the remaining emails
        for (const r of data.results) {
          if (!autoRemovedSet.has(r.email)) {
            validationResults.set(r.email, { valid: r.valid, reason: r.reason });
          }
        }

        const removedCount = autoRemoved.length;
        const msg = removedCount > 0
          ? `Validated! ✅ ${data.validCount - removedCount >= 0 ? data.validCount : 0} valid, ❌ ${data.invalidCount - removedCount} invalid MX. Removed ${removedCount} (keyword/duplicate).`
          : `Validated! ✅ ${data.validCount} valid, ❌ ${data.invalidCount} invalid MX.`;

        showToast(msg, "success");
        renderEditableEmails();
      } else {
        showToast(data.message || "Validation failed", "error");
      }
    } catch (err) {
      showToast("Network error — could not validate emails", "error");
    } finally {
      els.btnValidateEmails.classList.remove("sending");
      els.btnValidateEmails.querySelector(".btn-content span:last-child").textContent = "Validate Emails";
    }
  }

  // ── Submit Emails to State ─────────────────────────────
  async function submitEmails() {
    if (!currentEmailPath) {
      showToast("No Firestore path set — cannot submit", "error");
      return;
    }

    // Sync any currently edited inputs
    els.emailsList.querySelectorAll(".email-editable-input").forEach((input) => {
      const idx = parseInt(input.dataset.index, 10);
      editableEmails[idx] = input.value.trim();
    });

    // Filter out empty entries
    const cleanEmails = editableEmails.filter((e) => e && e.length > 0);

    els.btnSubmitEmails.classList.add("sending");
    els.btnSubmitEmails.querySelector(".btn-content span:last-child").textContent = "Submitting...";

    try {
      const res = await fetch("/api/scraper/update-state-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firestorePath: currentEmailPath,
          emails: cleanEmails,
        }),
      });

      const data = await res.json();

      if (data.success) {
        showToast(`✅ ${data.count} email(s) saved to state document!`, "success");
        editableEmails = cleanEmails;
        renderEditableEmails();
      } else {
        showToast(data.message || "Failed to submit emails", "error");
      }
    } catch (err) {
      showToast("Network error — could not submit emails", "error");
    } finally {
      els.btnSubmitEmails.classList.remove("sending");
      els.btnSubmitEmails.querySelector(".btn-content span:last-child").textContent = "Submit to State";
    }
  }

  // ── Check Emails from Path ─────────────────────────────
  async function checkEmails() {
    const path = els.checkEmailPath.value.trim();
    if (!path) {
      showToast("Please enter a state path", "error");
      els.checkEmailPath.classList.add("error");
      els.checkEmailPath.addEventListener("input", () => els.checkEmailPath.classList.remove("error"), { once: true });
      return;
    }

    els.btnCheckEmails.classList.add("sending");
    els.btnCheckEmails.querySelector(".btn-content span:last-child").textContent = "Checking...";

    try {
      const res = await fetch("/api/scraper/check-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firestorePath: path }),
      });

      const data = await res.json();

      if (data.success) {
        if (data.emails.length === 0) {
          showToast("No emails found at this path", "info");
        } else {
          showToast(`Found ${data.count} email(s)! 📧`, "success");
        }

        // Load into editable list
        currentEmailPath = path;
        editableEmails = [...data.emails];
        renderEditableEmails();
      } else {
        showToast(data.message || "Failed to check emails", "error");
      }
    } catch (err) {
      showToast("Network error — could not check emails", "error");
    } finally {
      els.btnCheckEmails.classList.remove("sending");
      els.btnCheckEmails.querySelector(".btn-content span:last-child").textContent = "Check Emails";
    }
  }

  // ── Download Emails ────────────────────────────────────
  function downloadEmails() {
    const pathValue = els.firestorePath.value.trim();
    if (!pathValue) {
      showToast("No Firestore path set", "error");
      return;
    }

    // Extract country and state from the path
    const parts = pathValue.split("/");
    const country = parts[1] || "Unknown";
    const state = parts[3] || "Unknown";

    window.open(`/api/scraper/download-emails?country=${encodeURIComponent(country)}&state=${encodeURIComponent(state)}`, "_blank");
  }

  // ── Toast Notifications ────────────────────────────────
  function showToast(message, type = "info") {
    const icons = { success: "✅", error: "❌", info: "ℹ️" };

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <span>${escapeHtml(message)}</span>
      <button class="toast-close" title="Close">&times;</button>
    `;

    els.toastContainer.appendChild(toast);
    toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));
    setTimeout(() => dismissToast(toast), 5000);
  }

  function dismissToast(toast) {
    if (toast.classList.contains("toast-out")) return;
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove());
  }

  // ── Utilities ──────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Boot ───────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);
})();
