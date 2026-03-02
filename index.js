const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const cheerio = require("cheerio");
const dns = require("dns");
require("dotenv").config();

// ─── Firebase Admin Setup (Lazy Init) ──────────────────────
const admin = require("firebase-admin");

let db = null;
let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return db;
  
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      }),
    });
    db = admin.firestore();
    firebaseInitialized = true;
    console.log("✅ Firebase Admin initialized successfully");
    return db;
  } catch (err) {
    console.error("❌ Firebase init failed:", err.message);
    throw new Error("Firebase initialization failed. Please check your .env credentials: " + err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Multer setup for file attachments (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit per file
});

// In-memory email history
const emailHistory = [];

// ─── Scraper State ────────────────────────────────────────
let scraperState = {
  isRunning: false,
  shouldStop: false,
  processed: 0,
  total: 0,
  foundEmails: [],
  foundMobiles: [],
  currentBusiness: "",
  errors: [],
  logs: [],
  startedAt: null,
  completedAt: null,
  countryName: "",
  stateName: "",
  firestorePath: "",
};

function resetScraperState() {
  scraperState = {
    isRunning: false,
    shouldStop: false,
    processed: 0,
    total: 0,
    foundEmails: [],
    foundMobiles: [],
    currentBusiness: "",
    errors: [],
    logs: [],
    startedAt: null,
    completedAt: null,
    countryName: "",
    stateName: "",
    firestorePath: "",
  };
}

function addLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString(),
    message,
    type, // info, success, error, warning
  };
  scraperState.logs.push(entry);
  // Keep only last 200 logs
  if (scraperState.logs.length > 200) {
    scraperState.logs = scraperState.logs.slice(-200);
  }
}

// ─── Email Extraction Helpers ─────────────────────────────
function extractEmailsFromHtml(html) {
  const emails = new Set();

  // Regex for email addresses
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // Search raw HTML
  const rawMatches = html.match(emailRegex) || [];
  rawMatches.forEach((e) => emails.add(e.toLowerCase()));

  // Also parse with cheerio to find mailto links and text content
  try {
    const $ = cheerio.load(html);

    // Find mailto: links
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const email = href.replace("mailto:", "").split("?")[0].trim();
        if (emailRegex.test(email)) {
          emails.add(email.toLowerCase());
        }
      }
    });

    // Search visible text
    const textContent = $("body").text();
    const textMatches = textContent.match(emailRegex) || [];
    textMatches.forEach((e) => emails.add(e.toLowerCase()));
  } catch (err) {
    // If cheerio parsing fails, we still have regex results
  }

  // Filter out common false positives
  const blacklistKeywords = ["wixpress", "yourmail", "sentry"];
  const filtered = [...emails].filter((email) => {
    const lower = email.toLowerCase();
    // Exclude image/asset file extensions mistakenly matched
    if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf|ico)$/i.test(lower)) return false;
    // Exclude common placeholder emails
    if (lower.includes("example.com") || lower.includes("yoursite") || lower.includes("domain.com")) return false;
    // Exclude blacklisted keywords
    if (blacklistKeywords.some((kw) => lower.includes(kw))) return false;
    // Exclude very long strings (likely not real emails)
    if (lower.length > 60) return false;
    return true;
  });

  // Substring deduplication: if email A is fully contained in email B, remove B
  const deduped = filtered.filter((email, idx) => {
    for (let i = 0; i < filtered.length; i++) {
      if (i === idx) continue;
      // If another (shorter or equal) email is fully contained in this email, this one is the "wrong" longer version
      if (email.length > filtered[i].length && email.includes(filtered[i])) {
        return false;
      }
    }
    return true;
  });

  return deduped;
}

