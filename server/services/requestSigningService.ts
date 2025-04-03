import { createHmac } from 'crypto';
import { logger } from '../utils/logger';
import { Request } from 'express';

/**
 * Request Signing Service
 * 
 * This service handles request signing for sensitive API operations:
 * - Verifies request signatures
 * - Generates signatures for outgoing requests
 * - Validates timestamp to prevent replay attacks
 */
export class RequestSigningService {
  private static instance: RequestSigningService;
  
  // Maximum time difference allowed between request timestamp and server time (in seconds)
  private readonly MAX_TIME_DIFF = 300; // 5 minutes
  
  private constructor() {}
  
  /**
   * Get the singleton instance of the request signing service
   */
  public static getInstance(): RequestSigningService {
    if (!RequestSigningService.instance) {
      RequestSigningService.instance = new RequestSigningService();
    }
    return RequestSigningService.instance;
  }
  
  /**
   * Verify a signed request
   * @param req The Express request object
   * @param secret The secret key used to sign the request
   * @returns True if the signature is valid, false otherwise
   */
  public verifyRequestSignature(req: Request, secret: string): boolean {
    try {
      // Get the signature from the request headers
      const signature = req.headers['x-signature'] as string;
      const timestamp = req.headers['x-timestamp'] as string;
      const nonce = req.headers['x-nonce'] as string;
      
      if (!signature || !timestamp || !nonce) {
        logger.warn('Missing signature headers', { 
          hasSignature: !!signature, 
          hasTimestamp: !!timestamp, 
          hasNonce: !!nonce 
        });
        return false;
      }
      
      // Verify the timestamp is within the allowed time difference
      const requestTime = parseInt(timestamp, 10);
      const serverTime = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(serverTime - requestTime);
      
      if (timeDiff > this.MAX_TIME_DIFF) {
        logger.warn('Request timestamp is too old or in the future', { 
          requestTime, 
          serverTime, 
          timeDiff 
        });
        return false;
      }
      
      // Generate the expected signature
      const expectedSignature = this.generateSignature(req, timestamp, nonce, secret);
      
      // Compare the signatures
      return signature === expectedSignature;
    } catch (error) {
      logger.error('Error verifying request signature', { error });
      return false;
    }
  }
  
  /**
   * Generate a signature for a request
   * @param req The Express request object
   * @param timestamp The current timestamp
   * @param nonce A random nonce
   * @param secret The secret key to use for signing
   * @returns The generated signature
   */
  public generateSignature(
    req: Request,
    timestamp: string,
    nonce: string,
    secret: string
  ): string {
    try {
      // Get the request method, path, and body
      const method = req.method.toUpperCase();
      const path = req.originalUrl;
      const body = req.body ? JSON.stringify(req.body) : '';
      
      // Create the string to sign
      const stringToSign = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}`;
      
      // Generate the signature
      return this.sign(stringToSign, secret);
    } catch (error) {
      logger.error('Error generating request signature', { error });
      throw new Error('Failed to generate request signature');
    }
  }
  
  /**
   * Sign a string with a secret key
   * @param stringToSign The string to sign
   * @param secret The secret key to use for signing
   * @returns The generated signature
   */
  private sign(stringToSign: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(stringToSign)
      .digest('hex');
  }
  
  /**
   * Generate headers for a signed request
   * @param req The Express request object
   * @param secret The secret key to use for signing
   * @returns The headers to include in the request
   */
  public generateSignedRequestHeaders(req: Request, secret: string): Record<string, string> {
    try {
      // Generate a timestamp and nonce
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = this.generateNonce();
      
      // Generate the signature
      const signature = this.generateSignature(req, timestamp, nonce, secret);
      
      // Return the headers
      return {
        'x-signature': signature,
        'x-timestamp': timestamp,
        'x-nonce': nonce
      };
    } catch (error) {
      logger.error('Error generating signed request headers', { error });
      throw new Error('Failed to generate signed request headers');
    }
  }
  
  /**
   * Generate a random nonce
   * @returns A random nonce
   */
  private generateNonce(): string {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }
} 