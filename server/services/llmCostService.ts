import { EventEmitter } from 'events';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { LLMModel, LLMProvider } from '../types/llm';

// Cost per 1K tokens for each model (in USD)
const COST_PER_1K_TOKENS: Record<LLMModel, { input: number; output: number }> = {
  [LLMModel.GPT_4]: { input: 0.03, output: 0.06 },
  [LLMModel.GPT_4_TURBO]: { input: 0.01, output: 0.03 },
  [LLMModel.GPT_3_5_TURBO]: { input: 0.0015, output: 0.002 },
  [LLMModel.CLAUDE_3_OPUS]: { input: 0.015, output: 0.075 },
  [LLMModel.CLAUDE_3_SONNET]: { input: 0.003, output: 0.015 },
  [LLMModel.CLAUDE_3_HAIKU]: { input: 0.00025, output: 0.00125 },
  [LLMModel.GEMINI_PRO]: { input: 0.00025, output: 0.0005 },
  [LLMModel.GEMINI_ULTRA]: { input: 0.001, output: 0.002 }
};

// Provider-specific cost optimization strategies
const COST_OPTIMIZATION_STRATEGIES: Record<LLMProvider, {
  maxTokens: number;
  temperature: number;
  fallbackModel: LLMModel;
}> = {
  [LLMProvider.OPENAI]: {
    maxTokens: 4000,
    temperature: 0.7,
    fallbackModel: LLMModel.GPT_3_5_TURBO
  },
  [LLMProvider.ANTHROPIC]: {
    maxTokens: 4000,
    temperature: 0.7,
    fallbackModel: LLMModel.CLAUDE_3_HAIKU
  },
  [LLMProvider.GEMINI]: {
    maxTokens: 4000,
    temperature: 0.7,
    fallbackModel: LLMModel.GEMINI_PRO
  }
};

interface CostMetrics {
  totalCost: number;
  costByProvider: Record<LLMProvider, number>;
  costByModel: Record<LLMModel, number>;
  tokenUsage: {
    input: number;
    output: number;
  };
}

interface CostOptimizationResult {
  recommendedModel: LLMModel;
  estimatedCost: number;
  estimatedTokens: number;
  strategy: string;
}

export class LLMCostService extends EventEmitter {
  private static instance: LLMCostService;
  private redis: RedisService;
  private readonly COST_KEY_PREFIX = 'llm:cost:';
  private readonly DAILY_COST_KEY_PREFIX = 'llm:cost:daily:';

  private constructor() {
    super();
    this.redis = RedisService.getInstance();
  }

  public static getInstance(): LLMCostService {
    if (!LLMCostService.instance) {
      LLMCostService.instance = new LLMCostService();
    }
    return LLMCostService.instance;
  }

  /**
   * Calculate cost for a specific model and token usage
   */
  public calculateCost(model: LLMModel, inputTokens: number, outputTokens: number): number {
    const costs = COST_PER_1K_TOKENS[model];
    const inputCost = (inputTokens / 1000) * costs.input;
    const outputCost = (outputTokens / 1000) * costs.output;
    return inputCost + outputCost;
  }

  /**
   * Track cost for a specific request
   */
  public async trackCost(
    provider: LLMProvider,
    model: LLMModel,
    inputTokens: number,
    outputTokens: number
  ): Promise<void> {
    try {
      const cost = this.calculateCost(model, inputTokens, outputTokens);
      const date = new Date().toISOString().split('T')[0];
      
      // Track total cost
      await this.redis.incrby(`${this.COST_KEY_PREFIX}total`, cost);
      
      // Track provider-specific cost
      await this.redis.incrby(`${this.COST_KEY_PREFIX}provider:${provider}`, cost);
      
      // Track model-specific cost
      await this.redis.incrby(`${this.COST_KEY_PREFIX}model:${model}`, cost);
      
      // Track daily costs
      await this.redis.incrby(`${this.DAILY_COST_KEY_PREFIX}${date}:total`, cost);
      await this.redis.incrby(`${this.DAILY_COST_KEY_PREFIX}${date}:provider:${provider}`, cost);
      await this.redis.incrby(`${this.DAILY_COST_KEY_PREFIX}${date}:model:${model}`, cost);
      
      // Track token usage
      await this.redis.incrby(`${this.COST_KEY_PREFIX}tokens:input`, inputTokens);
      await this.redis.incrby(`${this.COST_KEY_PREFIX}tokens:output`, outputTokens);
      
      // Emit cost tracking event
      this.emit('costTracked', {
        provider,
        model,
        inputTokens,
        outputTokens,
        cost,
        timestamp: new Date()
      });
      
      // Check if cost exceeds threshold
      const dailyCost = await this.getDailyCost(date);
      if (dailyCost > 100) { // $100 daily threshold
        this.emit('costThresholdExceeded', {
          date,
          cost: dailyCost,
          threshold: 100
        });
      }
    } catch (error) {
      logger.error('Error tracking LLM cost:', error);
    }
  }