// ─── Mobile Number Extraction (Accurate) ──────────────────
function extractMobileNumbersFromHtml(html) {
  const rawText = typeof html === "string" ? html : String(html);
  const numbers = new Set();

  // ── Source 1: tel: links (most reliable — these ARE phone numbers) ──
  try {
    const $ = cheerio.load(rawText);
    $('a[href^="tel:"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      // Strip "tel:" prefix and clean
      const cleaned = href.replace(/^tel:\s*/i, "").replace(/[^0-9+]/g, "");
      const digits = cleaned.replace(/\D/g, "");

      // Handle +1XXXXXXXXXX or 1XXXXXXXXXX or XXXXXXXXXX
      let tenDigit = null;
      if (digits.length === 11 && digits.startsWith("1")) {
        tenDigit = digits.substring(1);
      } else if (digits.length === 10) {
        tenDigit = digits;
      }

      if (tenDigit) numbers.add(tenDigit);
    });
  } catch (err) {
    // Ignore cheerio errors
  }

  // ── Source 2: Visible text near phone-related keywords ──
  // Only search VISIBLE text content, NOT raw HTML (avoids CSS, JS numbers)
  try {
    const $ = cheerio.load(rawText);

    // Remove script, style, noscript tags to get clean text
    $("script, style, noscript, svg, head").remove();
    const textContent = $("body").text();

    // Phone keywords that indicate a nearby number is a phone number
    const phoneKeywords = /(?:phone|call|tel|mobile|cell|whatsapp|wa|contact\s*us|reach\s*us|dial|sms|text\s*us)/i;

    // Split text into lines and check each line for phone context
    const lines = textContent.split(/\n/);

    for (const line of lines) {
      // Only process lines that contain a phone-related keyword
      if (!phoneKeywords.test(line)) continue;

      // Match properly FORMATTED phone numbers (must have separators)
      // This avoids matching random digit sequences like zip codes, prices, IDs
      const formattedPhoneRegex = /(?:\+?1[-.\s]?)?\((\d{3})\)[-.\s]?(\d{3})[-.\s](\d{4})|(?:\+?1[-.\s]?)?(\d{3})[-.](\d{3})[-.](\d{4})/g;

      let match;
      while ((match = formattedPhoneRegex.exec(line)) !== null) {
        const areaCode = match[1] || match[4];
        const prefix = match[2] || match[5];
        const lineNum = match[3] || match[6];
        if (areaCode && prefix && lineNum) {
          numbers.add(`${areaCode}${prefix}${lineNum}`);
        }
      }
    }
  } catch (err) {
    // Ignore errors
  }

  // ── Filter out non-mobile numbers ──
  const tollFreeAreaCodes = ["800", "888", "877", "866", "855", "844", "833"];
  const premiumAreaCodes = ["900", "976"];

  const filtered = [...numbers].filter((num) => {
    if (num.length !== 10) return false;
    const areaCode = num.substring(0, 3);

    // Area code can't start with 0 or 1 (NANP rules)
    if (areaCode.startsWith("0") || areaCode.startsWith("1")) return false;
    // Prefix (middle 3 digits) can't start with 0 or 1
    if (num[3] === "0" || num[3] === "1") return false;
    // Exclude toll-free numbers (not mobile)
    if (tollFreeAreaCodes.includes(areaCode)) return false;
    // Exclude premium-rate numbers (not mobile)
    if (premiumAreaCodes.includes(areaCode)) return false;
    // Exclude 555 test numbers
    if (num.substring(3, 6) === "555") return false;

    return true;
  });

  // Limit to max 3 per website (a real business rarely has more than 3 phone numbers)
  const limited = filtered.slice(0, 3);

  // Format as +1XXXXXXXXXX for WhatsApp compatibility
  return [...new Set(limited.map((n) => `+1${n}`))];
}

function isValidUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim().toLowerCase();
  if (trimmed === "n/a" || trimmed === "na" || trimmed === "" || trimmed === "null" || trimmed === "undefined") return false;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchWebsite(url) {
  const targetUrl = url.startsWith("http") ? url : `https://${url}`;
  const response = await axios.get(targetUrl, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    validateStatus: (status) => status < 400,
  });
  return response.data;
}

// ─── MX Record Validation Helper ──────────────────────────
const mxDomainCache = new Map();

function checkMxRecord(domain) {
  return new Promise((resolve) => {
    const lower = domain.toLowerCase();
    if (mxDomainCache.has(lower)) {
      resolve(mxDomainCache.get(lower));
      return;
    }
    dns.resolveMx(lower, (err, addresses) => {
      const valid = !err && addresses && addresses.length > 0;
      mxDomainCache.set(lower, valid);
      resolve(valid);
    });
  });
}

async function validateEmailsMx(emails) {
  const results = [];
  for (const email of emails) {
    const parts = email.split("@");
    if (parts.length !== 2 || !parts[1]) {
      results.push({ email, valid: false, reason: "Invalid format" });
      continue;
    }
    const hasMx = await checkMxRecord(parts[1]);
    results.push({
      email,
      valid: hasMx,
      reason: hasMx ? "MX records found" : "No MX records",
    });
  }
  return results;
}

