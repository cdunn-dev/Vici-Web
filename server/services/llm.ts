import { EventEmitter } from 'events';
import { RedisService } from './redis';
import { logger } from '../utils/logger';
import { LLMMonitoringService } from './llmMonitoringService';
import { LLMCostService } from './llmCostService';
import { LLMRequest, LLMResponse, LLMProvider } from '../types/llm';

export class LLMService extends EventEmitter {
  private static instance: LLMService;
  private redis: RedisService;
  private monitoringService: LLMMonitoringService;
  private costService: LLMCostService;

  private constructor() {
    super();
    this.redis = RedisService.getInstance();
    this.monitoringService = LLMMonitoringService.getInstance();
    this.costService = LLMCostService.getInstance();
  }

  public static getInstance(): LLMService {
    if (!LLMService.instance) {
      LLMService.instance = new LLMService();
    }
    return LLMService.instance;
  }

  public async generate(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    let response: LLMResponse;
    let error: Error | null = null;

    try {
      // Get cost optimization recommendations
      const estimatedTokens = request.maxTokens || 1000;
      const optimization = this.costService.getCostOptimization(
        request.provider || LLMProvider.OPENAI,
        estimatedTokens,
        1.0 // $1.00 max cost per request
      );

      // Use the recommended model if it's different from the requested one
      if (optimization.recommendedModel !== request.model) {
        logger.info('Using cost-optimized model', {
          requested: request.model,
          recommended: optimization.recommendedModel,
          estimatedCost: optimization.estimatedCost
        });
        request.model = optimization.recommendedModel;
      }

      // Generate response using the selected provider
      response = await this.generateWithProvider(request);

      // Track cost
      await this.costService.trackCost(
        response.provider,
        response.model,
        response.usage.promptTokens,
        response.usage.completionTokens
      );

      // Track metrics
      await this.monitoringService.trackRequest(request, response, Date.now() - startTime);

      return response;
    } catch (err) {
      error = err as Error;
      throw error;
    } finally {
      if (error) {
        await this.monitoringService.trackError(request, error);
      }
    }
  }

  private async generateWithProvider(request: LLMRequest): Promise<LLMResponse> {
    // Implementation of provider-specific generation logic
    // This would be implemented based on the selected provider
    throw new Error('Not implemented');
  }
} 