  /**
   * Get cost metrics
   */
  public async getCostMetrics(): Promise<CostMetrics> {
    try {
      const totalCost = parseFloat(await this.redis.get(`${this.COST_KEY_PREFIX}total`) || '0');
      
      const costByProvider: Record<LLMProvider, number> = {
        [LLMProvider.OPENAI]: parseFloat(await this.redis.get(`${this.COST_KEY_PREFIX}provider:${LLMProvider.OPENAI}`) || '0'),
        [LLMProvider.ANTHROPIC]: parseFloat(await this.redis.get(`${this.COST_KEY_PREFIX}provider:${LLMProvider.ANTHROPIC}`) || '0'),
        [LLMProvider.GEMINI]: parseFloat(await this.redis.get(`${this.COST_KEY_PREFIX}provider:${LLMProvider.GEMINI}`) || '0')
      };
      
      const costByModel: Record<LLMModel, number> = {} as Record<LLMModel, number>;
      for (const model of Object.values(LLMModel)) {
        costByModel[model] = parseFloat(await this.redis.get(`${this.COST_KEY_PREFIX}model:${model}`) || '0');
      }
      
      const tokenUsage = {
        input: parseInt(await this.redis.get(`${this.COST_KEY_PREFIX}tokens:input`) || '0'),
        output: parseInt(await this.redis.get(`${this.COST_KEY_PREFIX}tokens:output`) || '0')
      };
      
      return {
        totalCost,
        costByProvider,
        costByModel,
        tokenUsage
      };
    } catch (error) {
      logger.error('Error getting LLM cost metrics:', error);
      throw error;
    }
  }

  /**
   * Get daily cost
   */
  public async getDailyCost(date: string): Promise<number> {
    try {
      return parseFloat(await this.redis.get(`${this.DAILY_COST_KEY_PREFIX}${date}:total`) || '0');
    } catch (error) {
      logger.error('Error getting daily LLM cost:', error);
      throw error;
    }
  }

  /**
   * Get cost optimization recommendations
   */
  public getCostOptimization(
    provider: LLMProvider,
    estimatedTokens: number,
    maxCost: number
  ): CostOptimizationResult {
    const strategy = COST_OPTIMIZATION_STRATEGIES[provider];
    const models = Object.values(LLMModel).filter(model => 
      model.startsWith(provider.toUpperCase())
    );
    
    // Find the most cost-effective model that meets the requirements
    let recommendedModel = models[0];
    let lowestCost = Infinity;
    
    for (const model of models) {
      const cost = this.calculateCost(model, estimatedTokens, estimatedTokens);
      if (cost < lowestCost && cost <= maxCost) {
        lowestCost = cost;
        recommendedModel = model;
      }
    }
    
    // If no model meets the cost requirement, use the fallback model
    if (lowestCost === Infinity) {
      recommendedModel = strategy.fallbackModel;
      lowestCost = this.calculateCost(recommendedModel, estimatedTokens, estimatedTokens);
    }
    
    return {
      recommendedModel,
      estimatedCost: lowestCost,
      estimatedTokens,
      strategy: `Using ${recommendedModel} for cost optimization`
    };
  }

  /**
   * Reset cost metrics
   */
  public async resetCostMetrics(): Promise<void> {
    try {
      const keys = await this.redis.keys(`${this.COST_KEY_PREFIX}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      logger.info('LLM cost metrics reset successfully');
    } catch (error) {
      logger.error('Error resetting LLM cost metrics:', error);
      throw error;
    }
  }
} 