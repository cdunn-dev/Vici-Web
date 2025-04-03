import { RedisService } from './redis';
import { logger } from '../utils/logger';

/**
 * IP Whitelist Service
 * 
 * This service handles IP whitelisting for admin endpoints:
 * - Manages whitelisted IP addresses
 * - Validates IP addresses against the whitelist
 * - Supports CIDR notation for IP ranges
 */
export class IpWhitelistService {
  private static instance: IpWhitelistService;
  private redis: RedisService;
  
  // Redis key for the IP whitelist
  private readonly WHITELIST_KEY = 'ip_whitelist';
  
  private constructor() {
    this.redis = RedisService.getInstance();
  }
  
  /**
   * Get the singleton instance of the IP whitelist service
   */
  public static getInstance(): IpWhitelistService {
    if (!IpWhitelistService.instance) {
      IpWhitelistService.instance = new IpWhitelistService();
    }
    return IpWhitelistService.instance;
  }
  
  /**
   * Add an IP address or CIDR range to the whitelist
   * @param ipOrCidr The IP address or CIDR range to add
   * @returns True if the IP was added, false otherwise
   */
  public async addToWhitelist(ipOrCidr: string): Promise<boolean> {
    try {
      // Validate the IP or CIDR
      if (!this.isValidIpOrCidr(ipOrCidr)) {
        logger.warn('Invalid IP or CIDR format', { ipOrCidr });
        return false;
      }
      
      // Add the IP or CIDR to the whitelist
      await this.redis.sadd(this.WHITELIST_KEY, ipOrCidr);
      
      logger.info('Added IP or CIDR to whitelist', { ipOrCidr });
      return true;
    } catch (error) {
      logger.error('Error adding IP to whitelist', { error, ipOrCidr });
      return false;
    }
  }
  
  /**
   * Remove an IP address or CIDR range from the whitelist
   * @param ipOrCidr The IP address or CIDR range to remove
   * @returns True if the IP was removed, false otherwise
   */
  public async removeFromWhitelist(ipOrCidr: string): Promise<boolean> {
    try {
      // Remove the IP or CIDR from the whitelist
      await this.redis.srem(this.WHITELIST_KEY, ipOrCidr);
      
      logger.info('Removed IP or CIDR from whitelist', { ipOrCidr });
      return true;
    } catch (error) {
      logger.error('Error removing IP from whitelist', { error, ipOrCidr });
      return false;
    }
  }
  
  /**
   * Check if an IP address is whitelisted
   * @param ip The IP address to check
   * @returns True if the IP is whitelisted, false otherwise
   */
  public async isIpWhitelisted(ip: string): Promise<boolean> {
    try {
      // Get all whitelisted IPs and CIDRs
      const whitelist = await this.redis.smembers(this.WHITELIST_KEY);
      
      // Check if the IP is directly whitelisted
      if (whitelist.includes(ip)) {
        return true;
      }
      
      // Check if the IP is in a whitelisted CIDR range
      for (const entry of whitelist) {
        if (this.isCidr(entry) && this.ipInCidr(ip, entry)) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      logger.error('Error checking IP whitelist', { error, ip });
      return false;
    }
  }
  
  /**
   * Get all whitelisted IP addresses and CIDR ranges
   * @returns An array of whitelisted IPs and CIDRs
   */
  public async getWhitelist(): Promise<string[]> {
    try {
      return await this.redis.smembers(this.WHITELIST_KEY);
    } catch (error) {
      logger.error('Error getting IP whitelist', { error });
      return [];
    }
  }
  
  /**
   * Check if a string is a valid IP address or CIDR range
   * @param ipOrCidr The string to check
   * @returns True if the string is a valid IP or CIDR, false otherwise
   */
  private isValidIpOrCidr(ipOrCidr: string): boolean {
    // Check if it's a valid IP address
    if (this.isValidIp(ipOrCidr)) {
      return true;
    }
    
    // Check if it's a valid CIDR range
    if (this.isCidr(ipOrCidr)) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Check if a string is a valid IP address
   * @param ip The string to check
   * @returns True if the string is a valid IP, false otherwise
   */
  private isValidIp(ip: string): boolean {
    // IPv4 regex
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    
    // IPv6 regex
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    
    if (ipv4Regex.test(ip)) {
      // Check if each octet is between 0 and 255
      const octets = ip.split('.');
      return octets.every(octet => {
        const num = parseInt(octet, 10);
        return num >= 0 && num <= 255;
      });
    }
    
    return ipv6Regex.test(ip);
  }
  
  /**
   * Check if a string is a CIDR range
   * @param cidr The string to check
   * @returns True if the string is a CIDR range, false otherwise
   */
  private isCidr(cidr: string): boolean {
    // CIDR regex
    const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
    
    if (!cidrRegex.test(cidr)) {
      return false;
    }
    
    // Split the CIDR into IP and prefix
    const [ip, prefix] = cidr.split('/');
    
    // Check if the IP is valid
    if (!this.isValidIp(ip)) {
      return false;
    }
    
    // Check if the prefix is between 0 and 32
    const prefixNum = parseInt(prefix, 10);
    return prefixNum >= 0 && prefixNum <= 32;
  }
  
  /**
   * Check if an IP address is in a CIDR range
   * @param ip The IP address to check
   * @param cidr The CIDR range to check against
   * @returns True if the IP is in the CIDR range, false otherwise
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    // Split the CIDR into IP and prefix
    const [cidrIp, prefix] = cidr.split('/');
    const prefixNum = parseInt(prefix, 10);
    
    // Convert IPs to binary
    const ipBinary = this.ipToBinary(ip);
    const cidrBinary = this.ipToBinary(cidrIp);
    
    // Check if the IP is in the CIDR range
    return ipBinary.substring(0, prefixNum) === cidrBinary.substring(0, prefixNum);
  }
  
  /**
   * Convert an IP address to binary
   * @param ip The IP address to convert
   * @returns The binary representation of the IP
   */
  private ipToBinary(ip: string): string {
    // Split the IP into octets
    const octets = ip.split('.');
    
    // Convert each octet to binary and pad to 8 bits
    const binaryOctets = octets.map(octet => {
      const binary = parseInt(octet, 10).toString(2);
      return binary.padStart(8, '0');
    });
    
    // Join the binary octets
    return binaryOctets.join('');
  }
} 