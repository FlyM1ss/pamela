#!/usr/bin/env node
/**
 * grade-trades.mjs — Grade "would-trade" decisions against real market prices.
 *
 * Reads report JSON files from reports/, extracts all shouldTrade=true decisions,
 * fetches current (or resolved) prices from Gamma API, and prints a P&L summary.
 *
 * Usage:
 *   node scripts/grade-trades.mjs                    # grade all reports
 *   node scripts/grade-trades.mjs reports/report-2026-02-08.json  # grade one file
 *   node scripts/grade-trades.mjs --latest            # grade snapshot-latest.json
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");
const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const RATE_LIMIT_MS = 200; // Be nice to Gamma API

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatUSD(n) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function formatPct(n) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(1)}%`;
}

// ─── Load decisions from report files ────────────────────────────────────────

function loadDecisions(filePaths) {
  const decisions = [];

  for (const fp of filePaths) {
    try {
      const raw = JSON.parse(readFileSync(fp, "utf-8"));

      // Daily reports have allDecisions at top level
      const list = raw.allDecisions || raw.recentDecisions || [];

      for (const d of list) {
        if (!d.shouldTrade) continue;
        if (!d.marketId && !d.market) continue;

        decisions.push({
          timestamp: d.timestamp,
          market: d.market || "Unknown",
          marketId: d.marketId || null,
          outcome: d.outcome,
          entryPrice: d.entryPrice ?? d.price ?? null,
          size: d.size ?? 20,
          confidence: d.confidence,
          reasoning: d.reasoning || "",
          sourceFile: path.basename(fp),
        });
      }
    } catch (err) {
      console.error(`  Skipping ${fp}: ${err.message}`);
    }
  }

  return decisions;
}

// ─── Fetch current market state from Gamma API ──────────────────────────────

async function fetchMarketPrice(conditionId) {
  try {
    const url = `${GAMMA_API}?condition_ids=${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const market = data[0];
    if (!market) return null;

    let yesPrice = null;
    let noPrice = null;

    if (market.outcomePrices) {
      const prices = JSON.parse(market.outcomePrices);
      yesPrice = parseFloat(prices[0]);
      noPrice = parseFloat(prices[1]);
    }

    return {
      question: market.question,
      active: market.active,
      closed: market.closed,
      resolved: !!market.resolutionSource,
      yesPrice,
      noPrice,
      // For resolved markets, check winner
      winner: market.winner ?? null,
    };
  } catch {
    return null;
  }
}

// ─── Grade a single decision ─────────────────────────────────────────────────

function gradeDecision(decision, marketState) {
  if (!marketState || decision.entryPrice === null) {
    return { status: "unknown", pnl: 0, currentPrice: null, note: "Could not fetch market" };
  }

  const currentPrice =
    decision.outcome === "YES" ? marketState.yesPrice : marketState.noPrice;

  if (currentPrice === null) {
    return { status: "unknown", pnl: 0, currentPrice: null, note: "No price data" };
  }

  const shares = decision.size / decision.entryPrice;

  if (marketState.resolved || marketState.closed) {
    // Resolved market: payout is $1 if our outcome won, $0 if not
    // Check by looking at the resolved price (should be ~1.0 or ~0.0)
    const resolvedPrice = currentPrice;
    const won = resolvedPrice > 0.90; // Close enough to $1
    const payout = won ? 1.0 : 0.0;
    const pnl = (payout - decision.entryPrice) * shares;
    return {
      status: won ? "WIN" : "LOSS",
      pnl,
      currentPrice: resolvedPrice,
      note: `Resolved → ${won ? "correct" : "wrong"}`,
    };
  }

  // Active market: unrealized P&L
  const pnl = (currentPrice - decision.entryPrice) * shares;
  const status = pnl >= 0 ? "UNREALIZED_WIN" : "UNREALIZED_LOSS";
  return {
    status,
    pnl,
    currentPrice,
    note: `Still active`,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Determine which files to load
  let filePaths = [];
  const arg = process.argv[2];

  if (arg === "--latest") {
    const latest = path.join(REPORTS_DIR, "snapshot-latest.json");
    if (existsSync(latest)) filePaths.push(latest);
    else {
      console.error("No snapshot-latest.json found in reports/");
      process.exit(1);
    }
  } else if (arg && existsSync(arg)) {
    filePaths.push(path.resolve(arg));
  } else if (arg) {
    console.error(`File not found: ${arg}`);
    process.exit(1);
  } else {
    // Load all report and snapshot files
    if (!existsSync(REPORTS_DIR)) {
      console.error("No reports/ directory found. Run the bot first.");
      process.exit(1);
    }
    const files = readdirSync(REPORTS_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    filePaths = files.map((f) => path.join(REPORTS_DIR, f));
  }

  console.log(`\n📊 Loading decisions from ${filePaths.length} file(s)...\n`);

  const decisions = loadDecisions(filePaths);

  if (decisions.length === 0) {
    console.log("No would-trade decisions found in reports.");
    console.log("Run the bot with UNSUPERVISED_MODE=false to generate data.\n");
    process.exit(0);
  }

  // Deduplicate by marketId+outcome+timestamp (same decision can appear in snapshot + daily)
  const seen = new Set();
  const uniqueDecisions = decisions.filter((d) => {
    const key = `${d.marketId}|${d.outcome}|${d.timestamp}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(
    `Found ${uniqueDecisions.length} unique would-trade decision(s). Fetching current prices...\n`
  );

  // Fetch current prices (with rate limiting)
  const results = [];
  const priceCache = new Map();

  for (const d of uniqueDecisions) {
    let marketState = null;

    if (d.marketId) {
      if (priceCache.has(d.marketId)) {
        marketState = priceCache.get(d.marketId);
      } else {
        marketState = await fetchMarketPrice(d.marketId);
        priceCache.set(d.marketId, marketState);
        await sleep(RATE_LIMIT_MS);
      }
    }

    const grade = gradeDecision(d, marketState);
    results.push({ decision: d, grade });
  }

  // ─── Print results ──────────────────────────────────────────────────────

  const COL = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    cyan: "\x1b[36m",
  };

  console.log("═".repeat(100));
  console.log(
    `${COL.bold}  TRADE GRADING REPORT${COL.reset}  ${COL.dim}(generated ${new Date().toISOString()})${COL.reset}`
  );
  console.log("═".repeat(100));

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let unrealized = 0;
  let unknown = 0;

  for (const { decision: d, grade: g } of results) {
    totalPnl += g.pnl;

    let statusColor;
    if (g.status === "WIN" || g.status === "UNREALIZED_WIN") {
      statusColor = COL.green;
      if (g.status === "WIN") wins++;
      else unrealized++;
    } else if (g.status === "LOSS" || g.status === "UNREALIZED_LOSS") {
      statusColor = COL.red;
      if (g.status === "LOSS") losses++;
      else unrealized++;
    } else {
      statusColor = COL.yellow;
      unknown++;
    }

    const priceStr = g.currentPrice !== null
      ? `${(d.entryPrice * 100).toFixed(1)}¢ → ${(g.currentPrice * 100).toFixed(1)}¢`
      : `${(d.entryPrice * 100).toFixed(1)}¢ → ???`;

    const pnlStr = g.pnl !== 0 ? formatUSD(g.pnl) : "$0.00";

    console.log(
      `\n${statusColor}  [${g.status.padEnd(16)}]${COL.reset}  ${COL.bold}${d.market}${COL.reset}`
    );
    console.log(
      `    ${COL.cyan}${d.outcome}${COL.reset}  ${priceStr}  |  Size: $${d.size}  |  P&L: ${statusColor}${pnlStr}${COL.reset}`
    );
    console.log(
      `    ${COL.dim}${d.timestamp}  |  ${g.note}${COL.reset}`
    );
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(100));
  console.log(`${COL.bold}  SUMMARY${COL.reset}`);
  console.log("─".repeat(100));

  const totalColor = totalPnl >= 0 ? COL.green : COL.red;

  console.log(`  Total would-trades:   ${results.length}`);
  console.log(`  Resolved wins:        ${COL.green}${wins}${COL.reset}`);
  console.log(`  Resolved losses:      ${COL.red}${losses}${COL.reset}`);
  console.log(`  Still active:         ${COL.yellow}${unrealized}${COL.reset}`);
  console.log(`  Unknown/no data:      ${unknown}`);

  if (wins + losses > 0) {
    const winRate = (wins / (wins + losses)) * 100;
    console.log(`  Win rate (resolved):  ${winRate.toFixed(0)}%`);
  }

  const totalInvested = results.reduce((s, r) => s + r.decision.size, 0);
  const roi = totalInvested > 0 ? totalPnl / totalInvested : 0;

  console.log("");
  console.log(`  Total invested:       $${totalInvested.toFixed(2)}`);
  console.log(
    `  Total P&L:            ${totalColor}${COL.bold}${formatUSD(totalPnl)}${COL.reset}  (${formatPct(roi)} ROI)`
  );
  console.log("═".repeat(100) + "\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
