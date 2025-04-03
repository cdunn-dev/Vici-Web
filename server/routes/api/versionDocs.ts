import { Router } from 'express';
import { migrationGuides } from '../../config/apiVersioning';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Get migration guide for a specific version transition
 * @route GET /api/version-docs/migration/:from-to
 */
router.get('/migration/:fromTo', (req, res) => {
  try {
    const { fromTo } = req.params;
    
    // Type guard to check if the fromTo parameter is a valid key of migrationGuides
    if (!(fromTo in migrationGuides)) {
      return res.status(404).json({
        error: {
          code: 'MIGRATION_GUIDE_NOT_FOUND',
          message: `Migration guide for ${fromTo} not found`,
          details: {
            availableGuides: Object.keys(migrationGuides)
          }
        }
      });
    }
    
    return res.json(migrationGuides[fromTo as keyof typeof migrationGuides]);
  } catch (error) {
    logger.error('Error retrieving migration guide', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred while retrieving the migration guide',
        details: {}
      }
    });
  }
});

/**
 * Get all available migration guides
 * @route GET /api/version-docs/migrations
 */
router.get('/migrations', (req, res) => {
  try {
    const guides = Object.entries(migrationGuides).map(([key, guide]) => ({
      key,
      title: guide.title,
      description: guide.description
    }));
    
    return res.json({ guides });
  } catch (error) {
    logger.error('Error retrieving migration guides', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred while retrieving migration guides',
        details: {}
      }
    });
  }
});

/**
 * Get version-specific API documentation
 * @route GET /api/version-docs/:version
 */
router.get('/:version', (req, res) => {
  try {
    const { version } = req.params;
    
    // In a real implementation, you would load version-specific OpenAPI docs
    // For now, we'll return a placeholder response
    return res.json({
      version,
      documentation: `Documentation for API version ${version}`,
      note: 'This is a placeholder. In a real implementation, this would return version-specific OpenAPI documentation.'
    });
  } catch (error) {
    logger.error('Error retrieving version documentation', { error });
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred while retrieving version documentation',
        details: {}
      }
    });
  }
});

export default router; 