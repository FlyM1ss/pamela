/**
 * Trading Report Service
 *
 * Collects scan data during bot operation and writes periodic reports
 * to `reports/` as JSON files. A rolling hourly snapshot is kept in memory
 * and flushed to disk; a daily summary is written at midnight (or on shutdown).
 */

import { elizaLogger } from "@elizaos/core";
import { MarketOpportunity, TradingDecision } from "./types.js";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

export interface ScanRecord {
  timestamp: string;
  marketsScanned: number;
  opportunitiesFound: number;
  topOpportunities: {
    market: string;
    outcome: string;
    price: number;
    confidence: number;
    expectedValue: number;
    signals: string[];
  }[];
  decisions: {
    market: string;
    outcome: string;
    shouldTrade: boolean;
    reasoning: string;
    size: number;
    price: number;
    confidence: number;
  }[];
}

export interface HourlySnapshot {
  hour: string; // ISO hour like "2026-02-07T03"
  totalScans: number;
  totalOpportunities: number;
  totalWouldTrade: number;
  uniqueMarkets: string[];
  bestOpportunity: {
    market: string;
    outcome: string;
    confidence: number;
    expectedValue: number;
  } | null;
}

export interface DailyReport {
  date: string;
  generatedAt: string;
  summary: {
    totalScans: number;
    totalOpportunities: number;
    totalWouldTrade: number;
    uniqueMarketsAnalyzed: number;
    newsApiCallsUsed: number;
    uptimeHours: number;
  };
  hourlyBreakdown: HourlySnapshot[];
  topMarkets: {
    market: string;
    appearances: number;
    avgConfidence: number;
    avgExpectedValue: number;
    bestOutcome: string;
  }[];
  allDecisions: {
    timestamp: string;
    market: string;
    marketId: string;
    outcome: string;
    shouldTrade: boolean;
    entryPrice: number;
    size: number;
    confidence: number;
    expectedValue: number;
    reasoning: string;
  }[];
}

export class TradingReportService {
  private reportsDir: string;
  private scans: ScanRecord[] = [];
  private hourlySnapshots: HourlySnapshot[] = [];
  private currentHour: string = "";
  private currentHourScans = 0;
  private currentHourOpps = 0;
  private currentHourTrades = 0;
  private currentHourMarkets = new Set<string>();
  private currentHourBest: HourlySnapshot["bestOpportunity"] = null;
  private startTime: number = Date.now();
  private flushInterval: NodeJS.Timeout | null = null;
  private allDecisions: DailyReport["allDecisions"] = [];
  private marketStats = new Map<string, {
    appearances: number;
    totalConfidence: number;
    totalEV: number;
    bestOutcome: string;
    bestEV: number;
  }>();

  constructor(reportsDir?: string) {
    this.reportsDir = reportsDir || path.resolve(process.cwd(), "reports");
    this.currentHour = this.getHourKey();
  }

  async start(): Promise<void> {
    if (!existsSync(this.reportsDir)) {
      await mkdir(this.reportsDir, { recursive: true });
    }
    this.startTime = Date.now();
    elizaLogger.info(`Trading report service started — writing to ${this.reportsDir}`);

    // Flush hourly snapshots every hour
    this.flushInterval = setInterval(() => this.rotateHour(), 60 * 60 * 1000);
  }

  /** Called after each scan cycle */
  recordScan(
    marketsScanned: number,
    opportunities: MarketOpportunity[],
    decisions: TradingDecision[]
  ): void {
    const now = new Date();
    const hourKey = this.getHourKey(now);

    // Rotate hour bucket if needed
    if (hourKey !== this.currentHour) {
      this.rotateHour();
      this.currentHour = hourKey;
    }

    // Update current hour accumulators
    this.currentHourScans++;
    this.currentHourOpps += opportunities.length;
    this.currentHourTrades += decisions.filter(d => d.shouldTrade).length;

    for (const opp of opportunities) {
      const shortQ = opp.question.slice(0, 80);
      this.currentHourMarkets.add(shortQ);

      // Track best opportunity this hour
      if (!this.currentHourBest || opp.expectedValue > this.currentHourBest.expectedValue) {
        this.currentHourBest = {
          market: shortQ,
          outcome: opp.outcome,
          confidence: opp.confidence,
          expectedValue: opp.expectedValue,
        };
      }

      // Accumulate market stats for daily summary
      const existing = this.marketStats.get(shortQ);
      if (existing) {
        existing.appearances++;
        existing.totalConfidence += opp.confidence;
        existing.totalEV += opp.expectedValue;
        if (opp.expectedValue > existing.bestEV) {
          existing.bestEV = opp.expectedValue;
          existing.bestOutcome = opp.outcome;
        }
      } else {
        this.marketStats.set(shortQ, {
          appearances: 1,
          totalConfidence: opp.confidence,
          totalEV: opp.expectedValue,
          bestOutcome: opp.outcome,
          bestEV: opp.expectedValue,
        });
      }
    }

    // Record decisions
    for (const d of decisions) {
      const opp = opportunities.find(o => o.marketId === d.marketId);
      this.allDecisions.push({
        timestamp: now.toISOString(),
        market: opp?.question.slice(0, 80) || d.marketId,
        marketId: d.marketId,
        outcome: d.outcome,
        shouldTrade: d.shouldTrade,
        entryPrice: d.price,
        size: d.size,
        confidence: d.confidence,
        expectedValue: opp?.expectedValue || 0,
        reasoning: d.reasoning,
      });
    }
  }

