import { logger } from "@elizaos/core";
import axios from "axios";
import { NewsConfig, NewsCategory, loadNewsConfig } from "./news-config";
import { MarketKeywordExtractor, ExtractedKeywords } from "./market-keyword-extractor";

export interface NewsArticle {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: Date;
  sentiment?: "positive" | "negative" | "neutral";
  relevanceScore?: number;
  categories?: string[];
}

export interface NewsSignal {
  market: string;
  signal: "bullish" | "bearish" | "neutral";
  confidence: number;
  articles: NewsArticle[];
}

/**
 * Rate-limited news service that conserves API calls.
 *
 * Strategy: fetch top headlines ONCE per cycle (1 API call), then match
 * them locally against market keywords. Only does targeted searches for
 * high-priority markets, with aggressive caching.
 *
 * Budget: ~20 API calls/day (well within NewsAPI free tier of 100/day)
 */
export class NewsService {
  private config: NewsConfig;
  private headlineCache: { data: NewsArticle[]; timestamp: number } | null = null;
  private searchCache: Map<string, { data: NewsArticle[]; timestamp: number }> = new Map();
  private activeApiKeys: Map<string, string> = new Map();
  private dailyRequestCount: number = 0;
  private lastResetDate: string = new Date().toDateString();

  // Rate limiting
  private static readonly MAX_DAILY_REQUESTS = 95; // ~50 searches + ~48 headline fetches
  private static readonly HEADLINE_CACHE_TTL = 30 * 60 * 1000; // 30 min for headlines
  private static readonly SEARCH_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours for searches
  private static readonly MAX_SEARCHES_PER_CYCLE = 8; // Max targeted searches per scan
  private searchesThisCycle: number = 0;

  constructor(customConfig?: Partial<NewsConfig>) {
    this.config = loadNewsConfig(customConfig);
    this.initializeApiKeys();

    if (this.activeApiKeys.size === 0) {
      logger.warn("No news API keys configured - news service will be limited");
    } else {
      logger.info(`News service initialized with ${this.activeApiKeys.size} sources`);
    }
  }

  private initializeApiKeys(): void {
    for (const source of this.config.sources) {
      if (source.enabled) {
        const apiKey = process.env[source.apiKeyEnvVar];
        if (apiKey) {
          this.activeApiKeys.set(source.name, apiKey);
          logger.info(`Enabled news source: ${source.name}`);
        } else {
          logger.warn(`${source.name} enabled but ${source.apiKeyEnvVar} not set`);
        }
      }
    }
  }

  /** Reset per-cycle search counter (called at start of each scan) */
  resetCycleCounter(): void {
    this.searchesThisCycle = 0;
  }

