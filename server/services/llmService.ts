import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import axios from 'axios';
import { RedisService } from './redis';

// LLM Provider Types
export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GEMINI = 'gemini'
}

// LLM Model Types
export enum LLMModel {
  // OpenAI Models
  GPT_4 = 'gpt-4',
  GPT_4_TURBO = 'gpt-4-turbo',
  GPT_3_5_TURBO = 'gpt-3.5-turbo',
  
  // Anthropic Models
  CLAUDE_3_OPUS = 'claude-3-opus',
  CLAUDE_3_SONNET = 'claude-3-sonnet',
  CLAUDE_3_HAIKU = 'claude-3-haiku',
  
  // Gemini Models
  GEMINI_PRO = 'gemini-pro',
  GEMINI_ULTRA = 'gemini-ultra'
}

// LLM Request Types
export interface LLMRequest {
  prompt: string;
  model?: LLMModel;
  provider?: LLMProvider;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  user?: string;
  metadata?: Record<string, any>;
}

// LLM Response Types
export interface LLMResponse {
  text: string;
  model: LLMModel;
  provider: LLMProvider;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latency: number;
  metadata?: Record<string, any>;
}

// LLM Error Types
export interface LLMError extends Error {
  provider: LLMProvider;
  model?: LLMModel;
  statusCode?: number;
  retryable: boolean;
}

// LLM Provider Interface
export interface LLMProviderInterface {
  generate(request: LLMRequest): Promise<LLMResponse>;
  getModels(): Promise<LLMModel[]>;
  isAvailable(): Promise<boolean>;
}

// LLM Service Configuration
export interface LLMServiceConfig {
  defaultProvider: LLMProvider;
  fallbackProviders: LLMProvider[];
  defaultModel: LLMModel;
  cacheEnabled: boolean;
  cacheTTL: number;
  maxRetries: number;
  retryDelay: number;
  timeout: number;
  rateLimits: {
    [key in LLMProvider]?: {
      requestsPerMinute: number;
      tokensPerMinute: number;
    };
  };
}

// Default Configuration
const DEFAULT_CONFIG: LLMServiceConfig = {
  defaultProvider: LLMProvider.OPENAI,
  fallbackProviders: [LLMProvider.ANTHROPIC, LLMProvider.GEMINI],
  defaultModel: LLMModel.GPT_4,
  cacheEnabled: true,
  cacheTTL: 3600, // 1 hour
  maxRetries: 3,
  retryDelay: 1000, // 1 second
  timeout: 30000, // 30 seconds
  rateLimits: {
    [LLMProvider.OPENAI]: {
      requestsPerMinute: 60,
      tokensPerMinute: 90000
    },
    [LLMProvider.ANTHROPIC]: {
      requestsPerMinute: 50,
      tokensPerMinute: 100000
    },
    [LLMProvider.GEMINI]: {
      requestsPerMinute: 60,
      tokensPerMinute: 60000
    }
  }
};

// LLM Service Class
export class LLMService extends EventEmitter {
  private static instance: LLMService;
  private config: LLMServiceConfig;
  private providers: Map<LLMProvider, LLMProviderInterface> = new Map();
  private redisService: RedisService;
  private isInitialized = false;
  private requestCounts: Map<LLMProvider, number> = new Map();
  private tokenCounts: Map<LLMProvider, number> = new Map();
  private lastResetTime: number = Date.now();

  private constructor(config: Partial<LLMServiceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redisService = RedisService.getInstance();
  }

