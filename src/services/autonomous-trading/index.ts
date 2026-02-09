/**
 * Autonomous Trading Service - Main Orchestrator
 * 
 * This service coordinates autonomous trading operations on Polymarket prediction markets.
 * It manages the complete trading lifecycle from market scanning to trade execution.
 * 
 * ## Architecture
 * 
 * The service is composed of several specialized modules:
 * - MarketScanner: Discovers trading opportunities based on configured strategies
 * - OpportunityEvaluator: Evaluates opportunities and determines position sizing
 * - TradeExecutor: Handles order placement and execution through CLOB API
 * - PositionManager: Tracks portfolio positions and P&L
 * - BalanceManager: Monitors USDC balance with smart caching
 * - DirectOrder: Direct CLOB API integration for programmatic order placement
 * 
 * ## Trading Strategies
 * 
 * Currently supports:
 * 1. Simple Threshold Strategy - Trades when prices hit configured thresholds
 * 2. ML Strategy (planned) - Uses machine learning for probability prediction
 * 
 * ## Adding New Strategies
 * 
 * To implement a new trading strategy:
 * 1. Extend MarketScanner with a new find*Opportunities() method
 * 2. Customize OpportunityEvaluator for position sizing logic
 * 3. Update TradingConfig with strategy-specific parameters
 * 
 * ## Configuration
 * 
 * Environment variables:
 * - UNSUPERVISED_MODE: Enable autonomous trading (default: false)
 * - MAX_POSITION_SIZE: Maximum position size per trade (default: 100)
 * - MIN_CONFIDENCE_THRESHOLD: Minimum confidence to trade (default: 0.7)
 * - MAX_DAILY_TRADES: Daily trade limit (default: 10)
 * - MAX_OPEN_POSITIONS: Maximum concurrent positions (default: 20)
 * - SIMPLE_STRATEGY_ENABLED: Use simple threshold strategy
 * - USE_HARDCODED_MARKETS: Monitor specific markets only
 * 
 * ## Risk Management
 * 
 * Built-in safeguards:
 * - Daily trade limits
 * - Maximum position limits
 * - Minimum confidence thresholds
 * - Balance validation before trades
 * - Automatic L1->L2 deposit handling
 */

import { elizaLogger, IAgentRuntime, Service } from "@elizaos/core";
import { TradingConfig } from "../../config/trading-config.js";
import { initializeClobClient } from "@theschein/plugin-polymarket";

import { OpportunityEvaluator } from "./opportunity-evaluator.js";
import { TradeExecutor } from "./trade-executor.js";
import { PositionManager } from "./position-manager.js";
import { BalanceManager } from "./balance-manager.js";
import { TradingDecision, MarketOpportunity } from "./types.js";
import { TradingReportService } from "./trading-report.js";
import { NewsArbStrategy } from "./strategies/NewsArbStrategy.js";

export class AutonomousTradingService extends Service {
  private tradingConfig: TradingConfig;
  private dailyTradeCount: number = 0;
  private lastResetDate: Date;
  private isRunning: boolean = false;
  private scanInterval: NodeJS.Timeout | null = null;
  private clobClient: any = null;

  // Modular components
  private opportunityEvaluator: OpportunityEvaluator | null = null;
  private tradeExecutor: TradeExecutor | null = null;
  private positionManager: PositionManager | null = null;
  private balanceManager: BalanceManager | null = null;
  private newsArbStrategy: NewsArbStrategy | null = null;
  private reportService: TradingReportService | null = null;
  private snapshotInterval: NodeJS.Timeout | null = null;

  private static instance: AutonomousTradingService | null = null;

  static get serviceType(): string {
    return "AUTONOMOUS_TRADING";
  }

  get capabilityDescription(): string {
    return "Autonomous trading service for prediction markets";
  }