// ─── Core Scraping Logic ──────────────────────────────────
async function runScraper(firestorePath, forceRescrap = false) {
  scraperState.isRunning = true;
  scraperState.shouldStop = false;
  scraperState.startedAt = new Date().toISOString();
  scraperState.firestorePath = firestorePath;

  addLog(`🚀 Starting scraper for path: ${firestorePath}${forceRescrap ? " (Forced Rescrap)" : ""}`, "info");

  try {
    // Initialize Firebase lazily
    const firestore = initFirebase();

    // Read the state document
    const stateDocRef = firestore.doc(firestorePath);
    const stateDoc = await stateDocRef.get();

    if (!stateDoc.exists) {
      addLog(`❌ Document not found at path: ${firestorePath}`, "error");
      scraperState.isRunning = false;
      return;
    }

    const stateData = stateDoc.data();
    scraperState.countryName = stateData.country || firestorePath.split("/")[1] || "Unknown";
    scraperState.stateName = stateData.state || firestorePath.split("/")[3] || "Unknown";

    addLog(`📍 Country: ${scraperState.countryName}, State: ${scraperState.stateName}`, "info");

    // Setup local files
    const emailFileName = `${scraperState.countryName}_${scraperState.stateName}.txt`;
    const emailFilePath = path.join(__dirname, emailFileName);
    const mobileFileName = `${scraperState.countryName}_${scraperState.stateName}_mo_no.txt`;
    const mobileFilePath = path.join(__dirname, mobileFileName);

    // Reference to restaurants collection
    const restaurantsRef = stateDocRef.collection("restaurants");

    // Count total records
    const totalAllSnapshot = await restaurantsRef.count().get();
    const totalAll = totalAllSnapshot.data().count;

    let totalToProcess = totalAll;

    if (!forceRescrap) {
      // Count already scraped records
      const scrapedSnapshot = await restaurantsRef.where("scraped", "==", true).count().get();
      const scrapedCount = scrapedSnapshot.data().count;
      totalToProcess = totalAll - scrapedCount;
      addLog(`📊 Total records: ${totalAll}, Already scraped: ${scrapedCount}, Remaining: ${totalToProcess}`, "info");
    } else {
      addLog(`📊 Total records: ${totalAll}. Forcing rescrap for all records.`, "info");
    }

    scraperState.total = totalToProcess;

    if (scraperState.total === 0) {
      addLog("✅ No unscraped records found. All done!", "success");
      scraperState.isRunning = false;
      scraperState.completedAt = new Date().toISOString();
      return;
    }

    // ─── Process a single record (used in parallel) ────
    async function processRecord(doc) {
      const data = doc.data();

      // Skip if already scraped AND not forcing rescrap
      if (data.scraped === true && !forceRescrap) return;

      const businessName = data.businessName || "Unknown";
      const website = data.website || "";

      scraperState.processed++;
      const recordNum = scraperState.processed;

      addLog(`🔍 [${recordNum}/${scraperState.total}] ${businessName}`, "info");

      // Check if website is valid
      if (!isValidUrl(website)) {
        addLog(`   ⚠️ Invalid/missing website: "${website}" — skipping`, "warning");
        await doc.ref.update({ scraped: true });
        return;
      }

      try {
        // Fetch website HTML
        const html = await fetchWebsite(website);
        const htmlStr = typeof html === "string" ? html : String(html);

        // ── Extract & validate emails ──
        const rawEmails = extractEmailsFromHtml(htmlStr);
        let validEmails = [];

        if (rawEmails.length > 0) {
          const mxResults = await validateEmailsMx(rawEmails);
          validEmails = mxResults.filter((r) => r.valid).map((r) => r.email);
          const invalidEmails = mxResults.filter((r) => !r.valid);

          if (invalidEmails.length > 0) {
            addLog(`   🚫 [${businessName}] Removed ${invalidEmails.length} invalid email(s)`, "warning");
          }
        }

        // ── Extract & validate mobile numbers ──
        const mobileNumbers = extractMobileNumbersFromHtml(htmlStr);

        // ── Build Firestore update ──
        const updateData = { scraped: true };

        if (validEmails.length > 0) {
          updateData.email = validEmails.join(", ");
          addLog(`   ✅ [${businessName}] ${validEmails.length} valid email(s): ${validEmails.join(", ")}`, "success");
        }

        if (mobileNumbers.length > 0) {
          updateData.wa_no = mobileNumbers.join(", ");
          addLog(`   📱 [${businessName}] ${mobileNumbers.length} mobile(s): ${mobileNumbers.join(", ")}`, "success");
        }

        if (validEmails.length === 0 && mobileNumbers.length === 0) {
          addLog(`   📭 [${businessName}] No emails or mobiles found`, "info");
        }

        await doc.ref.update(updateData);

        // ── Collect results ──
        return { validEmails, mobileNumbers, businessName };
      } catch (fetchErr) {
        const errMsg = fetchErr.message || String(fetchErr);
        addLog(`   ❌ [${businessName}] Error: ${errMsg}`, "error");
        scraperState.errors.push({ business: businessName, website, error: errMsg });
        await doc.ref.update({ scraped: true });
        return null;
      }
    }

    // ─── Process in parallel batches of 100 ────────────
    let lastDoc = null;
    let batchNumber = 0;

    while (!scraperState.shouldStop) {
      batchNumber++;
      addLog(`\n📦 Processing batch #${batchNumber} (100 records in parallel)...`, "info");

      // Fetch 100 docs at a time
      let query = restaurantsRef.orderBy("businessName").limit(100);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();

      if (snapshot.empty) {
        addLog("✅ No more records to process. Scraping complete!", "success");
        break;
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      // Filter out already scraped docs if not forcing rescrap
      const unscrapedDocs = forceRescrap 
        ? snapshot.docs 
        : snapshot.docs.filter((d) => d.data().scraped !== true);

      if (unscrapedDocs.length === 0) {
        addLog(`   ⏭️ All ${snapshot.docs.length} records already scraped, moving to next batch...`, "info");
        continue;
      }

      addLog(`   🔁 Processing ${unscrapedDocs.length} ${forceRescrap ? 'records' : 'unscraped records'} in parallel...`, "info");

      // Process all records in parallel
      const results = await Promise.allSettled(
        unscrapedDocs.map((doc) => processRecord(doc))
      );

      // Collect emails and mobiles from successful results
      let batchEmails = [];
      let batchMobiles = [];

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          batchEmails.push(...result.value.validEmails);
          batchMobiles.push(...result.value.mobileNumbers);
        }
      }

      // Add to global lists (avoid duplicates)
      for (const email of batchEmails) {
        if (!scraperState.foundEmails.includes(email)) {
          scraperState.foundEmails.push(email);
        }
      }
      for (const mobile of batchMobiles) {
        if (!scraperState.foundMobiles.includes(mobile)) {
          scraperState.foundMobiles.push(mobile);
        }
      }

      // Append to local files
      if (batchEmails.length > 0) {
        fs.appendFileSync(emailFilePath, batchEmails.join(", ") + ", ", "utf-8");
      }
      if (batchMobiles.length > 0) {
        fs.appendFileSync(mobileFilePath, batchMobiles.join(", ") + ", ", "utf-8");
      }

      addLog(`   📊 Batch #${batchNumber} done: ${batchEmails.length} emails, ${batchMobiles.length} mobiles`, "success");

      if (scraperState.shouldStop) {
        addLog("⏸️ Scraping stopped by user", "warning");
        break;
      }
    }

    // ─── Completion ─────────────────────────────────────
    const updateFields = {};

    if (scraperState.foundEmails.length > 0) {
      updateFields.all_emails = scraperState.foundEmails.join(", ");
      addLog(`\n📧 Saving ${scraperState.foundEmails.length} email(s) to state document...`, "info");

      // Clean up local email file
      if (fs.existsSync(emailFilePath)) {
        let fileContent = fs.readFileSync(emailFilePath, "utf-8").trim();
        if (fileContent.endsWith(",")) fileContent = fileContent.slice(0, -1).trim();
        fs.writeFileSync(emailFilePath, fileContent, "utf-8");
        addLog(`💾 Email file saved: ${emailFileName}`, "success");
      }
    }

    if (scraperState.foundMobiles.length > 0) {
      updateFields.all_mobile_no = scraperState.foundMobiles.join(", ");
      addLog(`📱 Saving ${scraperState.foundMobiles.length} mobile(s) to state document...`, "info");

      // Clean up local mobile file
      if (fs.existsSync(mobileFilePath)) {
        let fileContent = fs.readFileSync(mobileFilePath, "utf-8").trim();
        if (fileContent.endsWith(",")) fileContent = fileContent.slice(0, -1).trim();
        fs.writeFileSync(mobileFilePath, fileContent, "utf-8");
        addLog(`💾 Mobile file saved: ${mobileFileName}`, "success");
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await stateDocRef.update(updateFields);
      addLog(`✅ All data saved to ${firestorePath}`, "success");
    }

    addLog(`\n🏁 Scraping complete! Processed: ${scraperState.processed}, Emails: ${scraperState.foundEmails.length}, Mobiles: ${scraperState.foundMobiles.length}, Errors: ${scraperState.errors.length}`, "success");

  } catch (err) {
    addLog(`❌ Fatal error: ${err.message}`, "error");
    console.error("Scraper fatal error:", err);
  } finally {
    scraperState.isRunning = false;
    scraperState.completedAt = new Date().toISOString();
    scraperState.currentBusiness = "";
  }
}