  private checkDailyReset(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRequestCount = 0;
      this.lastResetDate = today;
      logger.info("NewsAPI daily request counter reset");
    }
  }

  private canMakeRequest(): boolean {
    this.checkDailyReset();
    if (this.dailyRequestCount >= NewsService.MAX_DAILY_REQUESTS) {
      logger.warn(`NewsAPI daily limit reached (${this.dailyRequestCount}/${NewsService.MAX_DAILY_REQUESTS})`);
      return false;
    }
    return true;
  }

  private trackRequest(): void {
    this.dailyRequestCount++;
    if (this.dailyRequestCount % 10 === 0) {
      logger.info(`NewsAPI requests today: ${this.dailyRequestCount}/${NewsService.MAX_DAILY_REQUESTS}`);
    }
  }

  /**
   * Fetch top headlines (1 API call, cached for 30 min)
   */
  private async fetchHeadlines(): Promise<NewsArticle[]> {
    if (!this.activeApiKeys.has("NewsAPI")) return [];

    // Return cached if fresh
    if (this.headlineCache && Date.now() - this.headlineCache.timestamp < NewsService.HEADLINE_CACHE_TTL) {
      return this.headlineCache.data;
    }

    if (!this.canMakeRequest()) {
      return this.headlineCache?.data || [];
    }

    try {
      logger.info("Fetching top headlines from NewsAPI");
      this.trackRequest();

      const response = await axios.get("https://newsapi.org/v2/top-headlines", {
        params: {
          apiKey: this.activeApiKeys.get("NewsAPI"),
          country: "us",
          pageSize: 100,
        },
        timeout: 10000,
      });

      const articles: NewsArticle[] = (response.data.articles || [])
        .filter((article: any) => article.title && article.description)
        .map((article: any) => {
          const text = `${article.title} ${article.description}`;
          return {
            title: article.title,
            description: article.description,
            url: article.url,
            source: article.source?.name || "Unknown",
            publishedAt: new Date(article.publishedAt),
            sentiment: this.analyzeSentiment(text),
            relevanceScore: 1.0,
            categories: this.categorizeArticle(text).map(c => c.name),
          };
        });

      this.headlineCache = { data: articles, timestamp: Date.now() };
      logger.info(`Fetched ${articles.length} headlines (API calls today: ${this.dailyRequestCount})`);
      return articles;
    } catch (error: any) {
      if (error?.response?.status === 429) {
        logger.warn("NewsAPI rate limited (429) - using cached headlines");
      } else {
        logger.error("Failed to fetch headlines:", error?.message || error);
      }
      return this.headlineCache?.data || [];
    }
  }

  /**
   * Get market signals by matching cached headlines against market keywords.
   * Only makes a targeted API search for high-priority markets (up to MAX_SEARCHES_PER_CYCLE).
   */
  async getMarketSignals(marketTitle: string, marketRules?: string): Promise<NewsSignal> {
    const keywords = MarketKeywordExtractor.extractKeywords(marketTitle, marketRules);

    // Step 1: Match against cached headlines (FREE - no API call)
    const headlines = this.headlineCache?.data || [];
    const matchedArticles = this.matchArticlesLocally(headlines, keywords, marketTitle);

    // Step 2: If we have headline matches, use those (no API call needed)
    if (matchedArticles.length >= 2) {
      return this.buildSignal(marketTitle, matchedArticles);
    }

    // Step 3: Check search cache
    const searchQuery = MarketKeywordExtractor.createSearchQuery(keywords);
    const cacheKey = `search_${searchQuery}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < NewsService.SEARCH_CACHE_TTL) {
      const cachedMatches = this.matchArticlesLocally(cached.data, keywords, marketTitle);
      if (cachedMatches.length > 0) {
        return this.buildSignal(marketTitle, cachedMatches);
      }
    }

    // Step 4: Targeted search (costs 1 API call) - only if under cycle limit
    if (this.searchesThisCycle < NewsService.MAX_SEARCHES_PER_CYCLE && this.canMakeRequest()) {
      const searchResults = await this.targetedSearch(searchQuery);
      this.searchesThisCycle++;

      if (searchResults.length > 0) {
        this.searchCache.set(cacheKey, { data: searchResults, timestamp: Date.now() });
        const searchMatches = this.matchArticlesLocally(searchResults, keywords, marketTitle);
        if (searchMatches.length > 0) {
          return this.buildSignal(marketTitle, searchMatches);
        }
      }
    }

    // No relevant news found - return neutral
    return {
      market: marketTitle,
      signal: "neutral",
      confidence: 0,
      articles: [],
    };
  }

  /**
   * Match articles against market keywords locally (no API call)
   */
  private matchArticlesLocally(
    articles: NewsArticle[],
    keywords: ExtractedKeywords,
    marketTitle: string
  ): NewsArticle[] {
    const marketLower = marketTitle.toLowerCase();

    // Extract key terms from market title for matching
    const keyTerms = marketLower
      .replace(/will|before|after|by|in \d{4}|yes|no|\?|the|a|an/gi, "")
      .split(/\s+/)
      .filter(w => w.length > 3);

    return articles
      .map(article => {
        const articleText = `${article.title} ${article.description}`.toLowerCase();
        let score = 0;

        // Check keyword matches
        const keywordScore = MarketKeywordExtractor.calculateRelevanceScore(
          `${article.title} ${article.description}`, keywords
        );
        score += keywordScore * 2;

        // Check direct term matches
        for (const term of keyTerms) {
          if (articleText.includes(term)) {
            score += 0.3;
          }
        }

        return { ...article, relevanceScore: Math.min(score, 1.0) };
      })
      .filter(a => a.relevanceScore >= 0.3)
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, 10);
  }

  /**
   * Targeted search for a specific query (1 API call, cached for 2 hours)
   */
  private async targetedSearch(query: string): Promise<NewsArticle[]> {
    if (!this.activeApiKeys.has("NewsAPI") || !this.canMakeRequest()) {
      return [];
    }

    try {
      logger.info(`Targeted NewsAPI search: "${query}" (cycle: ${this.searchesThisCycle + 1}/${NewsService.MAX_SEARCHES_PER_CYCLE})`);
      this.trackRequest();

      const response = await axios.get("https://newsapi.org/v2/everything", {
        params: {
          apiKey: this.activeApiKeys.get("NewsAPI"),
          q: query,
          language: "en",
          sortBy: "relevancy",
          pageSize: 20,
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
        timeout: 10000,
      });

      return (response.data.articles || [])
        .filter((article: any) => article.title && article.description)
        .map((article: any) => {
          const text = `${article.title} ${article.description}`;
          return {
            title: article.title,
            description: article.description,
            url: article.url,
            source: article.source?.name || "Unknown",
            publishedAt: new Date(article.publishedAt),
            sentiment: this.analyzeSentiment(text),
            relevanceScore: 1.0,
            categories: this.categorizeArticle(text).map(c => c.name),
          };
        });
    } catch (error: any) {
      if (error?.response?.status === 429) {
        logger.warn("NewsAPI rate limited (429) on search - skipping");
      } else {
        logger.error(`Targeted search failed for "${query}":`, error?.message || error);
      }
      return [];
    }
  }

  /**
   * Build a NewsSignal from matched articles
   */
  private buildSignal(marketTitle: string, articles: NewsArticle[]): NewsSignal {
    if (articles.length === 0) {
      return { market: marketTitle, signal: "neutral", confidence: 0, articles: [] };
    }

    let positiveCount = 0;
    let negativeCount = 0;
    let totalWeight = 0;

    articles.forEach(article => {
      const weight = article.relevanceScore || 0.5;
      totalWeight += weight;
      if (article.sentiment === "positive") positiveCount += weight;
      else if (article.sentiment === "negative") negativeCount += weight;
    });

    const positiveRatio = positiveCount / totalWeight;
    const negativeRatio = negativeCount / totalWeight;

    let signal: "bullish" | "bearish" | "neutral";
    let confidence: number;

    if (positiveRatio > 0.6) {
      signal = "bullish";
      confidence = positiveRatio;
    } else if (negativeRatio > 0.6) {
      signal = "bearish";
      confidence = negativeRatio;
    } else {
      signal = "neutral";
      confidence = 0.5;
    }

    const avgRelevance = articles.reduce((sum, a) => sum + (a.relevanceScore || 0), 0) / articles.length;
    const articleCountBonus = Math.min(0.2, articles.length * 0.02);
    confidence = Math.min(0.95, confidence * avgRelevance + articleCountBonus);

    return {
      market: marketTitle,
      signal,
      confidence,
      articles: articles.slice(0, 5),
    };
  }

  async searchNews(query: string): Promise<NewsArticle[]> {
    // First try headline matching
    const headlines = this.headlineCache?.data || [];
    if (headlines.length > 0) {
      const keywords = MarketKeywordExtractor.extractKeywords(query);
      const matches = this.matchArticlesLocally(headlines, keywords, query);
      if (matches.length > 0) return matches;
    }

    // Fall back to targeted search
    return this.targetedSearch(query);
  }

  async getLatestHeadlines(): Promise<NewsArticle[]> {
    return this.fetchHeadlines();
  }

  private categorizeArticle(text: string): NewsCategory[] {
    const lowerText = text.toLowerCase();
    const matchedCategories: NewsCategory[] = [];

    for (const category of this.config.categories) {
      if (!category.enabled) continue;
      let matchCount = 0;
      for (const keyword of category.keywords) {
        if (lowerText.includes(keyword.toLowerCase())) matchCount++;
      }
      if (matchCount > 0) matchedCategories.push(category);
    }

    return matchedCategories;
  }

  private analyzeSentiment(text: string): "positive" | "negative" | "neutral" {
    const lowerText = text.toLowerCase();
    let positiveScore = 0;
    let negativeScore = 0;

    this.config.sentimentWords.positive.forEach(word => {
      if (lowerText.includes(word)) positiveScore++;
    });
    this.config.sentimentWords.negative.forEach(word => {
      if (lowerText.includes(word)) negativeScore++;
    });

    if (positiveScore > negativeScore + 1) return "positive";
    if (negativeScore > positiveScore + 1) return "negative";
    return "neutral";
  }

  updateConfig(newConfig: Partial<NewsConfig>): void {
    this.config = loadNewsConfig({ ...this.config, ...newConfig });
    this.initializeApiKeys();
    logger.info("News service configuration updated");
  }

  getConfig(): NewsConfig {
    return this.config;
  }

  getActiveSourcesCount(): number {
    return this.activeApiKeys.size;
  }

  getDailyRequestCount(): number {
    return this.dailyRequestCount;
  }

  /**
   * Fetch articles for the news-arbitrage strategy.
   * Makes exactly 2 API calls per invocation:
   *   1. Top headlines (broad coverage)
   *   2. "Breaking" keyword search (time-sensitive events)
   * Returns the combined, deduplicated list.
   */
  async fetchForArbitrage(): Promise<NewsArticle[]> {
    const combined: NewsArticle[] = [];

    // Call 1: Top headlines
    const headlines = await this.fetchHeadlines();
    combined.push(...headlines);

    // Call 2: "Breaking" search for time-sensitive news
    if (this.canMakeRequest()) {
      try {
        logger.info("NewsArb: Targeted search for breaking news");
        this.trackRequest();

        const apiKey = this.activeApiKeys.get("NewsAPI");
        if (apiKey) {
          const response = await axios.get(
            "https://newsapi.org/v2/everything",
            {
              params: {
                apiKey,
                q: "breaking OR confirmed OR officially OR announced OR signed",
                language: "en",
                sortBy: "publishedAt",
                pageSize: 50,
                from: new Date(
                  Date.now() - 3 * 24 * 60 * 60 * 1000
                ).toISOString(),
              },
              timeout: 10000,
            }
          );

          const articles: NewsArticle[] = (response.data.articles || [])
            .filter((a: any) => a.title && a.description)
            .map((a: any) => ({
              title: a.title,
              description: a.description,
              url: a.url,
              source: a.source?.name || "Unknown",
              publishedAt: new Date(a.publishedAt),
              sentiment: this.analyzeSentiment(
                `${a.title} ${a.description}`
              ),
              relevanceScore: 1.0,
            }));

          // Deduplicate by title
          const seen = new Set(combined.map((a) => a.title));
          for (const article of articles) {
            if (!seen.has(article.title)) {
              combined.push(article);
              seen.add(article.title);
            }
          }

          logger.info(
            `NewsArb: Breaking search returned ${articles.length} articles (${combined.length} total after dedup, API calls today: ${this.dailyRequestCount})`
          );
        }
      } catch (error: any) {
        if (error?.response?.status === 429) {
          logger.warn("NewsArb: Rate limited on breaking search");
        } else {
          logger.error("NewsArb: Breaking search failed:", error?.message);
        }
      }
    }

    return combined;
  }
}

// Singleton instance
let newsServiceInstance: NewsService | null = null;

export function getNewsService(customConfig?: Partial<NewsConfig>): NewsService {
  if (!newsServiceInstance) {
    newsServiceInstance = new NewsService(customConfig);
  }
  return newsServiceInstance;
}