  constructor() {
    super();
    // Read config fresh from environment
    this.tradingConfig = {
      unsupervisedMode: process.env.UNSUPERVISED_MODE === "true",
      maxPositionSize: Number(process.env.MAX_POSITION_SIZE) || 100,
      minConfidenceThreshold:
        Number(process.env.MIN_CONFIDENCE_THRESHOLD) || 0.7,
      maxDailyTrades: Number(process.env.MAX_DAILY_TRADES) || 10,
      maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 20,
      riskLimitPerTrade: Number(process.env.RISK_LIMIT_PER_TRADE) || 50,
      autoRedemptionEnabled: process.env.AUTO_REDEMPTION === "true",
      socialBroadcastEnabled: process.env.SOCIAL_BROADCAST === "true",
      simpleStrategyEnabled: process.env.SIMPLE_STRATEGY_ENABLED === "true",
      useHardcodedMarkets: process.env.USE_HARDCODED_MARKETS === "true",
    };
    this.lastResetDate = new Date();
  }

  static async start(
    runtime: IAgentRuntime
  ): Promise<AutonomousTradingService> {
    elizaLogger.info("Starting Autonomous Trading Service");
    if (!AutonomousTradingService.instance) {
      AutonomousTradingService.instance = new AutonomousTradingService();
      await AutonomousTradingService.instance.initialize(runtime);
    }
    return AutonomousTradingService.instance;
  }

  static async stop(_runtime: IAgentRuntime): Promise<void> {
    elizaLogger.info("Stopping Autonomous Trading Service");
    if (AutonomousTradingService.instance) {
      await AutonomousTradingService.instance.stop();
      AutonomousTradingService.instance = null;
    }
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    elizaLogger.info("🤖 === AUTONOMOUS TRADING SERVICE STARTING ===");
    elizaLogger.info(
      "Configuration: " +
        JSON.stringify({
          unsupervisedMode: this.tradingConfig.unsupervisedMode,
          simpleStrategy: process.env.SIMPLE_STRATEGY_ENABLED,
          hardcodedMarkets: process.env.USE_HARDCODED_MARKETS,
          maxDailyTrades: this.tradingConfig.maxDailyTrades,
          maxPositionSize: this.tradingConfig.maxPositionSize,
        })
    );

    // Initialize CLOB client for market data
    try {
      this.clobClient = await initializeClobClient(runtime);
      elizaLogger.info("CLOB client initialized successfully");
    } catch (error) {
      elizaLogger.error("Failed to initialize CLOB client: " + error);
      return;
    }

    // Initialize modular components
    await this.initializeComponents(runtime);

    // Check initial balance
    await this.balanceManager?.logInitialBalance();

    if (!this.tradingConfig.unsupervisedMode) {
      elizaLogger.info(
        "⚠️  UNSUPERVISED MODE DISABLED - Running in monitoring mode only"
      );
      elizaLogger.info(
        "📊 Markets will be scanned but NO trades will be executed"
      );
      elizaLogger.info(
        "💡 To enable trading: Set UNSUPERVISED_MODE=true in .env"
      );
    } else {
      elizaLogger.info(
        "🚨 UNSUPERVISED MODE ENABLED - Trades will be executed automatically!"
      );
    }

    await this.positionManager?.loadExistingPositions();

    // Start reporting service
    this.reportService = new TradingReportService();
    await this.reportService.start();

    // Write snapshot every 15 minutes + daily report every 6 hours
    this.snapshotInterval = setInterval(async () => {
      try {
        await this.reportService?.writeSnapshot();
        // Write daily report every 6 hours so there's always a recent one
        const hour = new Date().getHours();
        if (hour % 6 === 0) {
          const { getNewsService } = await import("../../services/news/news-service.js");
          const newsApiCalls = getNewsService().getDailyRequestCount();
          await this.reportService?.writeDailyReport(newsApiCalls);
        }
      } catch (err) {
        elizaLogger.debug("Snapshot/report write failed: " + err);
      }
    }, 15 * 60 * 1000);

    this.startAutonomousTrading();
  }

