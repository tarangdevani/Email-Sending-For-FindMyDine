/* ═══════════════════════════════════════════════════════════
   Email Send — Client Application
   ═══════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  // ── DOM References ──────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    // Tabs
    tabCompose: $("#tab-compose"),
    tabHistory: $("#tab-history"),
    composeTab: $("#composeTab"),
    historyTab: $("#historyTab"),
    historyBadge: $("#historyBadge"),

    // Header
    senderEmail: $("#senderEmail"),

    // Recipient Form
    recipientBtns: $$(".recipient-btn"),
    manualInputSection: $("#manualInputSection"),
    databaseInputSection: $("#databaseInputSection"),
    manualEmails: $("#manualEmails"),
    firestorePath: $("#firestorePath"),
    batchOptionsSection: $("#batchOptionsSection"),
    batchStartTime: $("#batchStartTime"),
    batchDailyLimit: $("#batchDailyLimit"),

    // Form
    form: $("#emailForm"),
    cc: $("#emailCc"),
    bcc: $("#emailBcc"),
    replyTo: $("#emailReplyTo"),
    subject: $("#emailSubject"),
    body: $("#emailBody"),
    bodyModeHint: $("#bodyModeHint"),

    // Toggles
    toggleCcBcc: $("#toggleCcBcc"),
    toggleReplyTo: $("#toggleReplyTo"),
    ccBccFields: $("#ccBccFields"),
    replyToField: $("#replyToField"),

    // Files
    fileInput: $("#fileInput"),
    fileDropArea: $("#fileDropArea"),
    attachedFiles: $("#attachedFiles"),

    // Buttons
    btnSend: $("#btnSend"),
    btnClear: $("#btnClear"),

    // History
    emailList: $("#emailList"),
    historyCount: $("#historyCount"),

    // Bulk Modal
    bulkOverlay: $("#bulkOverlay"),
    bulkTotal: $("#bulkTotal"),
    bulkSent: $("#bulkSent"),
    bulkErrors: $("#bulkErrors"),
    bulkProgressFill: $("#bulkProgressFill"),
    bulkLogs: $("#bulkLogs"),
    btnBulkStop: $("#btnBulkStop"),
    btnBulkClose: $("#btnBulkClose"),

    // Toast
    toastContainer: $("#toastContainer"),
  };

  // ── State ───────────────────────────────────────────────
  let bodyMode = "text"; // "text" or "html"
  let attachedFiles = [];
  let emailCount = 0;
  let sendMethod = "manual"; // "manual" or "database"
  let bulkPollInterval = null;

  // ── Init ────────────────────────────────────────────────
  function init() {
    setupTabs();
    setupToggles();
    setupRecipientToggle();
    setupBodyToggle();
    setupFileUpload();
    setupForm();
    setupBulkModal();
    loadConfig();
    loadHistory();
    startServerClock();
  }

  // ── Server Clock ───────────────────────────────────────
  function startServerClock() {
    const clockEl = document.getElementById("serverClock");
    if (!clockEl) return;

    let serverOffset = 0; // ms difference between server and local

    async function syncServerTime() {
      try {
        const res = await fetch("/api/server-time");
        const data = await res.json();
        const serverTime = new Date(data.iso).getTime();
        serverOffset = serverTime - Date.now();
        clockEl.title = `Server timezone: ${data.timezone}`;
      } catch (e) { /* ignore */ }
    }

    function tick() {
      const serverNow = new Date(Date.now() + serverOffset);
      const h = String(serverNow.getHours()).padStart(2, "0");
      const m = String(serverNow.getMinutes()).padStart(2, "0");
      const s = String(serverNow.getSeconds()).padStart(2, "0");
      clockEl.textContent = `🖥 Server: ${h}:${m}:${s}`;
    }

    syncServerTime().then(tick);
    setInterval(tick, 1000);
    setInterval(syncServerTime, 60000); // Re-sync every minute
  }

  // ── Tab Navigation ──────────────────────────────────────
  function setupTabs() {
    $$(".nav-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".nav-tab").forEach((t) => t.classList.remove("active"));
        $$(".tab-content").forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        const target = tab.dataset.tab;
        $(`#${target}Tab`).classList.add("active");

        if (target === "history") {
          loadHistory();
        }
      });
    });
  }

  // ── Toggle CC/BCC & Reply-To ────────────────────────────
  function setupToggles() {
    els.toggleCcBcc.addEventListener("click", () => {
      els.toggleCcBcc.classList.toggle("active");
      els.ccBccFields.classList.toggle("show");
      if (!els.ccBccFields.classList.contains("show")) {
        els.cc.value = "";
        els.bcc.value = "";
      }
    });

    els.toggleReplyTo.addEventListener("click", () => {
      els.toggleReplyTo.classList.toggle("active");
      els.replyToField.classList.toggle("show");
      if (!els.replyToField.classList.contains("show")) {
        els.replyTo.value = "";
      }
    });
  }

  // ── Recipient Toggle ──────────────────────────────────────
  function setupRecipientToggle() {
    els.recipientBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        els.recipientBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        sendMethod = btn.dataset.method;

        if (sendMethod === "manual") {
          els.manualInputSection.style.display = "block";
          els.databaseInputSection.style.display = "none";
          // Fix required attribute
          els.manualEmails.required = true;
          els.firestorePath.required = false;
        } else {
          els.manualInputSection.style.display = "none";
          els.databaseInputSection.style.display = "block";
          els.manualEmails.required = false;
          els.firestorePath.required = true;
        }
      });
    });
  }

  // ── Body Mode Toggle (Text / HTML) ──────────────────────
  function setupBodyToggle() {
    $$(".body-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".body-toggle-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        bodyMode = btn.dataset.mode;

        if (bodyMode === "html") {
          els.body.placeholder = "<h1>Hello!</h1>\n<p>Your HTML email content here...</p>";
          els.bodyModeHint.textContent = "Sending as HTML — use valid HTML markup";
        } else {
          els.body.placeholder = "Type your message here...";
          els.bodyModeHint.textContent = "Sending as plain text";
        }
      });
    });
  }

  // ── File Upload ─────────────────────────────────────────
  function setupFileUpload() {
    // Click to select files
    els.fileInput.addEventListener("change", (e) => {
      addFiles(e.target.files);
      els.fileInput.value = ""; // reset so same file can be added again
    });

    // Drag & drop
    els.fileDropArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      els.fileDropArea.classList.add("dragover");
    });

    els.fileDropArea.addEventListener("dragleave", () => {
      els.fileDropArea.classList.remove("dragover");
    });

    els.fileDropArea.addEventListener("drop", (e) => {
      e.preventDefault();
      els.fileDropArea.classList.remove("dragover");
      addFiles(e.dataTransfer.files);
    });
  }

  function addFiles(fileList) {
    for (const file of fileList) {
      if (attachedFiles.length >= 5) {
        showToast("Maximum 5 attachments allowed", "error");
        break;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast(`${file.name} exceeds 10MB limit`, "error");
        continue;
      }
      // Avoid duplicates
      if (attachedFiles.some((f) => f.name === file.name && f.size === file.size)) {
        continue;
      }
      attachedFiles.push(file);
    }
    renderAttachedFiles();
  }

  function renderAttachedFiles() {
    els.attachedFiles.innerHTML = attachedFiles
      .map(
        (file, i) => `
      <div class="attached-file">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-size">(${formatFileSize(file.size)})</span>
        <button type="button" class="remove-file" data-index="${i}" title="Remove">&times;</button>
      </div>
    `
      )
      .join("");

    // Remove file buttons
    $$(".remove-file").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index);
        attachedFiles.splice(idx, 1);
        renderAttachedFiles();
      });
    });
  }

  // ── Form Submit ─────────────────────────────────────────
  function setupForm() {
    els.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await sendEmail();
    });

    els.btnClear.addEventListener("click", clearForm);
  }

  async function sendEmail() {
    // Validate
    const subject = els.subject.value.trim();
    const body = els.body.value.trim();

    if (!subject) { highlightError(els.subject); return; }
    if (!body) { highlightError(els.body); return; }

    // Build FormData (for file attachments)
    const formData = new FormData();
    formData.append("sendMethod", sendMethod);
    formData.append("subject", subject);

    if (sendMethod === "manual") {
      const manualEmails = els.manualEmails.value.trim();
      if (!manualEmails) { highlightError(els.manualEmails); return; }
      formData.append("manualEmails", manualEmails);
    } else {
      const firestorePath = els.firestorePath.value.trim();
      if (!firestorePath) { highlightError(els.firestorePath); return; }
      formData.append("firestorePath", firestorePath);
    }

    // Batch schedule options (always sent)
    const startTime = els.batchStartTime.value;
    const dailyLimit = els.batchDailyLimit.value;
    if (startTime) formData.append("startTime", startTime);
    if (dailyLimit) formData.append("dailyLimit", dailyLimit);

    if (bodyMode === "html") {
      formData.append("html", body);
    } else {
      formData.append("text", body);
    }

    const cc = els.cc.value.trim();
    const bcc = els.bcc.value.trim();
    const replyTo = els.replyTo.value.trim();
    if (cc) formData.append("cc", cc);
    if (bcc) formData.append("bcc", bcc);
    if (replyTo) formData.append("replyTo", replyTo);

    for (const file of attachedFiles) {
      formData.append("attachments", file);
    }

    // UI: sending state
    els.btnSend.classList.add("sending");
    els.btnSend.querySelector(".btn-content span:last-child").textContent = "Preparing...";

    try {
      const res = await fetch("/api/send-bulk", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (data.success) {
        showToast(data.message, "success");
        clearForm();
        // Only show the bulk tracking overlay if it's NOT a scheduled batch
        // (scheduled batches run in background via cron, not immediately)
        if (!startTime && !dailyLimit) {
          startBulkTracking();
        }
      } else {
        showToast(data.message || "Failed to start bulk send", "error");
      }
    } catch (err) {
      console.error("Send error:", err);
      showToast("Network error — please try again", "error");
    } finally {
      els.btnSend.classList.remove("sending");
      els.btnSend.querySelector(".btn-content span:last-child").textContent = "Send Email";
    }
  }

  // ── Bulk Tracking Logic ─────────────────────────────────
  function startBulkTracking() {
    els.bulkOverlay.style.display = "flex";
    els.btnBulkStop.style.display = "inline-block";
    els.btnBulkClose.style.display = "none";
    els.bulkLogs.innerHTML = "";
    els.bulkTotal.textContent = "0";
    els.bulkSent.textContent = "0";
    els.bulkErrors.textContent = "0";
    els.bulkProgressFill.style.width = "0%";
    
    // Initial fetch immediately
    pollBulkStatus();
    
    // Set interval for every 1 second
    if (bulkPollInterval) clearInterval(bulkPollInterval);
    bulkPollInterval = setInterval(pollBulkStatus, 1000);
  }

  async function pollBulkStatus() {
    try {
      const res = await fetch("/api/bulk-status");
      const data = await res.json();

      els.bulkTotal.textContent = data.total;
      els.bulkSent.textContent = data.sent;
      els.bulkErrors.textContent = data.errors;

      // Calculate progress percentage
      const totalProcessed = data.sent + data.errors;
      let percentage = 0;
      if (data.total > 0) {
        percentage = (totalProcessed / data.total) * 100;
      }
      els.bulkProgressFill.style.width = `${percentage}%`;

      // Update logs
      renderBulkLogs(data.logs);

      // Check if finished
      if (!data.isRunning && data.completedAt) {
        clearInterval(bulkPollInterval);
        els.btnBulkStop.style.display = "none";
        els.btnBulkClose.style.display = "inline-block";
        showToast("Bulk sending completed", "success");
        // Also reload history in background
        loadHistory();
      }
    } catch (err) {
      console.error("Error polling bulk status:", err);
    }
  }

  function renderBulkLogs(logs) {
    if (!logs || logs.length === 0) return;
    
    const logsHtml = logs.map(l => {
      const time = new Date(l.time).toLocaleTimeString([], { hour12: false });
      return `<div class="bulk-log-item ${l.type}">[${time}] ${escapeHtml(l.message)}</div>`;
    }).join("");
    
    els.bulkLogs.innerHTML = logsHtml;
    // Auto-scroll to bottom
    els.bulkLogs.scrollTop = els.bulkLogs.scrollHeight;
  }

  function setupBulkModal() {
    els.btnBulkStop.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to stop sending emails?")) return;
      
      try {
        await fetch("/api/bulk-stop", { method: "POST" });
        showToast("Stop signal sent", "info");
      } catch (err) {
        showToast("Failed to stop", "error");
      }
    });

    els.btnBulkClose.addEventListener("click", () => {
      els.bulkOverlay.style.display = "none";
    });
  }

  function highlightError(el) {
    el.classList.add("error");
    el.focus();
    el.addEventListener("input", () => el.classList.remove("error"), { once: true });
    showToast("Please fill in all required fields", "error");
  }

  function clearForm() {
    els.form.reset();
    attachedFiles = [];
    renderAttachedFiles();
    els.ccBccFields.classList.remove("show");
    els.replyToField.classList.remove("show");
    els.toggleCcBcc.classList.remove("active");
    els.toggleReplyTo.classList.remove("active");
    bodyMode = "text";
    $$(".body-toggle-btn").forEach((b) => b.classList.remove("active"));
    $(".body-toggle-btn[data-mode='text']").classList.add("active");
    els.body.placeholder = "Type your message here...";
    els.bodyModeHint.textContent = "Sending as plain text";

    // Reset toggles to default
    sendMethod = "manual";
    els.recipientBtns.forEach(b => b.classList.remove("active"));
    els.recipientBtns[0].classList.add("active");
    els.manualInputSection.style.display = "block";
    els.databaseInputSection.style.display = "none";
    els.manualEmails.required = true;
    els.firestorePath.required = false;
  }

  // ── Load Config ─────────────────────────────────────────
  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      els.senderEmail.textContent = data.senderEmail || "Not configured";
    } catch {
      els.senderEmail.textContent = "Disconnected";
    }
  }

  // ── Load History ────────────────────────────────────────
  async function loadHistory() {
    try {
      const res = await fetch("/api/emails");
      const data = await res.json();

      emailCount = data.count || 0;
      updateHistoryBadge();
      els.historyCount.textContent = `${emailCount} email${emailCount !== 1 ? "s" : ""} sent`;

      if (data.emails.length === 0) {
        els.emailList.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <h3>No emails sent yet</h3>
            <p>Compose and send your first email to see it here</p>
          </div>
        `;
        return;
      }

      els.emailList.innerHTML = `
        <div class="email-list">
          ${data.emails.map(renderEmailCard).join("")}
        </div>
      `;
    } catch {
      els.emailList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h3>Could not load history</h3>
          <p>Unable to connect to the server</p>
        </div>
      `;
    }
  }

  function renderEmailCard(email) {
    const date = new Date(email.sentAt);
    const timeStr = date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const statusClass = email.status === "sent" ? "sent" : "failed";
    const statusIcon = email.status === "sent" ? "✅" : "❌";
    const statusLabel = email.status === "sent" ? "Sent" : "Failed";

    let bodyPreview = email.body || "";
    // Strip HTML tags for preview
    if (email.isHtml) {
      bodyPreview = bodyPreview.replace(/<[^>]*>/g, "").trim();
    }
    if (bodyPreview.length > 140) {
      bodyPreview = bodyPreview.substring(0, 140) + "...";
    }

    let attachmentsHtml = "";
    if (email.attachmentNames && email.attachmentNames.length > 0) {
      attachmentsHtml = `
        <div class="email-card-attachments">
          ${email.attachmentNames.map((name) => `<span class="email-card-attachment">📎 ${escapeHtml(name)}</span>`).join("")}
        </div>
      `;
    }

    let ccInfo = "";
    if (email.cc) ccInfo += `<br><span style="color:var(--text-muted)">CC:</span> <span>${escapeHtml(email.cc)}</span>`;
    if (email.bcc) ccInfo += `<br><span style="color:var(--text-muted)">BCC:</span> <span>${escapeHtml(email.bcc)}</span>`;

    return `
      <div class="email-card">
        <div class="email-card-top">
          <div>
            <div class="email-card-subject">${escapeHtml(email.subject)}</div>
            <div class="email-card-to">
              To: <span>${escapeHtml(email.to)}</span>${ccInfo}
            </div>
          </div>
          <div class="email-card-meta">
            <span class="email-card-time">${timeStr}</span>
            <span class="email-card-status ${statusClass}">${statusIcon} ${statusLabel}</span>
          </div>
        </div>
        <div class="email-card-body">${escapeHtml(bodyPreview)}</div>
        ${attachmentsHtml}
      </div>
    `;
  }

  function updateHistoryBadge() {
    if (emailCount > 0) {
      els.historyBadge.textContent = emailCount;
      els.historyBadge.style.display = "inline";
    } else {
      els.historyBadge.style.display = "none";
    }
  }

  // ── Toast Notifications ─────────────────────────────────
  function showToast(message, type = "info") {
    const icons = {
      success: "✅",
      error: "❌",
      info: "ℹ️",
    };

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <span>${escapeHtml(message)}</span>
      <button class="toast-close" title="Close">&times;</button>
    `;

    els.toastContainer.appendChild(toast);

    // Close button
    toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));

    // Auto-dismiss
    setTimeout(() => dismissToast(toast), 5000);
  }

  function dismissToast(toast) {
    if (toast.classList.contains("toast-out")) return;
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove());
  }

  // ── Utilities ───────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  // ── Boot ────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", init);
})();
