/**
 * News-Latency Arbitrage Strategy
 *
 * Exploits the time gap between credible news confirming an event and
 * Polymarket adjusting its price. Instead of predicting probabilities,
 * we only bet on confirmed events where the market hasn't caught up.
 *
 * Every 30 minutes:
 * 1. Fetch breaking news (2 NewsAPI calls)
 * 2. LLM extracts confirmed events (not predictions/speculation)
 * 3. Fetch active Polymarket markets, LLM matches events to markets
 * 4. If confirmed outcome's price < 90¢, it's a buy signal
 */

import { elizaLogger, IAgentRuntime, ModelType } from "@elizaos/core";
import { BaseStrategy } from "./BaseStrategy.js";
import { MarketOpportunity, MarketData } from "../types.js";
import { getNewsService, NewsArticle } from "../../news/news-service.js";

export interface NewsArbConfig {
  enabled: boolean;
  /** Price threshold — only buy if confirmed outcome is below this (e.g. 0.90 = 90¢) */
  maxPrice: number;
  /** Maximum number of markets to fetch from Gamma API per cycle */
  marketFetchLimit: number;
}

interface ConfirmedEvent {
  event: string;
  detail: string;
  sources: string[];
}

interface MarketMatch {
  conditionId: string;
  question: string;
  confirmedOutcome: "YES" | "NO";
  reasoning: string;
  currentPrice: number;
}

export class NewsArbStrategy extends BaseStrategy {
  private runtime: IAgentRuntime | null = null;

  constructor(config?: Partial<NewsArbConfig>) {
    super(
      "NewsArbStrategy",
      "News-latency arbitrage: buys confirmed-event outcomes that are still underpriced",
      {
        enabled: true,
        maxPrice: 0.90,
        marketFetchLimit: 100,
        ...config,
      }
    );
  }

  setRuntime(runtime: IAgentRuntime): void {
    this.runtime = runtime;
  }