  private async initializeComponents(runtime: IAgentRuntime): Promise<void> {
    this.positionManager = new PositionManager(runtime);

    // Initialize NewsArbStrategy as the sole strategy
    this.newsArbStrategy = new NewsArbStrategy({
      enabled: true,
      maxPrice: 0.90,
      marketFetchLimit: 100,
    });
    this.newsArbStrategy.setRuntime(runtime);
    elizaLogger.info("Initialized NewsArbStrategy (news-latency arbitrage)");

    this.opportunityEvaluator = new OpportunityEvaluator(this.tradingConfig);
    this.tradeExecutor = new TradeExecutor(
      runtime,
      this.clobClient,
      this.tradingConfig
    );
    this.balanceManager = new BalanceManager(runtime);
  }

  private startAutonomousTrading(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    elizaLogger.info(
      "📡 Starting news-arbitrage monitoring — scanning every 30 minutes"
    );

    this.scanInterval = setInterval(async () => {
      elizaLogger.info("⏰ Running scheduled news-arb scan...");
      await this.scanAndTrade();
    }, 30 * 60 * 1000); // 30 minutes

    // Initial scan
    elizaLogger.info("🔍 Running initial news-arb scan...");
    this.scanAndTrade();
  }

  private async scanAndTrade(): Promise<void> {
    try {
      this.checkDailyReset();

      if (!this.canTrade()) {
        elizaLogger.debug("Trading conditions not met, skipping scan");
        return;
      }

      if (!this.newsArbStrategy || !this.newsArbStrategy.isActive()) {
        elizaLogger.debug("NewsArbStrategy not active, skipping scan");
        return;
      }

      // Run the news-arb pipeline
      const opportunities = await this.newsArbStrategy.findOpportunities(
        this.positionManager!.getOpenPositions()
      );

      if (opportunities.length > 0) {
        elizaLogger.info(
          `✨ Found ${opportunities.length} news-arb opportunities!`
        );
        for (const opp of opportunities) {
          elizaLogger.info(
            `  📈 ${opp.question}: ${opp.outcome} @ ${(opp.currentPrice * 100).toFixed(1)}¢`
          );
        }
      } else {
        elizaLogger.info("No news-arb opportunities this cycle");
      }

      const decisions: TradingDecision[] = [];

      for (const opportunity of opportunities) {
        if (!this.canTrade()) break;

        const decision = await this.opportunityEvaluator!.evaluate(opportunity);
        decisions.push(decision);

        if (decision.shouldTrade) {
          if (this.tradingConfig.unsupervisedMode) {
            elizaLogger.info(`🎲 EXECUTING TRADE: ${opportunity.question}`);
            await this.handleTrade(decision);
          } else {
            elizaLogger.info(
              `📋 WOULD TRADE (monitoring mode): ${opportunity.question}`
            );
            elizaLogger.info(`   Details: ${decision.reasoning}`);
          }
        } else {
          elizaLogger.debug(`❌ Skipping opportunity: ${decision.reasoning}`);
        }
      }

      // Record scan in report
      try {
        this.reportService?.recordScan(100, opportunities, decisions);
      } catch (err) {
        elizaLogger.debug("Report recording failed: " + err);
      }
    } catch (error) {
      elizaLogger.error("Error during news-arb scan: " + error);
    }
  }