  /** Flush current hour bucket into snapshots array */
  private rotateHour(): void {
    if (this.currentHourScans > 0) {
      this.hourlySnapshots.push({
        hour: this.currentHour,
        totalScans: this.currentHourScans,
        totalOpportunities: this.currentHourOpps,
        totalWouldTrade: this.currentHourTrades,
        uniqueMarkets: [...this.currentHourMarkets],
        bestOpportunity: this.currentHourBest,
      });
    }
    // Reset accumulators
    this.currentHourScans = 0;
    this.currentHourOpps = 0;
    this.currentHourTrades = 0;
    this.currentHourMarkets.clear();
    this.currentHourBest = null;
  }

  /** Build and write the daily report to disk */
  async writeDailyReport(newsApiCalls?: number): Promise<string> {
    // Flush current hour first
    this.rotateHour();

    const totalScans = this.hourlySnapshots.reduce((s, h) => s + h.totalScans, 0);
    const totalOpps = this.hourlySnapshots.reduce((s, h) => s + h.totalOpportunities, 0);
    const totalTrades = this.hourlySnapshots.reduce((s, h) => s + h.totalWouldTrade, 0);
    const uniqueMarkets = new Set(this.hourlySnapshots.flatMap(h => h.uniqueMarkets));

    // Top markets sorted by appearances
    const topMarkets = [...this.marketStats.entries()]
      .map(([market, stats]) => ({
        market,
        appearances: stats.appearances,
        avgConfidence: +(stats.totalConfidence / stats.appearances).toFixed(3),
        avgExpectedValue: +(stats.totalEV / stats.appearances).toFixed(2),
        bestOutcome: stats.bestOutcome,
      }))
      .sort((a, b) => b.avgExpectedValue - a.avgExpectedValue)
      .slice(0, 25);

    const uptimeMs = Date.now() - this.startTime;
    const uptimeHours = +(uptimeMs / (1000 * 60 * 60)).toFixed(2);

    const report: DailyReport = {
      date: new Date().toISOString().slice(0, 10),
      generatedAt: new Date().toISOString(),
      summary: {
        totalScans,
        totalOpportunities: totalOpps,
        totalWouldTrade: totalTrades,
        uniqueMarketsAnalyzed: uniqueMarkets.size,
        newsApiCallsUsed: newsApiCalls || 0,
        uptimeHours,
      },
      hourlyBreakdown: this.hourlySnapshots,
      topMarkets,
      allDecisions: this.allDecisions.slice(-200), // Keep last 200 decisions
    };

    const filename = `report-${report.date}.json`;
    const filepath = path.join(this.reportsDir, filename);

    await writeFile(filepath, JSON.stringify(report, null, 2), "utf-8");
    elizaLogger.info(`Daily report written to ${filepath}`);

    return filepath;
  }

  /** Write a quick status snapshot (called periodically) */
  async writeSnapshot(): Promise<string> {
    this.rotateHour();

    const totalScans = this.hourlySnapshots.reduce((s, h) => s + h.totalScans, 0) + this.currentHourScans;
    const totalOpps = this.hourlySnapshots.reduce((s, h) => s + h.totalOpportunities, 0) + this.currentHourOpps;

    const snapshot = {
      generatedAt: new Date().toISOString(),
      uptimeMinutes: +((Date.now() - this.startTime) / 60000).toFixed(1),
      totalScans,
      totalOpportunities: totalOpps,
      hoursRecorded: this.hourlySnapshots.length,
      recentDecisions: this.allDecisions.slice(-20),
    };

    const filename = `snapshot-latest.json`;
    const filepath = path.join(this.reportsDir, filename);
    await writeFile(filepath, JSON.stringify(snapshot, null, 2), "utf-8");
    return filepath;
  }

  async stop(newsApiCalls?: number): Promise<string> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    const reportPath = await this.writeDailyReport(newsApiCalls);
    elizaLogger.info("Trading report service stopped");
    return reportPath;
  }

  private getHourKey(date?: Date): string {
    const d = date || new Date();
    return d.toISOString().slice(0, 13); // "2026-02-07T03"
  }
}