// ─── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, "public")));

// Create reusable transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.zoho.in",
  port: parseInt(process.env.EMAIL_PORT) || 465,
  secure: (parseInt(process.env.EMAIL_PORT) || 465) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ─── Bulk Sending State ──────────────────────────────────
let bulkEmailState = {
  isRunning: false,
  shouldStop: false,
  total: 0,
  sent: 0,
  errors: 0,
  logs: [],
  startedAt: null,
  completedAt: null,
};

function resetBulkEmailState() {
  bulkEmailState = {
    isRunning: false,
    shouldStop: false,
    total: 0,
    sent: 0,
    errors: 0,
    logs: [],
    startedAt: null,
    completedAt: null,
  };
}

function addBulkLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString(),
    message,
    type,
  };
  bulkEmailState.logs.push(entry);
  if (bulkEmailState.logs.length > 200) {
    bulkEmailState.logs = bulkEmailState.logs.slice(-200);
  }
}

// ─── Metrics tracking helper ──────────────────────────────────
async function updateMetrics(firestore, status, isDatabaseMethod, firestorePath, email) {
  if (!firestore) return;
  
  const today = new Date().toISOString().split("T")[0];
  const dailyRef = firestore.collection("email_metrics").doc(today);
  const overallRef = firestore.collection("email_metrics").doc("overall");

  try {
    const incrementPayload = {};
    if (status === "sent") {
      incrementPayload.sent = admin.firestore.FieldValue.increment(1);
    } else if (status === "failed") {
      incrementPayload.bounces = admin.firestore.FieldValue.increment(1);
    }

    // Update Daily
    await dailyRef.set(incrementPayload, { merge: true });
    // Update Overall
    await overallRef.set(incrementPayload, { merge: true });

    // Handle database bounces
    if (status === "failed" && isDatabaseMethod && firestorePath && email) {
      const stateDocRef = firestore.doc(firestorePath);
      const doc = await stateDocRef.get();
      if (doc.exists) {
        let allEmailsStr = doc.data().all_emails || "";
        let bounceEmailsStr = doc.data().bounce_emails || "";
        
        let emailsArr = allEmailsStr.split(",").map(e => e.trim()).filter(e => e);
        if (emailsArr.includes(email)) {
           emailsArr = emailsArr.filter(e => e !== email);
           let bounceArr = bounceEmailsStr.split(",").map(e => e.trim()).filter(e => e);
           if (!bounceArr.includes(email)) bounceArr.push(email);

           await stateDocRef.update({
             all_emails: emailsArr.join(", "),
             bounce_emails: bounceArr.join(", ")
           });
           console.log(`Moved bounced email ${email} from all_emails to bounce_emails on ${firestorePath}`);
        }
      }
    }
  } catch (err) {
    console.error("Failed to update metrics:", err);
  }
}

// ─── Batch Scheduler (Cron) ───────────────────────────────
const CRON_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

