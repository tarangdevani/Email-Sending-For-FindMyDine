/* ═══════════════════════════════════════════════════════════
   FindMyDine — Email Campaign Manager Client
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

    // Provider Toggle
    providerBtns: $$(".provider-btn"),

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
    btnLogout: $("#btnLogout"),

    // History (Batch Listing)
    batchListContainer: $("#batchListContainer"),
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

    // Detail Modal
    detailOverlay: $("#detailOverlay"),

    // HTML Preview
    htmlPreviewSection: $("#htmlPreviewSection"),
    btnPreviewHtml: $("#btnPreviewHtml"),
    htmlPreviewContainer: $("#htmlPreviewContainer"),
    htmlPreviewFrame: $("#htmlPreviewFrame"),

    // Analytics
    statTotalEmails: $("#statTotalEmails"),
    statTotalSent: $("#statTotalSent"),
    statTotalBounced: $("#statTotalBounced"),
    statGmailSent: $("#statGmailSent"),
    statAwsSent: $("#statAwsSent"),
    statBrevoSent: $("#statBrevoSent"),
    analyticsChart: $("#analyticsChart"),

    // Toast
    toastContainer: $("#toastContainer"),
  };

  // ── State ───────────────────────────────────────────────
  let bodyMode = "text";
  let attachedFiles = [];
  let sendMethod = "manual";
  let selectedProvider = "gmail";
  let bulkPollInterval = null;
  let analyticsChartInstance = null;
  let currentPeriod = "day";
  let currentProviderFilter = "all";

  // Pagination state
  let currentBatchCursor = null;
  let hasMoreBatches = true;
  let isLoadingBatches = false;

  // ── Init ────────────────────────────────────────────────
  function init() {
    setupTabs();
    setupToggles();
    setupRecipientToggle();
    setupProviderToggle();
    setupBodyToggle();
    setupFileUpload();
    setupForm();
    setupBulkModal();
    setupLogout();
    setupHtmlPreview();
    setupAnalyticsFilters();
    loadConfig();
    startServerClock();
    loadAnalytics();
  }

  // ── Server Clock ───────────────────────────────────────
  function startServerClock() {
    const clockEl = document.getElementById("serverClock");
    if (!clockEl) return;
    let serverOffset = 0;
    let serverTimezone = "UTC";
    let synced = false;

    clockEl.textContent = "🖥 Syncing...";

    async function syncServerTime() {
      try {
        const res = await fetch("/api/server-time");
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        const data = await res.json();
        // data.iso is always UTC (ISO 8601), so we calculate exact offset
        const serverTime = new Date(data.iso).getTime();
        serverOffset = serverTime - Date.now();
        serverTimezone = data.timezone || "UTC";
        clockEl.title = `Server timezone: ${serverTimezone}`;
        synced = true;
      } catch (e) {
        clockEl.textContent = "🖥 Server: N/A";
      }
    }

    function tick() {
      if (!synced) return; // wait for first sync
      // serverNow is the true server-local timestamp
      const serverNow = new Date(Date.now() + serverOffset);
      // Use UTC methods because the offset already accounts for the server's timezone
      // relative to UTC. The server sends its ISO (UTC) timestamp, so:
      //   serverOffset = serverUTC_ms - browserUTC_ms
      // serverNow = browser UTC + offset = server UTC
      // So UTC methods here give server's actual UTC clock time.
      const h = String(serverNow.getUTCHours()).padStart(2, "0");
      const m = String(serverNow.getUTCMinutes()).padStart(2, "0");
      const s = String(serverNow.getUTCSeconds()).padStart(2, "0");
      clockEl.textContent = `🖥 Server: ${h}:${m}:${s} (UTC)`;
    }

    syncServerTime().then(tick);
    setInterval(tick, 1000);
    setInterval(syncServerTime, 60000);
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
          loadBatches(true);
        }
      });
    });

    // Infinite scroll for History tab
    window.addEventListener("scroll", () => {
      // Load more if user is near bottom of the page
      if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 200) {
        if (els.historyTab.classList.contains("active")) {
          loadBatches(false);
        }
      }
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
          els.htmlPreviewSection.style.display = "block";
        } else {
          els.body.placeholder = "Type your message here...";
          els.bodyModeHint.textContent = "Sending as plain text";
          els.htmlPreviewSection.style.display = "none";
          els.htmlPreviewContainer.style.display = "none";
        }
      });
    });
  }

  // ── HTML Preview ────────────────────────────────────────
  function setupHtmlPreview() {
    if (!els.btnPreviewHtml) return;
    els.btnPreviewHtml.addEventListener("click", () => {
      const htmlContent = els.body.value.trim();
      if (!htmlContent) {
        showToast("Enter HTML content first", "error");
        return;
      }
      els.htmlPreviewContainer.style.display = "block";
      const doc = els.htmlPreviewFrame.contentDocument || els.htmlPreviewFrame.contentWindow.document;
      doc.open();
      doc.write(htmlContent);
      doc.close();
    });
  }

  // ── Logout ─────────────────────────────────────────────
  function setupLogout() {
    if (!els.btnLogout) return;
    els.btnLogout.addEventListener("click", async () => {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch (e) { /* ignore */ }
      window.location.href = "/login.html";
    });
  }

  // ── File Upload ─────────────────────────────────────────
  function setupFileUpload() {
    els.fileInput.addEventListener("change", (e) => {
      addFiles(e.target.files);
      els.fileInput.value = "";
    });
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
      if (attachedFiles.length >= 5) { showToast("Maximum 5 attachments allowed", "error"); break; }
      if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} exceeds 10MB limit`, "error"); continue; }
      if (attachedFiles.some((f) => f.name === file.name && f.size === file.size)) continue;
      attachedFiles.push(file);
    }
    renderAttachedFiles();
  }

  function renderAttachedFiles() {
    els.attachedFiles.innerHTML = attachedFiles.map((file, i) => `
      <div class="attached-file">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
        <span class="file-size">(${formatFileSize(file.size)})</span>
        <button type="button" class="remove-file" data-index="${i}" title="Remove">&times;</button>
      </div>
    `).join("");
    $$(".remove-file").forEach((btn) => {
      btn.addEventListener("click", () => {
        attachedFiles.splice(parseInt(btn.dataset.index), 1);
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
    const subject = els.subject.value.trim();
    const body = els.body.value.trim();
    if (!subject) { highlightError(els.subject); return; }
    if (!body) { highlightError(els.body); return; }

    const formData = new FormData();
    formData.append("sendMethod", sendMethod);
    formData.append("provider", selectedProvider);
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
    for (const file of attachedFiles) formData.append("attachments", file);

    els.btnSend.classList.add("sending");
    els.btnSend.querySelector(".btn-content span:last-child").textContent = "Preparing...";

    try {
      const res = await fetch("/api/send-bulk", { method: "POST", body: formData });
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await res.json();
      if (data.success) {
        showToast(data.message, "success");
        clearForm();
        if (!startTime && !dailyLimit) startBulkTracking();
      } else {
        showToast(data.message || "Failed to start bulk send", "error");
      }
    } catch (err) {
      showToast("Network error — please try again", "error");
    } finally {
      els.btnSend.classList.remove("sending");
      els.btnSend.querySelector(".btn-content span:last-child").textContent = "Send Email";
    }
  }

  // ── Bulk Tracking ─────────────────────────────────────
  function startBulkTracking() {
    els.bulkOverlay.style.display = "flex";
    els.btnBulkStop.style.display = "inline-block";
    els.btnBulkClose.style.display = "none";
    els.bulkLogs.innerHTML = "";
    els.bulkTotal.textContent = "0";
    els.bulkSent.textContent = "0";
    els.bulkErrors.textContent = "0";
    els.bulkProgressFill.style.width = "0%";
    pollBulkStatus();
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
      const totalProcessed = data.sent + data.errors;
      let pct = data.total > 0 ? (totalProcessed / data.total) * 100 : 0;
      els.bulkProgressFill.style.width = `${pct}%`;
      renderBulkLogs(data.logs);
      if (!data.isRunning && data.completedAt) {
        clearInterval(bulkPollInterval);
        els.btnBulkStop.style.display = "none";
        els.btnBulkClose.style.display = "inline-block";
        showToast("Bulk sending completed", "success");
      }
    } catch (err) { /* ignore */ }
  }

  function renderBulkLogs(logs) {
    if (!logs || logs.length === 0) return;
    els.bulkLogs.innerHTML = logs.map(l => {
      const time = new Date(l.time).toLocaleTimeString([], { hour12: false });
      return `<div class="bulk-log-item ${l.type}">[${time}] ${escapeHtml(l.message)}</div>`;
    }).join("");
    els.bulkLogs.scrollTop = els.bulkLogs.scrollHeight;
  }

  function setupBulkModal() {
    els.btnBulkStop.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to stop sending emails?")) return;
      try { await fetch("/api/bulk-stop", { method: "POST" }); showToast("Stop signal sent", "info"); }
      catch (err) { showToast("Failed to stop", "error"); }
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
    els.htmlPreviewSection.style.display = "none";
    els.htmlPreviewContainer.style.display = "none";
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
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await res.json();
      els.senderEmail.textContent = data.senderEmail || "Not configured";
    } catch {
      els.senderEmail.textContent = "Disconnected";
    }
  }

  // ── Load Batches (Sent History) ─────────────────────────
  async function loadBatches(reset = true) {
    if (isLoadingBatches || (!reset && !hasMoreBatches)) return;
    isLoadingBatches = true;

    if (reset) {
      currentBatchCursor = null;
      hasMoreBatches = true;
      els.batchListContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Loading batches...</div>';
      els.historyCount.textContent = "Loading...";
    }

    try {
      let url = "/api/batches?limit=10";
      if (currentBatchCursor) {
        url += `&startAfter=${encodeURIComponent(currentBatchCursor)}`;
      }

      const res = await fetch(url);
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await res.json();
      
      isLoadingBatches = false;

      if (reset && (!data.success || !data.batches || data.batches.length === 0)) {
        els.historyCount.textContent = "0 batches";
        els.batchListContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <h3>No batches yet</h3>
            <p>Send your first batch to see it here</p>
          </div>`;
        return;
      }

      if (reset) {
        els.historyCount.textContent = "Batches";
        els.batchListContainer.innerHTML = `<div class="batch-list"></div>`;
      }

      const listEl = els.batchListContainer.querySelector(".batch-list");
      if (listEl && data.batches && data.batches.length > 0) {
        listEl.insertAdjacentHTML("beforeend", data.batches.map(renderBatchCard).join(""));
      }

      if (data.hasMore) {
        hasMoreBatches = true;
        currentBatchCursor = data.lastCreatedAt;
      } else {
        hasMoreBatches = false;
        if (!els.batchListContainer.querySelector(".end-of-list") && data.batches.length > 0) {
          els.batchListContainer.insertAdjacentHTML(
            "beforeend", 
            `<div class="end-of-list" style="text-align:center; padding: 20px; color: var(--text-muted); font-size: 0.9rem;">No more batches to load</div>`
          );
        }
      }

      // Attach detail button listeners (only on unbound ones)
      $$(".btn-batch-details").forEach(btn => {
        if (!btn.dataset.bound) {
          btn.addEventListener("click", () => openBatchDetail(btn.dataset.id));
          btn.dataset.bound = "true";
        }
      });
    } catch {
      isLoadingBatches = false;
      if (reset) {
        els.batchListContainer.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">⚠️</div>
            <h3>Could not load batches</h3>
            <p>Unable to connect to the server</p>
          </div>`;
      }
    }
  }

  function renderBatchCard(batch) {
    const date = batch.createdAt ? new Date(batch.createdAt).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    }) : "—";

    const statusClass = batch.status.toLowerCase();
    const statusIcons = { processing: "⚡", paused: "⏸", completed: "✅" };
    const statusIcon = statusIcons[statusClass] || "⚡";

    return `
      <div class="batch-listing-card">
        <div class="batch-listing-top">
          <div>
            <div class="batch-listing-subject">${escapeHtml(batch.subject)}</div>
            <div class="batch-listing-date">${date}</div>
          </div>
          <span class="batch-listing-status ${statusClass}">${statusIcon} ${batch.status}</span>
        </div>
        <div class="batch-listing-counters">
          <div class="batch-counter">
            <span class="batch-counter-value total">${batch.totalEmails}</span>
            <span class="batch-counter-label">Total</span>
          </div>
          <div class="batch-counter">
            <span class="batch-counter-value success">${batch.successCount}</span>
            <span class="batch-counter-label">Sent</span>
          </div>
          <div class="batch-counter">
            <span class="batch-counter-value bounce">${batch.bounceCount}</span>
            <span class="batch-counter-label">Bounced</span>
          </div>
          <div class="batch-counter">
            <span class="batch-counter-value pending">${batch.pendingCount}</span>
            <span class="batch-counter-label">Pending</span>
          </div>
        </div>
        <div class="batch-listing-footer">
          <div class="batch-listing-meta">
            <span>📊 Limit: ${batch.dailyLimit ? batch.dailyLimit + '/day' : 'None'}</span>
            <span>🔄 ${batch.sendMethod === 'database' ? 'Database' : 'Manual'}</span>
          </div>
          <button class="btn-batch-details" data-id="${batch.id}">📋 Details</button>
        </div>
      </div>`;
  }

  // ── Batch Detail Modal ──────────────────────────────────
  async function openBatchDetail(batchId) {
    els.detailOverlay.style.display = "flex";
    els.detailOverlay.innerHTML = `
      <div class="detail-modal">
        <div style="padding:60px;text-align:center;color:var(--text-muted);">Loading batch details...</div>
      </div>`;

    try {
      const res = await fetch(`/api/batches/${batchId}/details`);
      const data = await res.json();
      if (!data.success) {
        els.detailOverlay.innerHTML = `<div class="detail-modal"><div style="padding:40px;text-align:center;color:var(--accent-error-light);">Failed to load details</div></div>`;
        return;
      }

      const b = data.batch;
      const statusClass = b.status.toLowerCase();
      const statusIcons = { processing: "⚡", paused: "⏸", completed: "✅" };

      // Build pause/resume button based on current status
      let pauseResumeBtn = "";
      if (statusClass !== "completed") {
        if (statusClass === "paused") {
          pauseResumeBtn = `<button class="btn-batch-resume" id="btnPauseResume" data-action="resume" data-id="${batchId}" title="Resume this batch">▶ Resume</button>`;
        } else {
          pauseResumeBtn = `<button class="btn-batch-pause" id="btnPauseResume" data-action="pause" data-id="${batchId}" title="Pause this batch">⏸ Pause</button>`;
        }
      }

      els.detailOverlay.innerHTML = `
        <div class="detail-modal">
          <div class="detail-modal-header">
            <div>
              <div class="detail-modal-title">${escapeHtml(b.subject)}</div>
              <div class="detail-modal-subtitle">Created: ${b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'} · <span class="batch-listing-status ${statusClass}">${statusIcons[statusClass] || '⚡'} ${b.status}</span></div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              ${pauseResumeBtn}
              <button class="btn-close-modal" id="btnCloseDetail">✕</button>
            </div>
          </div>
          <div class="detail-modal-stats">
            <div class="batch-counter"><span class="batch-counter-value total">${b.totalEmails}</span><span class="batch-counter-label">Total</span></div>
            <div class="batch-counter"><span class="batch-counter-value success">${b.successCount}</span><span class="batch-counter-label">Sent</span></div>
            <div class="batch-counter"><span class="batch-counter-value bounce">${b.bounceCount}</span><span class="batch-counter-label">Bounced</span></div>
            <div class="batch-counter"><span class="batch-counter-value pending">${b.pendingCount}</span><span class="batch-counter-label">Pending</span></div>
          </div>
          <div class="detail-modal-body">
            <div class="detail-tabs" id="detailTabs">
              <button class="detail-tab active" data-filter="all">All <span class="tab-count">(${b.totalEmails})</span></button>
              <button class="detail-tab" data-filter="sent">Sent <span class="tab-count">(${b.successCount})</span></button>
              <button class="detail-tab" data-filter="bounced">Bounced <span class="tab-count">(${b.bounceCount})</span></button>
              <button class="detail-tab" data-filter="pending">Pending <span class="tab-count">(${b.pendingCount})</span></button>
            </div>
            <div class="detail-email-list" id="detailEmailList">
              ${renderDetailEmails(b.emailDetails, "all")}
            </div>
          </div>
        </div>`;

      // Close button
      $("#btnCloseDetail").addEventListener("click", () => {
        els.detailOverlay.style.display = "none";
      });

      // Pause / Resume button
      const prBtn = $("#btnPauseResume");
      if (prBtn) {
        prBtn.addEventListener("click", async () => {
          const action = prBtn.dataset.action; // "pause" or "resume"
          const confirmMsg = action === "pause"
            ? "Pause this batch? The cron job will stop immediately and resume button will restart it."
            : "Resume this batch? The cron job will pick it up within 60 seconds.";
          if (!confirm(confirmMsg)) return;

          prBtn.disabled = true;
          prBtn.textContent = action === "pause" ? "⏸ Pausing..." : "▶ Resuming...";

          try {
            const r = await fetch(`/api/batches/${batchId}/${action}`, { method: "POST" });
            const d = await r.json();
            if (d.success) {
              showToast(d.message, "success");
              // Reload the modal to reflect updated status
              openBatchDetail(batchId);
            } else {
              showToast(d.message || `Failed to ${action} batch`, "error");
              prBtn.disabled = false;
              prBtn.textContent = action === "pause" ? "⏸ Pause" : "▶ Resume";
            }
          } catch (err) {
            showToast(`Network error while trying to ${action}`, "error");
            prBtn.disabled = false;
            prBtn.textContent = action === "pause" ? "⏸ Pause" : "▶ Resume";
          }
        });
      }

      // Tab switching
      const emailDetails = b.emailDetails;
      $$("#detailTabs .detail-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          $$("#detailTabs .detail-tab").forEach(t => t.classList.remove("active"));
          tab.classList.add("active");
          $("#detailEmailList").innerHTML = renderDetailEmails(emailDetails, tab.dataset.filter);
        });
      });

    } catch (err) {
      els.detailOverlay.innerHTML = `<div class="detail-modal"><div style="padding:40px;text-align:center;color:var(--accent-error-light);">Error loading details</div></div>`;
    }

    // Close on clicking overlay background
    els.detailOverlay.addEventListener("click", (e) => {
      if (e.target === els.detailOverlay) {
        els.detailOverlay.style.display = "none";
      }
    });
  }

  function renderDetailEmails(emails, filter) {
    const filtered = filter === "all" ? emails : emails.filter(e => e.status === filter);
    if (filtered.length === 0) {
      return `<div style="text-align:center;padding:32px;color:var(--text-muted);">No ${filter} emails</div>`;
    }
    return filtered.map((e, i) => `
      <div class="detail-email-row">
        <span style="font-size:0.72rem;color:var(--text-muted);min-width:30px;text-align:center;">${i + 1}</span>
        <span class="email-addr">${escapeHtml(e.email)}</span>
        <span class="email-badge ${e.status}">${e.status}</span>
      </div>
    `).join("");
  }

  // ── Provider Toggle ────────────────────────────────────
  function setupProviderToggle() {
    els.providerBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        els.providerBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectedProvider = btn.dataset.provider;
      });
    });
  }

  // ── Analytics ─────────────────────────────────────────
  function setupAnalyticsFilters() {
    // Period filters
    $$("[data-period]").forEach(btn => {
      btn.addEventListener("click", () => {
        $$("[data-period]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentPeriod = btn.dataset.period;
        loadAnalytics();
      });
    });
    // Provider filters (only ones inside analytics section)
    $$(".analytics-filters [data-provider]").forEach(btn => {
      btn.addEventListener("click", () => {
        btn.closest(".filter-group").querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentProviderFilter = btn.dataset.provider;
        loadAnalytics();
      });
    });
  }

  async function loadAnalytics() {
    try {
      const res = await fetch(`/api/analytics?period=${currentPeriod}`);
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await res.json();
      if (!data.success) return;

      // Update summary cards
      const totals = data.totals || {};
      els.statTotalEmails.textContent = (totals.sent || 0) + (totals.bounced || 0);
      els.statTotalSent.textContent = totals.sent || 0;
      els.statTotalBounced.textContent = totals.bounced || 0;
      els.statGmailSent.textContent = totals.gmail_sent || 0;
      els.statAwsSent.textContent = totals.aws_sent || 0;
      els.statBrevoSent.textContent = totals.brevo_sent || 0;

      // Build chart datasets based on provider filter
      let sentData, bouncedData, sentLabel, bouncedLabel;
      if (currentProviderFilter === "gmail") {
        sentData = data.gmail_sent;
        bouncedData = data.gmail_bounced;
        sentLabel = "Gmail Sent";
        bouncedLabel = "Gmail Bounced";
      } else if (currentProviderFilter === "aws") {
        sentData = data.aws_sent;
        bouncedData = data.aws_bounced;
        sentLabel = "AWS Sent";
        bouncedLabel = "AWS Bounced";
      } else if (currentProviderFilter === "brevo") {
        sentData = data.brevo_sent;
        bouncedData = data.brevo_bounced;
        sentLabel = "Brevo Sent";
        bouncedLabel = "Brevo Bounced";
      } else {
        sentData = data.sent;
        bouncedData = data.bounced;
        sentLabel = "Sent";
        bouncedLabel = "Bounced";
      }

      renderAnalyticsChart(data.labels, sentData, bouncedData, sentLabel, bouncedLabel);
    } catch (err) {
      console.error("Failed to load analytics:", err);
    }
  }

  function renderAnalyticsChart(labels, sentData, bouncedData, sentLabel, bouncedLabel) {
    if (analyticsChartInstance) {
      analyticsChartInstance.destroy();
    }

    const ctx = els.analyticsChart.getContext("2d");
    analyticsChartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: sentLabel,
            data: sentData,
            backgroundColor: "rgba(16, 185, 129, 0.7)",
            borderColor: "#10b981",
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: bouncedLabel,
            data: bouncedData,
            backgroundColor: "rgba(239, 68, 68, 0.7)",
            borderColor: "#ef4444",
            borderWidth: 1,
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              font: { family: "Inter", size: 12, weight: 600 },
              color: "#4b5563",
              usePointStyle: true,
              padding: 16,
            },
          },
          tooltip: {
            backgroundColor: "#ffffff",
            titleColor: "#111827",
            bodyColor: "#4b5563",
            borderColor: "rgba(0,0,0,0.1)",
            borderWidth: 1,
            padding: 12,
            titleFont: { family: "Inter", size: 13, weight: 700 },
            bodyFont: { family: "Inter", size: 12 },
            cornerRadius: 8,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { family: "Inter", size: 11 },
              color: "#6b7280",
              maxRotation: 45,
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: "rgba(0,0,0,0.04)" },
            ticks: {
              font: { family: "Inter", size: 11 },
              color: "#6b7280",
              stepSize: 1,
            },
          },
        },
      },
    });
  }

  // ── Toast Notifications ─────────────────────────────────
  function showToast(message, type = "info") {
    const icons = { success: "✅", error: "❌", info: "ℹ️" };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type]}</span>
      <span>${escapeHtml(message)}</span>
      <button class="toast-close" title="Close">&times;</button>`;
    els.toastContainer.appendChild(toast);
    toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));
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