  public static getInstance(config?: Partial<LLMServiceConfig>): LLMService {
    if (!LLMService.instance) {
      LLMService.instance = new LLMService(config);
    }
    return LLMService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Initialize providers
      await this.initializeProviders();
      
      // Reset counters
      this.resetCounters();
      
      // Set up periodic counter reset
      setInterval(() => this.resetCounters(), 60000);
      
      this.isInitialized = true;
      logger.info('LLM service initialized');
    } catch (error) {
      logger.error('Failed to initialize LLM service:', error);
      throw error;
    }
  }

  private async initializeProviders(): Promise<void> {
    // Initialize OpenAI provider
    if (process.env.OPENAI_API_KEY) {
      this.providers.set(LLMProvider.OPENAI, new OpenAIProvider(process.env.OPENAI_API_KEY));
    }
    
    // Initialize Anthropic provider
    if (process.env.ANTHROPIC_API_KEY) {
      this.providers.set(LLMProvider.ANTHROPIC, new AnthropicProvider(process.env.ANTHROPIC_API_KEY));
    }
    
    // Initialize Gemini provider
    if (process.env.GEMINI_API_KEY) {
      this.providers.set(LLMProvider.GEMINI, new GeminiProvider(process.env.GEMINI_API_KEY));
    }
    
    // Check if at least one provider is available
    if (this.providers.size === 0) {
      throw new Error('No LLM providers available. Please configure at least one provider.');
    }
  }

  private resetCounters(): void {
    this.requestCounts.clear();
    this.tokenCounts.clear();
    this.lastResetTime = Date.now();
  }

  public async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Check cache if enabled
    if (this.config.cacheEnabled) {
      const cachedResponse = await this.getCachedResponse(request);
      if (cachedResponse) {
        return cachedResponse;
      }
    }

    // Determine provider
    const provider = await this.determineProvider(request.provider);
    
    // Check rate limits
    await this.checkRateLimits(provider);
    
    // Generate response
    const startTime = Date.now();
    let response: LLMResponse | undefined;
    let error: LLMError | null = null;
    
    try {
      response = await this.providers.get(provider)!.generate(request);
      
      // Update counters
      this.updateCounters(provider, response.usage.totalTokens);
      
      // Cache response if enabled
      if (this.config.cacheEnabled) {
        await this.cacheResponse(request, response);
      }
      
      return response;
    } catch (err) {
      error = this.normalizeError(err, provider);
      
      // Try fallback providers if error is retryable
      if (error.retryable) {
        for (const fallbackProvider of this.config.fallbackProviders) {
          if (fallbackProvider === provider) continue;
          
          try {
            const fallbackResponse = await this.providers.get(fallbackProvider)!.generate(request);
            
            // Update counters
            this.updateCounters(fallbackProvider, fallbackResponse.usage.totalTokens);
            
            // Cache response if enabled
            if (this.config.cacheEnabled) {
              await this.cacheResponse(request, fallbackResponse);
            }
            
            return fallbackResponse;
          } catch (fallbackErr) {
            logger.warn(`Fallback provider ${fallbackProvider} failed:`, fallbackErr);
          }
        }
      }
      
      throw error;
    } finally {
      const latency = Date.now() - startTime;
      this.emit('llmRequest', { request, response, error, latency });
    }
  }

  private async determineProvider(requestedProvider?: LLMProvider): Promise<LLMProvider> {
    // If provider is specified and available, use it
    if (requestedProvider && this.providers.has(requestedProvider)) {
      const isAvailable = await this.providers.get(requestedProvider)!.isAvailable();
      if (isAvailable) {
        return requestedProvider;
      }
    }
    
    // Otherwise, use default provider
    if (this.providers.has(this.config.defaultProvider)) {
      const isAvailable = await this.providers.get(this.config.defaultProvider)!.isAvailable();
      if (isAvailable) {
        return this.config.defaultProvider;
      }
    }
    
    // If default provider is not available, try fallback providers
    for (const fallbackProvider of this.config.fallbackProviders) {
      if (this.providers.has(fallbackProvider)) {
        const isAvailable = await this.providers.get(fallbackProvider)!.isAvailable();
        if (isAvailable) {
          return fallbackProvider;
        }
      }
    }
    
    // If no providers are available, throw an error
    throw new Error('No LLM providers available');
  }

  private async checkRateLimits(provider: LLMProvider): Promise<void> {
    const rateLimit = this.config.rateLimits[provider];
    if (!rateLimit) return;
    
    const requestCount = this.requestCounts.get(provider) || 0;
    const tokenCount = this.tokenCounts.get(provider) || 0;
    
    if (requestCount >= rateLimit.requestsPerMinute) {
      throw new Error(`Rate limit exceeded for ${provider}: ${rateLimit.requestsPerMinute} requests per minute`);
    }
    
    if (tokenCount >= rateLimit.tokensPerMinute) {
      throw new Error(`Rate limit exceeded for ${provider}: ${rateLimit.tokensPerMinute} tokens per minute`);
    }
  }

  private updateCounters(provider: LLMProvider, tokenCount: number): void {
    const requestCount = (this.requestCounts.get(provider) || 0) + 1;
    const totalTokenCount = (this.tokenCounts.get(provider) || 0) + tokenCount;
    
    this.requestCounts.set(provider, requestCount);
    this.tokenCounts.set(provider, totalTokenCount);
  }

  private async getCachedResponse(request: LLMRequest): Promise<LLMResponse | null> {
    const cacheKey = this.generateCacheKey(request);
    const cachedResponse = await this.redisService.get(cacheKey);
    
    if (cachedResponse) {
      return JSON.parse(cachedResponse) as LLMResponse;
    }
    
    return null;
  }

  private async cacheResponse(request: LLMRequest, response: LLMResponse): Promise<void> {
    const cacheKey = this.generateCacheKey(request);
    await this.redisService.set(cacheKey, JSON.stringify(response), this.config.cacheTTL);
  }

  private generateCacheKey(request: LLMRequest): string {
    // Create a deterministic cache key based on the request
    const keyParts = [
      request.provider || this.config.defaultProvider,
      request.model || this.config.defaultModel,
      request.prompt,
      request.systemPrompt || '',
      request.temperature?.toString() || '0.7',
      request.maxTokens?.toString() || '1000',
      request.stopSequences?.join(',') || ''
    ];
    
    return `llm:${keyParts.join(':')}`;
  }

  private normalizeError(error: any, provider: LLMProvider): LLMError {
    const llmError = error as LLMError;
    llmError.provider = provider;
    llmError.retryable = this.isRetryableError(error);
    return llmError;
  }

  private isRetryableError(error: any): boolean {
    // Network errors are retryable
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return true;
    }
    
    // Rate limit errors are retryable
    if (error.statusCode === 429) {
      return true;
    }
    
    // Server errors are retryable
    if (error.statusCode >= 500) {
      return true;
    }
    
    // Client errors are not retryable
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return false;
    }
    
    // Default to not retryable
    return false;
  }

  public async getAvailableModels(): Promise<Record<LLMProvider, LLMModel[]>> {
    const models: Record<LLMProvider, LLMModel[]> = {
      [LLMProvider.OPENAI]: [],
      [LLMProvider.ANTHROPIC]: [],
      [LLMProvider.GEMINI]: []
    };
    
    for (const [provider, providerInstance] of this.providers.entries()) {
      try {
        models[provider] = await providerInstance.getModels();
      } catch (error) {
        logger.error(`Failed to get models for ${provider}:`, error);
      }
    }
    
    return models;
  }

  public async getProviderStatus(): Promise<Record<LLMProvider, boolean>> {
    const status: Record<LLMProvider, boolean> = {
      [LLMProvider.OPENAI]: false,
      [LLMProvider.ANTHROPIC]: false,
      [LLMProvider.GEMINI]: false
    };
    
    for (const [provider, providerInstance] of this.providers.entries()) {
      try {
        status[provider] = await providerInstance.isAvailable();
      } catch (error) {
        logger.error(`Failed to check status for ${provider}:`, error);
      }
    }
    
    return status;
  }

  public async getUsageStats(): Promise<Record<LLMProvider, { requests: number; tokens: number }>> {
    const stats: Record<LLMProvider, { requests: number; tokens: number }> = {
      [LLMProvider.OPENAI]: { requests: 0, tokens: 0 },
      [LLMProvider.ANTHROPIC]: { requests: 0, tokens: 0 },
      [LLMProvider.GEMINI]: { requests: 0, tokens: 0 }
    };
    
    for (const provider of this.providers.keys()) {
      stats[provider] = {
        requests: this.requestCounts.get(provider) || 0,
        tokens: this.tokenCounts.get(provider) || 0
      };
    }
    
    return stats;
  }
}

