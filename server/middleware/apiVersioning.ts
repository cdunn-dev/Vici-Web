import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * API versioning middleware
 * 
 * This middleware handles API versioning by:
 * 1. Extracting the version from the URL path (/v1/endpoint)
 * 2. Attaching the version to the request object
 * 3. Handling version deprecation warnings
 * 4. Redirecting to the latest version when no version is specified
 */
export const apiVersioning = (options: {
  defaultVersion: string;
  supportedVersions: string[];
  deprecatedVersions: Record<string, string>; // version -> deprecation date
  sunsetVersions: Record<string, string>; // version -> sunset date
}) => {
  const { defaultVersion, supportedVersions, deprecatedVersions, sunsetVersions } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    // Extract version from URL path (e.g., /v1/users)
    const pathParts = req.path.split('/');
    const versionMatch = pathParts[1]?.match(/^v(\d+)$/);
    
    if (versionMatch) {
      // Version specified in URL
      const version = `v${versionMatch[1]}`;
      
      // Check if version is supported
      if (!supportedVersions.includes(version)) {
        logger.warn(`Unsupported API version requested: ${version}`);
        return res.status(400).json({
          error: {
            code: 'UNSUPPORTED_VERSION',
            message: `API version ${version} is not supported. Supported versions: ${supportedVersions.join(', ')}`,
            details: {
              supportedVersions,
              defaultVersion
            }
          }
        });
      }
      
      // Attach version to request
      req.apiVersion = version;
      
      // Check if version is deprecated
      if (deprecatedVersions[version]) {
        const deprecationDate = deprecatedVersions[version];
        res.set('Warning', `299 - "This API version is deprecated and will be sunset on ${deprecationDate}"`);
        logger.warn(`Deprecated API version used: ${version}, sunset date: ${deprecationDate}`);
      }
      
      // Check if version is sunset
      if (sunsetVersions[version]) {
        const sunsetDate = sunsetVersions[version];
        const sunsetDateTime = new Date(sunsetDate).getTime();
        const now = Date.now();
        
        if (now >= sunsetDateTime) {
          logger.error(`Sunset API version used: ${version}, sunset date: ${sunsetDate}`);
          return res.status(410).json({
            error: {
              code: 'VERSION_SUNSET',
              message: `API version ${version} has been sunset as of ${sunsetDate}`,
              details: {
                sunsetDate,
                supportedVersions,
                defaultVersion
              }
            }
          });
        } else {
          // Version is scheduled for sunset but not yet sunset
          const daysUntilSunset = Math.ceil((sunsetDateTime - now) / (1000 * 60 * 60 * 24));
          res.set('Warning', `299 - "This API version will be sunset on ${sunsetDate} (${daysUntilSunset} days remaining)"`);
          logger.warn(`API version scheduled for sunset: ${version}, sunset date: ${sunsetDate}, days remaining: ${daysUntilSunset}`);
        }
      }
      
      // Remove version from path for route matching
      req.url = req.url.replace(`/${version}`, '');
      
      // We can't modify req.path directly as it's read-only, but we can use req.url for routing
      // The router will use req.url for matching routes
      
      next();
    } else {
      // No version specified, use default version
      req.apiVersion = defaultVersion;
      
      // Add version to response headers
      res.set('X-API-Version', defaultVersion);
      
      next();
    }
  };
};

// Extend Express Request interface to include apiVersion
declare global {
  namespace Express {
    interface Request {
      apiVersion?: string;
    }
  }
} 