setInterval(async () => {
  if (!firebaseInitialized) return;
  const firestore = db;

  try {
    const batchesRef = firestore.collection("email_batches");
    const snapshot = await batchesRef.where("status", "==", "active").get();
    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      if (bulkEmailState.isRunning) {
         // Only run one bulk operation at a time for now
         break;
      }

      const batch = doc.data();
      const now = new Date();

      // Check date explicitly to reset daily counts if needed
      const todayStr = now.toISOString().split("T")[0];
      let needsUpdate = false;
      if (batch.lastRunDate !== todayStr) {
        batch.dailySentCount = 0;
        batch.lastRunDate = todayStr;
        needsUpdate = true;
      }

      // Time check logic
      let canRunNow = true;
      if (batch.startTime) {
        // startTime is in "HH:MM" format (24hr, local time assumption)
        const [startH, startM] = batch.startTime.split(":").map(Number);
        if (now.getHours() < startH || (now.getHours() === startH && now.getMinutes() < startM)) {
           // Not time yet
           canRunNow = false;
        }
      }

      let dailyLimitReached = false;
      if (batch.dailyLimit && batch.dailySentCount >= batch.dailyLimit) {
         dailyLimitReached = true;
      }

      if (needsUpdate) {
         await doc.ref.update({ dailySentCount: batch.dailySentCount, lastRunDate: batch.lastRunDate });
      }

      if (canRunNow && !dailyLimitReached) {
         console.log(`Cron: Starting batch ${doc.id}`);
         // Reconstruct mailOptions Base
         const mailOptionsBase = {
            from: `"FindMyDine" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
            subject: batch.subject,
            text: batch.text || undefined,
            html: batch.html || undefined,
         };
         if (batch.cc) mailOptionsBase.cc = batch.cc;
         if (batch.bcc) mailOptionsBase.bcc = batch.bcc;
         if (batch.replyTo) mailOptionsBase.replyTo = batch.replyTo;

         // Load attachments
         if (batch.attachmentPaths && batch.attachmentPaths.length > 0) {
            mailOptionsBase.attachments = batch.attachmentPaths.map(p => {
               return {
                  filename: path.basename(p),
                  path: path.join(__dirname, p)
               };
            });
         }

         // Fire and forget, runBulkEmail will manage state
         runBulkEmail(doc.id, batch.emails, mailOptionsBase, batch).catch(console.error);
      }
    }
  } catch (err) {
    console.error("Cron Error:", err);
  }
}, CRON_INTERVAL_MS);


// ─── Email API Routes ─────────────────────────────────────

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "running",
    message: "Email Send API is up and running 🚀",
  });
});

// Get server time (so user can see what timezone the server runs in)
app.get("/api/server-time", (req, res) => {
  const now = new Date();
  res.json({
    iso: now.toISOString(),
    time: now.toLocaleTimeString("en-US", { hour12: false }),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

// Get sender config (for display in frontend)
app.get("/api/config", (req, res) => {
  res.json({
    senderEmail: process.env.EMAIL_USER || "not configured",
    host: process.env.EMAIL_HOST || "not configured",
  });
});

// Get sent email history
app.get("/api/emails", (req, res) => {
  res.json({
    success: true,
    count: emailHistory.length,
    emails: emailHistory.slice().reverse(), // newest first
  });
});

// Send email (supports file attachments)
app.post("/api/send-email", upload.fields([{ name: "attachments", maxCount: 5 }, { name: "html", maxCount: 1 }]), async (req, res) => {
  let { to, cc, bcc, replyTo, subject, text, html } = req.body;

  // Extract HTML if uploaded as a file
  if (req.files && req.files['html'] && req.files['html'].length > 0) {
    html = req.files['html'][0].buffer.toString('utf-8');
  }

  // Validation
  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: to, subject, and text or html",
    });
  }

  // Build attachments from uploaded files
  const attachments = [];
  if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
    for (const file of req.files['attachments']) {
      attachments.push({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype,
      });
    }
  }

  try {
    const mailOptions = {
      from: `"FindMyDine" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
    };

    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (replyTo) mailOptions.replyTo = replyTo;
    if (attachments.length > 0) mailOptions.attachments = attachments;

    const info = await transporter.sendMail(mailOptions);

    // Save to history
    const historyEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      to,
      cc: cc || null,
      bcc: bcc || null,
      subject,
      body: text || html,
      isHtml: !!html && !text,
      attachmentCount: attachments.length,
      attachmentNames: attachments.map((a) => a.filename),
      messageId: info.messageId,
      sentAt: new Date().toISOString(),
      status: "sent",
    };
    emailHistory.push(historyEntry);

    res.status(200).json({
      success: true,
      message: "Email sent successfully!",
      messageId: info.messageId,
      email: historyEntry,
    });
  } catch (error) {
    console.error("Error sending email:", error);

    // Save failed attempt to history
    const historyEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      to,
      cc: cc || null,
      bcc: bcc || null,
      subject,
      body: text || html,
      isHtml: !!html && !text,
      attachmentCount: attachments.length,
      sentAt: new Date().toISOString(),
      status: "failed",
      error: error.message,
    };
    emailHistory.push(historyEntry);

    res.status(500).json({
      success: false,
      message: "Failed to send email",
      error: error.message,
    });
    
    // Attempt tracking
    updateMetrics(initFirebase(), "failed", false, null, to).catch(console.error);
  }
});

// ─── Bulk Email API Routes ────────────────────────────────