// OpenAI Provider Implementation
class OpenAIProvider implements LLMProviderInterface {
  private apiKey: string;
  private baseUrl: string = 'https://api.openai.com/v1';
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || LLMModel.GPT_4;
    const messages = [];
    
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    
    messages.push({ role: 'user', content: request.prompt });
    
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model,
        messages,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 1000,
        stop: request.stopSequences,
        user: request.user
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 30000
      }
    );
    
    const completion = response.data.choices[0].message.content;
    const usage = response.data.usage;
    
    return {
      text: completion,
      model,
      provider: LLMProvider.OPENAI,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      },
      latency: response.headers['x-request-id'] ? parseInt(response.headers['x-request-id']) : 0,
      metadata: {
        finishReason: response.data.choices[0].finish_reason
      }
    };
  }
  
  async getModels(): Promise<LLMModel[]> {
    const response = await axios.get(
      `${this.baseUrl}/models`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      }
    );
    
    return response.data.data
      .filter((model: any) => model.id.startsWith('gpt-'))
      .map((model: any) => model.id as LLMModel);
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      await this.getModels();
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Anthropic Provider Implementation
class AnthropicProvider implements LLMProviderInterface {
  private apiKey: string;
  private baseUrl: string = 'https://api.anthropic.com/v1';
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || LLMModel.CLAUDE_3_SONNET;
    const messages = [];
    
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    
    messages.push({ role: 'user', content: request.prompt });
    