  private async handleTrade(decision: TradingDecision): Promise<void> {
    // Check wallet balance before attempting to place order
    const balanceCheck = await this.balanceManager!.checkBalance(decision.size);
    if (!balanceCheck.hasEnoughBalance) {
      elizaLogger.error(
        `Insufficient balance for trade. Required: $${decision.size}, Available: $${balanceCheck.usdcBalance}`
      );
      elizaLogger.info(
        "⚠️  Trade skipped due to insufficient balance. Consider depositing USDC to your Polymarket account."
      );
      return;
    }

    elizaLogger.info(
      `✅ Balance check passed. Available: $${balanceCheck.usdcBalance}, Required: $${decision.size}`
    );

    // Execute the trade
    const tradeResult = await this.tradeExecutor!.executeTrade(decision);

    if (tradeResult.success) {
      this.dailyTradeCount++;
      // Reload positions after successful trade
      await this.positionManager!.refreshPositions();
    } else {
      // Check if it's a balance/allowance error and try to handle it
      if (
        tradeResult.error &&
        tradeResult.error.includes("not enough balance / allowance")
      ) {
        elizaLogger.info(
          "Detected L2 balance issue, attempting automatic deposit from L1..."
        );

        // Try to deposit and retry the order
        const depositSuccess = await this.tradeExecutor!.handleL2Deposit(
          decision.size
        );
        if (depositSuccess) {
          elizaLogger.info("Deposit successful, retrying order...");

          // Wait a bit for L2 to recognize the deposit
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Retry the order
          const retryResult = await this.tradeExecutor!.executeTrade(decision);
          if (retryResult.success) {
            this.dailyTradeCount++;
            await this.positionManager!.refreshPositions();
            elizaLogger.info(
              "Trade executed successfully after deposit: " + retryResult.orderId
            );
          } else {
            elizaLogger.error(
              "Trade still failed after deposit: " + retryResult.error
            );
          }
        } else {
          elizaLogger.error("Could not complete L2 deposit, trade cancelled");
        }
      }
    }
  }

  private checkDailyReset(): void {
    const now = new Date();
    if (now.getDate() !== this.lastResetDate.getDate()) {
      this.dailyTradeCount = 0;
      this.lastResetDate = now;
      elizaLogger.info("Daily trade counter reset");
    }
  }

  private canTrade(): boolean {
    if (this.dailyTradeCount >= this.tradingConfig.maxDailyTrades) {
      elizaLogger.debug("Daily trade limit reached");
      return false;
    }

    const positionCount = this.positionManager?.getPositionCount() || 0;
    if (positionCount >= this.tradingConfig.maxOpenPositions) {
      elizaLogger.debug("Maximum open positions reached");
      return false;
    }

    if (this.tradingConfig.tradingHoursRestriction) {
      const now = new Date();
      const hour = now.getHours();
      const { startHour, endHour } = this.tradingConfig.tradingHoursRestriction;

      if (hour < startHour || hour >= endHour) {
        elizaLogger.debug("Outside trading hours");
        return false;
      }
    }

    return true;
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    // Write final report on shutdown
    try {
      const { getNewsService } = await import("../../services/news/news-service.js");
      const newsApiCalls = getNewsService().getDailyRequestCount();
      const reportPath = await this.reportService?.stop(newsApiCalls);
      elizaLogger.info(`Final report written to ${reportPath}`);
    } catch (err) {
      elizaLogger.warn("Could not write final report: " + err);
    }
    elizaLogger.info("Autonomous Trading Service stopped");
  }

  // Public methods for status and control
  getStatus(): string {
    const positionSummary = this.positionManager?.getPositionSummary() || "No positions";
    const balanceStatus = this.balanceManager?.getBalanceStatus() || "Balance unknown";
    
    const strategyStatus = this.newsArbStrategy
      ? `\n\n📊 Strategy: ${this.newsArbStrategy.name} (${this.newsArbStrategy.isActive() ? "✅ Active" : "❌ Inactive"})`
      : "";
    
    return `
🤖 Autonomous Trading Service Status:
- Service: ${this.isRunning ? "✅ Running" : "❌ Stopped"}
- Mode: ${this.tradingConfig.unsupervisedMode ? "🚨 Unsupervised (Live Trading)" : "👁️ Monitoring Only"}
- Daily Trades: ${this.dailyTradeCount}/${this.tradingConfig.maxDailyTrades}
${strategyStatus}
${positionSummary}

${balanceStatus}
    `.trim();
  }

  getDailyTradeCount(): number {
    return this.dailyTradeCount;
  }

  getTradingConfig(): TradingConfig {
    return this.tradingConfig;
  }
}