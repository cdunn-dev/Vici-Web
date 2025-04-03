export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GEMINI = 'gemini'
}

export enum LLMModel {
  GPT_4 = 'gpt-4',
  GPT_4_TURBO = 'gpt-4-turbo',
  GPT_3_5_TURBO = 'gpt-3.5-turbo',
  CLAUDE_3_OPUS = 'claude-3-opus',
  CLAUDE_3_SONNET = 'claude-3-sonnet',
  CLAUDE_3_HAIKU = 'claude-3-haiku',
  GEMINI_PRO = 'gemini-pro',
  GEMINI_ULTRA = 'gemini-ultra'
}

export interface LLMRequest {
  prompt: string;
  model: LLMModel;
  provider?: LLMProvider;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  systemPrompt?: string;
  metadata?: Record<string, any>;
}

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

export interface LLMModels {
  openai: LLMModel[];
  anthropic: LLMModel[];
  gemini: LLMModel[];
}

export interface LLMStatus {
  openai: boolean;
  anthropic: boolean;
  gemini: boolean;
}

export interface LLMUsage {
  openai: {
    requests: number;
    tokens: number;
  };
  anthropic: {
    requests: number;
    tokens: number;
  };
  gemini: {
    requests: number;
    tokens: number;
  };
} 