app.post("/api/send-bulk", upload.fields([{ name: "attachments", maxCount: 5 }, { name: "html", maxCount: 1 }]), async (req, res) => {
  if (bulkEmailState.isRunning) {
    return res.status(400).json({
      success: false,
      message: "A bulk sending operation is already running",
    });
  }

  let { sendMethod, firestorePath, manualEmails, subject, text, html, cc, bcc, replyTo, startTime, dailyLimit } = req.body;

  // Extract HTML if uploaded as a file
  if (req.files && req.files['html'] && req.files['html'].length > 0) {
    html = req.files['html'][0].buffer.toString('utf-8');
  }

  if (!subject || (!text && !html)) {
    return res.status(400).json({
      success: false,
      message: "Missing subject and text or html",
    });
  }

  let emailList = [];

  try {
    if (sendMethod === "database") {
      if (!firestorePath) {
        return res.status(400).json({ success: false, message: "Missing firestorePath" });
      }
      const firestore = initFirebase();
      const doc = await firestore.doc(firestorePath).get();
      if (!doc.exists) {
        return res.status(404).json({ success: false, message: "Firestore document not found" });
      }
      const allEmailsStr = doc.data().all_emails || "";
      emailList = allEmailsStr.split(",").map((e) => e.trim()).filter((e) => e);
    } else if (sendMethod === "manual") {
      if (!manualEmails) {
        return res.status(400).json({ success: false, message: "Missing manualEmails" });
      }
      emailList = manualEmails.split(",").map((e) => e.trim()).filter((e) => e);
    } else {
      return res.status(400).json({ success: false, message: "Invalid sendMethod" });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error parsing emails: " + err.message });
  }

  if (emailList.length === 0) {
    return res.status(400).json({ success: false, message: "No valid emails found to send." });
  }

  // Handle local file copying for batch processing
  const uploadDir = path.join(__dirname, "uploads");
  if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
  }

  const attachmentPaths = [];
  if (req.files && req.files['attachments'] && req.files['attachments'].length > 0) {
    for (const file of req.files['attachments']) {
      const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9) + "-" + file.originalname;
      const savePath = path.join(uploadDir, uniqueName);
      fs.writeFileSync(savePath, file.buffer);
      attachmentPaths.push("uploads/" + uniqueName);
    }
  }

  // Create Batch Record in Firestore
  const firestore = initFirebase();
  const batchRef = firestore.collection("email_batches").doc();
  const batchData = {
     subject: subject || "",
     text: text || "",
     html: html || "",
     cc: cc || "",
     bcc: bcc || "",
     replyTo: replyTo || "",
     startTime: startTime || null,
     dailyLimit: dailyLimit ? parseInt(dailyLimit) : null,
     dailySentCount: 0,
     lastRunDate: new Date().toISOString().split("T")[0],
     sendMethod: sendMethod,
     firestorePath: firestorePath || null,
     emails: emailList,
     progressIndex: 0,
     status: "active", // active, completed
     createdAt: new Date().toISOString(),
     attachmentPaths: attachmentPaths,
  };

  try {
     await batchRef.set(batchData);
  } catch (err) {
     return res.status(500).json({ success: false, message: "Failed to store batch job: " + err.message });
  }

  res.json({
    success: true,
    message: batchData.startTime || batchData.dailyLimit 
      ? `Batch scheduled successfully for ${emailList.length} recipients. Will begin sending at ${batchData.startTime || "immediately"}.` 
      : `Started sending to ${emailList.length} recipients in background.`,
  });
});

async function runBulkEmail(batchId, emails, mailOptionsBase, batchData) {
  resetBulkEmailState();
  bulkEmailState.isRunning = true;
  bulkEmailState.total = emails.length;
  // Account for previously sent in UI optionally, starting simple
  bulkEmailState.sent = batchData.progressIndex || 0; 
  bulkEmailState.startedAt = new Date().toISOString();
  addBulkLog(`🚀 Started processing batch ${batchId} / ${emails.length} total emails`, "info");

  const firestore = initFirebase();
  const batchRef = firestore.collection("email_batches").doc(batchId);

  for (let i = batchData.progressIndex || 0; i < emails.length; i++) {
    if (bulkEmailState.shouldStop) {
      addBulkLog("⏸️ Sending stopped by user", "warning");
      break;
    }
    
    // Check daily limit here too
    if (batchData.dailyLimit && batchData.dailySentCount >= batchData.dailyLimit) {
       addBulkLog("⏸️ Daily limit reached, pausing until tomorrow.", "warning");
       break; // Pause out of the loop
    }

    const recipient = emails[i];
    addBulkLog(`⏳ [${i + 1}/${emails.length}] Sending to ${recipient}...`, "info");

    let options;
    try {
      options = { ...mailOptionsBase, to: recipient };
      const info = await transporter.sendMail(options);
      bulkEmailState.sent++;
      batchData.dailySentCount++;
      addBulkLog(`✅ Sent to ${recipient}`, "success");
      
      // Save to history
      emailHistory.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        to: recipient,
        cc: options.cc || null,
        bcc: options.bcc || null,
        subject: options.subject,
        body: options.text || options.html,
        isHtml: !!options.html && !options.text,
        attachmentCount: options.attachments ? options.attachments.length : 0,
        attachmentNames: options.attachments ? options.attachments.map((a) => path.basename(a.path || a.filename)) : [],
        messageId: info.messageId,
        sentAt: new Date().toISOString(),
        status: "sent",
      });
      
      await updateMetrics(firestore, "sent", batchData.sendMethod === "database", batchData.firestorePath, recipient);

    } catch (err) {
      bulkEmailState.errors++;
      addBulkLog(`❌ Failed to send to ${recipient}: ${err.message}`, "error");
      
      emailHistory.push({
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        to: recipient,
        cc: mailOptionsBase.cc || null,
        bcc: mailOptionsBase.bcc || null,
        subject: mailOptionsBase.subject,
        body: mailOptionsBase.text || mailOptionsBase.html,
        isHtml: !!mailOptionsBase.html && !mailOptionsBase.text,
        attachmentCount: mailOptionsBase.attachments ? mailOptionsBase.attachments.length : 0,
        sentAt: new Date().toISOString(),
        status: "failed",
        error: err.message,
      });

      await updateMetrics(firestore, "failed", batchData.sendMethod === "database", batchData.firestorePath, recipient);
    }

    // Save progress mapping to Firestore
    batchData.progressIndex = i + 1;
    await batchRef.update({
       progressIndex: batchData.progressIndex,
       dailySentCount: batchData.dailySentCount
    });

    // Modified delay to 2000ms (2 seconds)
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  bulkEmailState.isRunning = false;
  bulkEmailState.completedAt = new Date().toISOString();
  addBulkLog(`🏁 Finished batch segment. Success: ${bulkEmailState.sent}, Errors: ${bulkEmailState.errors}`, "info");

  // Check if fully complete
  if (batchData.progressIndex >= emails.length) {
     await batchRef.update({ status: "completed" });
     addBulkLog(`✅ Batch completely finished all emails!`, "success");
  }
}

