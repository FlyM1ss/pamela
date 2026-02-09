/**
 * Opportunity Evaluator Module
 *
 * Simplified for the news-arbitrage strategy: confirmed events get
 * a fixed position size (MAX_POSITION_SIZE from env). No Kelly Criterion
 * or complex confidence adjustments needed — confidence is binary
 * (event confirmed = high confidence).
 */

import { TradingConfig } from "../../config/trading-config.js";
import { MarketOpportunity, TradingDecision } from "./types.js";

export class OpportunityEvaluator {
  private tradingConfig: TradingConfig;

  constructor(tradingConfig: TradingConfig) {
    this.tradingConfig = tradingConfig;
  }

  async evaluate(opportunity: MarketOpportunity): Promise<TradingDecision> {
    const positionSize = Math.min(
      this.tradingConfig.maxPositionSize,
      this.tradingConfig.riskLimitPerTrade
    );

    // For news-arb: confidence is already set by the strategy (0.95 for confirmed events)
    const shouldTrade =
      opportunity.confidence >= this.tradingConfig.minConfidenceThreshold &&
      positionSize > 0;

    const reasoning = shouldTrade
      ? `News-arb: confirmed event, ${opportunity.outcome} @ ${(opportunity.currentPrice * 100).toFixed(1)}¢. ${opportunity.newsSignals.join(". ")}`
      : `Below confidence threshold (${(opportunity.confidence * 100).toFixed(1)}% < ${(this.tradingConfig.minConfidenceThreshold * 100).toFixed(0)}%)`;

    return {
      shouldTrade,
      marketId: opportunity.marketId,
      outcome: opportunity.outcome,
      size: positionSize,
      price: opportunity.currentPrice,
      confidence: opportunity.confidence,
      reasoning,
    };
  }
}
