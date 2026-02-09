/**
 * Hardcoded markets for testing the trading pipeline
 * These markets are monitored continuously for trading opportunities
 */

// Simply add condition IDs here - all market details will be fetched automatically
// You can find condition IDs from Polymarket URLs:
// https://polymarket.com/event/[slug]?conditionId=0x...
// Last updated: 2026-02-07
export const HARDCODED_MARKET_IDS: string[] = [
  // Fed / Macro (high relevance to crypto + economy)
  "0x46d40e851b24d9b0af4bc1942ccd86439cae82a9011767da14950df0ad997adf", // Will Trump nominate Judy Shelton as next Fed chair? ($58M vol)
  "0x61b66d02793b4a68ab0cc25be60d65f517fe18c7d654041281bb130341244fcc", // Will Trump nominate Kevin Warsh as next Fed chair? ($32M vol)
  "0xdeb615a52cd114e5aa27d8344ae506a72bea81f6ed13f5915f050b615a193c20", // Fed decrease rates 50+ bps March 2026? ($29M vol)
  "0x25aa90b3cd98305e849189b4e8b770fc77fe89bccb7cf9656468414e01145d38", // Fed increase rates 25+ bps March 2026? ($28M vol)

  // Geopolitics (news-driven, good for sentiment analysis)
  "0xd595eb9b81885ff018738300c79047e3ec89e87294424f57a29a7fa9162bf116", // Trump acquire Greenland before 2027? (12.5% YES, $26M vol)
  "0x70909f0ba8256a89c301da58812ae47203df54957a07c7f8b10235e877ad63c2", // Khamenei out as Supreme Leader by March 31? (16.5% YES, $10M vol)
  "0x3488f31e6449f9803f99a8b5dd232c7ad883637f1c86e6953305a2ef19c77f20", // US strikes Iran by Feb 28 2026? (23.5% YES, $9M vol)

  // Sports (high volume, clear resolution)
  "0xa0eafdfa7da17483796f77f4b287d28834ab97db4a9a6e999b52c1ba239bc2f3", // Seattle Seahawks win Super Bowl 2026? (68.2% YES, $11M vol)
  "0xc914317b14972d5d15f30740d3bdf32f4028877c13b9d7ccc78b4ba33f67fb1e", // New England Patriots win Super Bowl 2026? (31.8% YES, $15M vol)
];

// Simple trading strategy configuration
export const getSimpleStrategyConfig = () => ({
  // Buy when any outcome is below this price (represents high confidence)
  BUY_THRESHOLD: 0.1, // 10% - buy when something is very cheap (90% confidence on opposite)

  // Sell when any outcome is above this price (take profits)
  SELL_THRESHOLD: 0.9, // 90% - sell when something is very expensive

  // Minimum edge required to place a trade (price difference from threshold)
  MIN_EDGE: 0.02, // 2% minimum edge

  // Position size for test trades (in USDC)
  TEST_POSITION_SIZE: 10, // $10 per trade for testing

  // Enable the simple strategy (overrides ML-based decisions)
  ENABLED: process.env.SIMPLE_STRATEGY_ENABLED === "true",

  // Use hardcoded markets only (ignore market scanning)
  USE_HARDCODED_ONLY: process.env.USE_HARDCODED_MARKETS === "true",
});

export const SIMPLE_STRATEGY_CONFIG = getSimpleStrategyConfig();

/**
 * Get the list of market IDs to monitor
 * Returns hardcoded market IDs if enabled, otherwise returns null to scan all
 */
export function getMarketsToMonitor(): string[] | null {
  const config = getSimpleStrategyConfig();
  if (config.USE_HARDCODED_ONLY && HARDCODED_MARKET_IDS.length > 0) {
    return HARDCODED_MARKET_IDS;
  }
  return null;
}

/**
 * Check if a market is in the hardcoded list
 */
export function isHardcodedMarket(conditionId: string): boolean {
  return HARDCODED_MARKET_IDS.includes(conditionId);
}