  /**
   * Call the LLM with retry for transient errors (503 overloaded, etc.)
   */
  private async callLLM(prompt: string, maxRetries = 3): Promise<string> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.runtime!.useModel(ModelType.TEXT_LARGE, {
          prompt,
          stopSequences: [],
        });
        const text = typeof response === "string" ? response : String(response);
        if (!text || text.length === 0) throw new Error("Empty response from model");
        return text;
      } catch (error: any) {
        const msg = error?.message || String(error);
        const isRetryable = msg.includes("503") || msg.includes("overloaded") || msg.includes("UNAVAILABLE");
        if (isRetryable && attempt < maxRetries) {
          const delay = attempt * 10_000; // 10s, 20s, 30s
          elizaLogger.warn(
            `NewsArb: LLM overloaded (attempt ${attempt}/${maxRetries}), retrying in ${delay / 1000}s...`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error("LLM call failed after all retries");
  }

  async findOpportunities(
    openPositions: Map<string, any>
  ): Promise<MarketOpportunity[]> {
    if (!this.runtime) {
      elizaLogger.error("NewsArbStrategy: runtime not set");
      return [];
    }

    const cfg = this.config as NewsArbConfig;

    // Step 1: Fetch breaking news
    elizaLogger.info("NewsArb: Fetching breaking news...");
    const articles = await this.fetchBreakingNews();
    if (articles.length === 0) {
      elizaLogger.info("NewsArb: No articles fetched, skipping cycle");
      return [];
    }
    elizaLogger.info(`NewsArb: Got ${articles.length} articles`);

    // Step 2: Extract confirmed events via LLM
    elizaLogger.info("NewsArb: Extracting confirmed events...");
    const events = await this.extractConfirmedEvents(articles);
    if (events.length === 0) {
      elizaLogger.info("NewsArb: No confirmed events extracted, skipping cycle");
      return [];
    }
    elizaLogger.info(
      `NewsArb: Extracted ${events.length} confirmed events: ${events.map((e) => e.event).join(", ")}`
    );

    // Step 3: Fetch active markets and match via LLM
    elizaLogger.info("NewsArb: Searching for matching Polymarket markets...");
    const matches = await this.searchMatchingMarkets(events, cfg.marketFetchLimit);
    if (matches.length === 0) {
      elizaLogger.info("NewsArb: No market matches found");
      return [];
    }
    elizaLogger.info(
      `NewsArb: Found ${matches.length} market matches`
    );

    // Step 4: Evaluate each match — is the price still undervalued?
    const opportunities: MarketOpportunity[] = [];
    for (const match of matches) {
      // Skip markets we already have positions in
      if (openPositions.has(match.conditionId)) {
        elizaLogger.debug(`NewsArb: Already have position in ${match.question}`);
        continue;
      }

      if (match.currentPrice < cfg.maxPrice) {
        opportunities.push({
          marketId: match.conditionId,
          question: match.question,
          outcome: match.confirmedOutcome,
          currentPrice: match.currentPrice,
          predictedProbability: 0.95, // We believe the event is confirmed
          confidence: 0.95,
          expectedValue:
            (0.95 - match.currentPrice) *
            (Number(process.env.MAX_POSITION_SIZE) || 20),
          newsSignals: [
            `Confirmed event matched to market`,
            `LLM reasoning: ${match.reasoning}`,
          ],
          riskScore: 0.1, // Low risk — event is confirmed by news
        });

        elizaLogger.info(
          `NewsArb: OPPORTUNITY — "${match.question}" ${match.confirmedOutcome} @ ${(match.currentPrice * 100).toFixed(1)}¢ (< ${cfg.maxPrice * 100}¢ threshold)`
        );
      } else {
        elizaLogger.debug(
          `NewsArb: Price already caught up for "${match.question}" @ ${(match.currentPrice * 100).toFixed(1)}¢`
        );
      }
    }

    return opportunities;
  }

  /**
   * Fetch breaking news — 2 API calls via news service's fetchForArbitrage()
   */
  private async fetchBreakingNews(): Promise<NewsArticle[]> {
    try {
      const newsService = getNewsService();
      return await newsService.fetchForArbitrage();
    } catch (error) {
      elizaLogger.error("NewsArb: Failed to fetch news: " + error);
      return [];
    }
  }

  /**
   * Use LLM to extract confirmed real-world events from news articles.
   * We only want things that HAVE happened, not predictions or speculation.
   */
  private async extractConfirmedEvents(
    articles: NewsArticle[]
  ): Promise<ConfirmedEvent[]> {
    // Build a compact summary of articles for the LLM
    const articleSummary = articles
      .slice(0, 40) // Cap to avoid token overflow
      .map(
        (a, i) =>
          `[${i + 1}] ${a.title} — ${a.description || "No description"} (${a.source}, ${a.publishedAt.toISOString().slice(0, 10)})`
      )
      .join("\n");

    const prompt = `You are analyzing news articles to find CONFIRMED real-world events relevant to prediction markets.

ARTICLES:
${articleSummary}

INSTRUCTIONS:
- List events that HAVE HAPPENED or been OFFICIALLY CONFIRMED (not predictions, rumors, or speculation)
- Focus on events that could resolve a prediction market (elections, legislation, sports results, corporate actions, policy decisions, geopolitical events)
- For each event, provide the event summary, a brief detail, and which article numbers are sources
- If no articles contain confirmed events, return an empty array

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {"event": "short event summary", "detail": "brief detail of what happened", "sources": ["article source names"]}
]

If no confirmed events, respond with: []`;

    try {
      const text = await this.callLLM(prompt);
      // Extract JSON from response (handle potential markdown wrapping)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        elizaLogger.debug("NewsArb: LLM returned no JSON array for event extraction");
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter(
          (e: any) =>
            e && typeof e.event === "string" && typeof e.detail === "string"
        )
        .slice(0, 10); // Cap at 10 events
    } catch (error) {
      elizaLogger.error("NewsArb: Failed to extract events: " + error);
      return [];
    }
  }

  /**
   * Fetch active Polymarket markets from Gamma API, then use LLM to match
   * confirmed events to markets and determine which outcome the news confirms.
   */
  private async searchMatchingMarkets(
    events: ConfirmedEvent[],
    limit: number
  ): Promise<MarketMatch[]> {
    // Fetch top active markets by volume
    let markets: any[];
    try {
      const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${limit}&order=volumeNum&ascending=false`;
      const response = await fetch(url);
      if (!response.ok) {
        elizaLogger.error(`NewsArb: Gamma API returned ${response.status}`);
        return [];
      }
      markets = (await response.json()) as any[];
    } catch (error) {
      elizaLogger.error("NewsArb: Failed to fetch markets: " + error);
      return [];
    }

    if (!markets || markets.length === 0) {
      elizaLogger.debug("NewsArb: No active markets from Gamma API");
      return [];
    }

    elizaLogger.info(`NewsArb: Fetched ${markets.length} active markets for matching`);

    // Build compact market list for LLM
    const marketSummary = markets
      .map(
        (m: any, i: number) =>
          `[${i + 1}] "${m.question}" (ID: ${m.conditionId})`
      )
      .join("\n");

    const eventSummary = events
      .map((e, i) => `${i + 1}. ${e.event}: ${e.detail}`)
      .join("\n");

    const prompt = `You are matching confirmed real-world events to Polymarket prediction markets.

CONFIRMED EVENTS:
${eventSummary}

ACTIVE POLYMARKET MARKETS:
${marketSummary}

INSTRUCTIONS:
- For each confirmed event, find the Polymarket market(s) that it would resolve
- Determine whether the event confirms the YES or NO outcome
- Only match if you are CONFIDENT the event directly resolves or strongly implies the market outcome
- Do NOT match speculative or partial connections

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {"marketIndex": 1, "confirmedOutcome": "YES", "reasoning": "brief explanation of why this event resolves this market"}
]

If no matches, respond with: []`;

    try {
      const text = await this.callLLM(prompt);
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        elizaLogger.debug("NewsArb: LLM returned no JSON for market matching");
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const matches: MarketMatch[] = [];
      for (const match of parsed) {
        const idx = match.marketIndex - 1; // Convert 1-indexed to 0-indexed
        if (idx < 0 || idx >= markets.length) continue;

        const market = markets[idx];
        const outcome = match.confirmedOutcome as "YES" | "NO";
        if (outcome !== "YES" && outcome !== "NO") continue;

        // Get current price for the confirmed outcome
        let price = 0.5; // default
        if (market.outcomePrices) {
          try {
            const prices = JSON.parse(market.outcomePrices);
            price = parseFloat(outcome === "YES" ? prices[0] : prices[1]);
          } catch {
            // fallback
          }
        }

        matches.push({
          conditionId: market.conditionId,
          question: market.question,
          confirmedOutcome: outcome,
          reasoning: match.reasoning || "",
          currentPrice: price,
        });
      }

      return matches;
    } catch (error) {
      elizaLogger.error("NewsArb: Failed to match markets: " + error);
      return [];
    }
  }

  /**
   * Required by IStrategy — not used directly since findOpportunities
   * handles the full pipeline, but implemented for interface compliance.
   */
  async analyzeMarket(
    market: MarketData,
    _config?: any
  ): Promise<MarketOpportunity[]> {
    // Individual market analysis isn't meaningful for this strategy
    // since it requires cross-referencing news with markets
    return [];
  }
}