app.get("/api/bulk-status", (req, res) => {
  res.json(bulkEmailState);
});

app.post("/api/bulk-stop", (req, res) => {
  if (!bulkEmailState.isRunning) {
    return res.status(400).json({ success: false, message: "Not running" });
  }
  bulkEmailState.shouldStop = true;
  res.json({ success: true, message: "Stop signal sent" });
});

app.get("/api/active-batches", async (req, res) => {
  try {
    const firestore = initFirebase();
    const snapshot = await firestore.collection("email_batches")
      .where("status", "==", "active")
      .orderBy("createdAt", "desc")
      .get();
      
    const batches = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      batches.push({
        id: doc.id,
        subject: data.subject,
        progressIndex: data.progressIndex || 0,
        totalEmails: data.emails ? data.emails.length : 0,
        startTime: data.startTime || 'Immediate',
        dailyLimit: data.dailyLimit || 'None',
        dailySentCount: data.dailySentCount || 0,
        createdAt: data.createdAt
      });
    });
    
    res.json({ success: true, batches });
  } catch (error) {
    console.error("Error fetching active batches:", error);
    res.status(500).json({ success: false, message: "Failed to fetch active batches", error: error.message });
  }
});

// ─── Scraper API Routes ───────────────────────────────────

// Get scraper status
app.get("/api/scraper/status", (req, res) => {
  res.json({
    isRunning: scraperState.isRunning,
    processed: scraperState.processed,
    total: scraperState.total,
    foundEmails: scraperState.foundEmails,
    foundEmailsCount: scraperState.foundEmails.length,
    foundMobiles: scraperState.foundMobiles,
    foundMobilesCount: scraperState.foundMobiles.length,
    currentBusiness: scraperState.currentBusiness,
    errorsCount: scraperState.errors.length,
    errors: scraperState.errors.slice(-10),
    logs: scraperState.logs.slice(-50),
    startedAt: scraperState.startedAt,
    completedAt: scraperState.completedAt,
    countryName: scraperState.countryName,
    stateName: scraperState.stateName,
    firestorePath: scraperState.firestorePath,
  });
});

// Check if a path is fully scraped
app.post("/api/scraper/check-unscraped", async (req, res) => {
  const { firestorePath } = req.body;
  if (!firestorePath) {
    return res.status(400).json({ success: false, message: "Missing firestorePath" });
  }

  try {
    const firestore = initFirebase();
    const stateDocRef = firestore.doc(firestorePath);
    const stateDoc = await stateDocRef.get();

    if (!stateDoc.exists) {
      return res.status(404).json({ success: false, message: "Document not found" });
    }

    const restaurantsRef = stateDocRef.collection("restaurants");
    
    // Count total records
    const totalAllSnapshot = await restaurantsRef.count().get();
    const totalAll = totalAllSnapshot.data().count;

    // Count already scraped records
    const scrapedSnapshot = await restaurantsRef.where("scraped", "==", true).count().get();
    const scrapedCount = scrapedSnapshot.data().count;

    res.json({
      success: true,
      total: totalAll,
      scraped: scrapedCount,
      remaining: totalAll - scrapedCount
    });
  } catch (err) {
    console.error("Error checking unscraped:", err);
    res.status(500).json({ success: false, message: "Server error checking path" });
  }
});

// Start scraping
app.post("/api/scraper/start", (req, res) => {
  if (scraperState.isRunning) {
    return res.status(400).json({
      success: false,
      message: "Scraper is already running",
    });
  }

  const { firestorePath, forceRescrap } = req.body;

  if (!firestorePath) {
    return res.status(400).json({
      success: false,
      message: "Missing firestorePath in request body",
    });
  }

  // Reset and start
  resetScraperState();
  scraperState.firestorePath = firestorePath;

  // Run in background (don't await)
  runScraper(firestorePath, forceRescrap).catch((err) => {
    console.error("Scraper error:", err);
    addLog(`❌ Fatal error: ${err.message}`, "error");
    scraperState.isRunning = false;
  });

  res.json({
    success: true,
    message: "Scraper started",
  });
});

