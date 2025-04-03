import { Router } from 'express';
import { z } from 'zod';
import { LLMService, LLMProvider, LLMModel } from '../../services/llmService';
import { LLMMonitoringService } from '../../services/llmMonitoringService';
import { validateRequest } from '../../middleware/validateRequest';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { logger } from '../../utils/logger';

const router = Router();
const llmService = LLMService.getInstance();
const monitoringService = LLMMonitoringService.getInstance();

// Validation schemas
const generateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.nativeEnum(LLMModel).optional(),
  provider: z.nativeEnum(LLMProvider).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(1).max(4000).optional(),
  stopSequences: z.array(z.string()).optional(),
  systemPrompt: z.string().max(4000).optional(),
  metadata: z.record(z.any()).optional()
});

const metricsRequestSchema = z.object({
  date: z.string().optional(),
  provider: z.nativeEnum(LLMProvider).optional(),
  model: z.nativeEnum(LLMModel).optional()
});

// Routes
router.post(
  '/generate',
  authenticate,
  rateLimit({ windowMs: 60 * 1000, max: 10 }), // 10 requests per minute
  validateRequest(generateRequestSchema),
  async (req, res) => {
    try {
      const response = await llmService.generate(req.body);
      res.json(response);
    } catch (error) {
      logger.error('Error generating LLM response:', error);
      res.status(500).json({
        error: 'Failed to generate response',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/models',
  authenticate,
  async (req, res) => {
    try {
      const models = await llmService.getAvailableModels();
      res.json(models);
    } catch (error) {
      logger.error('Error getting available models:', error);
      res.status(500).json({
        error: 'Failed to get available models',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/status',
  authenticate,
  async (req, res) => {
    try {
      const status = await llmService.getProviderStatus();
      res.json(status);
    } catch (error) {
      logger.error('Error getting provider status:', error);
      res.status(500).json({
        error: 'Failed to get provider status',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/usage',
  authenticate,
  async (req, res) => {
    try {
      const usage = await llmService.getUsageStats();
      res.json(usage);
    } catch (error) {
      logger.error('Error getting usage stats:', error);
      res.status(500).json({
        error: 'Failed to get usage stats',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

// Monitoring endpoints
router.get(
  '/metrics',
  authenticate,
  validateRequest(metricsRequestSchema),
  async (req, res) => {
    try {
      const { date, provider, model } = req.query;

      if (provider && model) {
        const metrics = await monitoringService.getModelMetrics(
          provider as LLMProvider,
          model as LLMModel,
          date as string
        );
        res.json(metrics);
      } else if (provider) {
        const metrics = await monitoringService.getProviderMetrics(
          provider as LLMProvider,
          date as string
        );
        res.json(metrics);
      } else {
        const metrics = await monitoringService.getMetrics(date as string);
        res.json(metrics);
      }
    } catch (error) {
      logger.error('Error getting metrics:', error);
      res.status(500).json({
        error: 'Failed to get metrics',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/metrics/cost',
  authenticate,
  validateRequest(metricsRequestSchema),
  async (req, res) => {
    try {
      const { date } = req.query;
      const metrics = await monitoringService.getCostMetrics(date as string);
      res.json(metrics);
    } catch (error) {
      logger.error('Error getting cost metrics:', error);
      res.status(500).json({
        error: 'Failed to get cost metrics',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/metrics/errors',
  authenticate,
  validateRequest(metricsRequestSchema),
  async (req, res) => {
    try {
      const { date } = req.query;
      const metrics = await monitoringService.getErrorMetrics(date as string);
      res.json(metrics);
    } catch (error) {
      logger.error('Error getting error metrics:', error);
      res.status(500).json({
        error: 'Failed to get error metrics',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

router.get(
  '/metrics/latency',
  authenticate,
  validateRequest(metricsRequestSchema),
  async (req, res) => {
    try {
      const { date } = req.query;
      const metrics = await monitoringService.getLatencyMetrics(date as string);
      res.json(metrics);
    } catch (error) {
      logger.error('Error getting latency metrics:', error);
      res.status(500).json({
        error: 'Failed to get latency metrics',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

export default router; 