    const response = await axios.post(
      `${this.baseUrl}/messages`,
      {
        model,
        messages,
        temperature: request.temperature || 0.7,
        max_tokens: request.maxTokens || 1000,
        stop_sequences: request.stopSequences,
        metadata: request.metadata
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 30000
      }
    );
    
    const completion = response.data.content[0].text;
    const usage = response.data.usage;
    
    return {
      text: completion,
      model,
      provider: LLMProvider.ANTHROPIC,
      usage: {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens
      },
      latency: response.headers['x-request-id'] ? parseInt(response.headers['x-request-id']) : 0,
      metadata: {
        finishReason: response.data.stop_reason
      }
    };
  }
  
  async getModels(): Promise<LLMModel[]> {
    return [
      LLMModel.CLAUDE_3_OPUS,
      LLMModel.CLAUDE_3_SONNET,
      LLMModel.CLAUDE_3_HAIKU
    ];
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      // Simple health check
      await axios.get(
        `${this.baseUrl}/models`,
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01'
          }
        }
      );
      return true;
    } catch (error) {
      return false;
    }
  }
}

// Gemini Provider Implementation
class GeminiProvider implements LLMProviderInterface {
  private apiKey: string;
  private baseUrl: string = 'https://generativelanguage.googleapis.com/v1';
  
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }
  
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || LLMModel.GEMINI_PRO;
    
    const response = await axios.post(
      `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: request.prompt }]
          }
        ],
        generationConfig: {
          temperature: request.temperature || 0.7,
          maxOutputTokens: request.maxTokens || 1000,
          stopSequences: request.stopSequences
        },
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_HATE_SPEECH',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          },
          {
            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    const completion = response.data.candidates[0].content.parts[0].text;
    const usage = response.data.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
    
    return {
      text: completion,
      model,
      provider: LLMProvider.GEMINI,
      usage: {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount
      },
      latency: 0, // Gemini doesn't provide latency information
      metadata: {
        safetyRatings: response.data.candidates[0].safetyRatings
      }
    };
  }
  
  async getModels(): Promise<LLMModel[]> {
    return [
      LLMModel.GEMINI_PRO,
      LLMModel.GEMINI_ULTRA
    ];
  }
  
  async isAvailable(): Promise<boolean> {
    try {
      // Simple health check
      await axios.get(
        `${this.baseUrl}/models?key=${this.apiKey}`
      );
      return true;
    } catch (error) {
      return false;
    }
  }
} 