// Stop scraping
app.post("/api/scraper/stop", (req, res) => {
  if (!scraperState.isRunning) {
    return res.status(400).json({
      success: false,
      message: "Scraper is not running",
    });
  }

  scraperState.shouldStop = true;
  addLog("⏸️ Stop requested by user...", "warning");

  res.json({
    success: true,
    message: "Stop signal sent. Scraper will stop after current record.",
  });
});

// Update state document emails (after edit/delete by user)
app.post("/api/scraper/update-state-emails", async (req, res) => {
  const { firestorePath, emails } = req.body;

  if (!firestorePath || !Array.isArray(emails)) {
    return res.status(400).json({
      success: false,
      message: "Missing firestorePath or emails array in request body",
    });
  }

  try {
    const firestore = initFirebase();
    const stateDocRef = firestore.doc(firestorePath);
    const stateDoc = await stateDocRef.get();

    if (!stateDoc.exists) {
      return res.status(404).json({
        success: false,
        message: `Document not found at path: ${firestorePath}`,
      });
    }

    // Update only the all_emails field on the state document
    const cleanEmails = emails.filter((e) => e && e.trim().length > 0).map((e) => e.trim());
    await stateDocRef.update({
      all_emails: cleanEmails.join(", "),
    });

    // Also update in-memory scraper state if it matches the current path
    if (scraperState.firestorePath === firestorePath) {
      scraperState.foundEmails = cleanEmails;
    }

    res.json({
      success: true,
      message: `Updated ${cleanEmails.length} email(s) on state document`,
      count: cleanEmails.length,
    });
  } catch (err) {
    console.error("Error updating state emails:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update state emails: " + err.message,
    });
  }
});

// Check emails from a state document path
app.post("/api/scraper/check-emails", async (req, res) => {
  const { firestorePath } = req.body;

  if (!firestorePath) {
    return res.status(400).json({
      success: false,
      message: "Missing firestorePath in request body",
    });
  }

  try {
    const firestore = initFirebase();
    const stateDocRef = firestore.doc(firestorePath);
    const stateDoc = await stateDocRef.get();

    if (!stateDoc.exists) {
      return res.status(404).json({
        success: false,
        message: `Document not found at path: ${firestorePath}`,
      });
    }

    const data = stateDoc.data();
    const allEmailsStr = data.all_emails || "";

    // Parse the comma-separated email string into an array
    const emails = allEmailsStr
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    res.json({
      success: true,
      firestorePath,
      emails,
      count: emails.length,
    });
  } catch (err) {
    console.error("Error checking emails:", err);
    res.status(500).json({
      success: false,
      message: "Failed to check emails: " + err.message,
    });
  }
});

// Validate emails via MX record check
app.post("/api/scraper/validate-emails", async (req, res) => {
  const { emails } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing or empty emails array",
    });
  }

  // Also apply keyword filter and substring dedup on the provided list
  const blacklistKeywords = ["wixpress", "yourmail", "sentry"];

  // Step 1: Keyword filter
  const afterKeywordFilter = emails.filter((email) => {
    const lower = email.toLowerCase();
    return !blacklistKeywords.some((kw) => lower.includes(kw));
  });

  // Step 2: Substring dedup
  const afterDedup = afterKeywordFilter.filter((email, idx) => {
    for (let i = 0; i < afterKeywordFilter.length; i++) {
      if (i === idx) continue;
      if (email.length > afterKeywordFilter[i].length && email.includes(afterKeywordFilter[i])) {
        return false;
      }
    }
    return true;
  });

  // Step 3: MX record check for remaining emails (uses shared checkMxRecord)
  const results = [];
  const removedByKeyword = emails.filter((e) => !afterKeywordFilter.includes(e));
  const removedByDedup = afterKeywordFilter.filter((e) => !afterDedup.includes(e));

  // Mark removed emails
  for (const email of removedByKeyword) {
    results.push({ email, valid: false, reason: "Blacklisted keyword" });
  }
  for (const email of removedByDedup) {
    results.push({ email, valid: false, reason: "Substring duplicate" });
  }

  // Check MX for remaining
  for (const email of afterDedup) {
    const parts = email.split("@");
    if (parts.length !== 2 || !parts[1]) {
      results.push({ email, valid: false, reason: "Invalid format" });
      continue;
    }

    const hasMx = await checkMxRecord(parts[1]);

    results.push({
      email,
      valid: hasMx,
      reason: hasMx ? "MX records found" : "No MX records — domain cannot receive email",
    });
  }

  const validEmails = results.filter((r) => r.valid).map((r) => r.email);
  const invalidEmails = results.filter((r) => !r.valid);

  res.json({
    success: true,
    total: emails.length,
    validCount: validEmails.length,
    invalidCount: invalidEmails.length,
    validEmails,
    invalidEmails,
    results,
  });
});

// Download emails file
app.get("/api/scraper/download-emails", (req, res) => {
  const { country, state } = req.query;

  if (!country || !state) {
    return res.status(400).json({
      success: false,
      message: "Missing country or state query params",
    });
  }

  const fileName = `${country}_${state}.txt`;
  const filePath = path.join(__dirname, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      message: "Email file not found. Run the scraper first.",
    });
  }

  res.download(filePath, fileName);
});

// Fallback — serve index.html for SPA
app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
