import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import * as tls from 'tls';
import * as forge from 'node-forge';
import * as acme from 'acme-client';
import * as dns from 'dns';
import * as net from 'net';

interface TransportEncryptionConfig {
  /**
   * Whether transport encryption is enabled
   */
  enabled: boolean;
  
  /**
   * Path to the certificate directory
   */
  certDir: string;
  
  /**
   * Certificate file name
   */
  certFile: string;
  
  /**
   * Private key file name
   */
  keyFile: string;
  
  /**
   * CA certificate file name
   */
  caFile: string;
  
  /**
   * Certificate rotation interval in days
   */
  certRotationInterval: number;
  
  /**
   * Minimum TLS version
   */
  minTlsVersion: string;
  
  /**
   * Cipher suites to use
   */
  cipherSuites: string[];
  
  /**
   * Whether to verify client certificates
   */
  verifyClientCert: boolean;
  
  /**
   * Whether to require client certificates
   */
  requireClientCert: boolean;
  
  /**
   * Whether to use Let's Encrypt for certificates
   */
  useLetsEncrypt: boolean;
  
  /**
   * Domain name for Let's Encrypt certificate
   */
  domainName: string;
  
  /**
   * Email for Let's Encrypt notifications
   */
  letsEncryptEmail: string;
  
  /**
   * Whether to use OCSP stapling
   */
  useOcspStapling: boolean;
  
  /**
   * Whether to use HSTS
   */
  useHsts: boolean;
  
  /**
   * HSTS max age in seconds
   */
  hstsMaxAge: number;
  
  /**
   * Whether to use secure renegotiation
   */
  useSecureRenegotiation: boolean;
  
  /**
   * Whether to use session tickets
   */
  useSessionTickets: boolean;
  
  /**
   * Session ticket key rotation interval in hours
   */
  sessionTicketRotationInterval: number;
}

interface Certificate {
  id: string;
  cert: string;
  key: string;
  ca: string;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
  issuer: string;
  subject: string;
  serialNumber: string;
  fingerprint: string;
}

interface SessionTicketKey {
  id: string;
  key: Buffer;
  createdAt: Date;
  expiresAt: Date;
  isActive: boolean;
}

// Update type declaration for acme-client
declare module 'acme-client' {
  export interface Client {
    createOrder(options: { identifiers: Array<{ type: string; value: string }> }): Promise<any>;
    getAuthorizations(order: any): Promise<Authorization[]>;
    completeChallenge(challenge: Challenge): Promise<void>;
    waitForValidStatus(challenge: any): Promise<void>;
    finalizeOrder(order: any, csr: string): Promise<void>;
    getCertificate(order: any): Promise<any>;
    getKeyAuthorization(challenge: Challenge): string;
  }

  export interface Challenge {
    type: string;
    token: string;
  }

  export interface Authorization {
    challenges: Challenge[];
  }

  export const letsencrypt: {
    production: string;
    staging: string;
  };

  export namespace acmeCrypto {
    export function createKey(): Promise<Buffer>;
    export function createCsr(options: { commonName: string; altNames: string[] }): Promise<[string, string]>;
  }
}

export class TransportEncryptionService extends EventEmitter {
  private pool: Pool;
  private config: TransportEncryptionConfig;
  private activeCert: Certificate | null = null;
  private certCache: Map<string, Certificate> = new Map();
  private certRotationInterval: NodeJS.Timeout | null = null;
  private httpsServer: https.Server | null = null;
  private sessionTicketKeys: SessionTicketKey[] = [];
  private sessionTicketRotationInterval: NodeJS.Timeout | null = null;
  private acmeClient: acme.Client | null = null;

  constructor(pool: Pool, config: Partial<TransportEncryptionConfig> = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      enabled: true,
      certDir: process.env.CERT_DIR || '/etc/vici/certs',
      certFile: 'server.crt',
      keyFile: 'server.key',
      caFile: 'ca.crt',
      certRotationInterval: 90, // 90 days
      minTlsVersion: 'TLSv1.3',
      cipherSuites: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256'
      ],
      verifyClientCert: true,
      requireClientCert: false,
      useLetsEncrypt: false,
      domainName: process.env.DOMAIN_NAME || '',
      letsEncryptEmail: process.env.LETS_ENCRYPT_EMAIL || '',
      useOcspStapling: true,
      useHsts: true,
      hstsMaxAge: 31536000, // 1 year
      useSecureRenegotiation: true,
      useSessionTickets: true,
      sessionTicketRotationInterval: 24, // 24 hours
      ...config
    };
  }

  /**
   * Initialize the transport encryption service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing transport encryption service');
      
      // Create necessary tables if they don't exist
      await this.createTables();
      
      // Create certificate directory if it doesn't exist
      if (!fs.existsSync(this.config.certDir)) {
        fs.mkdirSync(this.config.certDir, { recursive: true });
      }
      
      // Initialize ACME client if using Let's Encrypt
      if (this.config.useLetsEncrypt) {
        await this.initializeAcmeClient();
      }
      
      // Load active certificate
      await this.loadActiveCertificate();
      
      // Start certificate rotation interval
      this.startCertRotationInterval();
      
      // Initialize session ticket keys if enabled
      if (this.config.useSessionTickets) {
        await this.initializeSessionTicketKeys();
        this.startSessionTicketRotationInterval();
      }
      
      logger.info('Transport encryption service initialized');
    } catch (error) {
      logger.error('Failed to initialize transport encryption service:', error);
      throw error;
    }
  }

  /**
   * Create necessary tables for transport encryption
   */
  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Create certificates table
      await client.query(`
        CREATE TABLE IF NOT EXISTS certificates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          cert_data TEXT NOT NULL,
          key_data TEXT NOT NULL,
          ca_data TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          is_active BOOLEAN DEFAULT FALSE,
          issuer TEXT,
          subject TEXT,
          serial_number TEXT,
          fingerprint TEXT
        )
      `);
      
      // Create session ticket keys table
      await client.query(`
        CREATE TABLE IF NOT EXISTS session_ticket_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          key_data BYTEA NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
          is_active BOOLEAN DEFAULT FALSE
        )
      `);
      
      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_certificates_is_active ON certificates(is_active);
        CREATE INDEX IF NOT EXISTS idx_certificates_expires_at ON certificates(expires_at);
        CREATE INDEX IF NOT EXISTS idx_session_ticket_keys_is_active ON session_ticket_keys(is_active);
        CREATE INDEX IF NOT EXISTS idx_session_ticket_keys_expires_at ON session_ticket_keys(expires_at);
      `);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Initialize ACME client for Let's Encrypt
   */
  private async initializeAcmeClient(): Promise<void> {
    try {
      // Create ACME client
      this.acmeClient = new acme.Client({
        directoryUrl: acme.letsencrypt.production,
        accountKey: await this.getOrCreateAccountKey(),
        accountUrl: await this.getAccountUrl()
      });
      
      logger.info('ACME client initialized');
    } catch (error) {
      logger.error('Failed to initialize ACME client:', error);
      throw error;
    }
  }

  /**
   * Get or create ACME account key
   */
  private async getOrCreateAccountKey(): Promise<Buffer> {
    const accountKeyPath = path.join(this.config.certDir, 'account.key');
    
    if (fs.existsSync(accountKeyPath)) {
      return fs.readFileSync(accountKeyPath);
    }
    
    // Generate new account key
    const accountKey = await acme.acmeCrypto.createKey();
    fs.writeFileSync(accountKeyPath, accountKey.toString());
    
    return accountKey;
  }

  /**
   * Get ACME account URL
   */
  private async getAccountUrl(): Promise<string | undefined> {
    const accountUrlPath = path.join(this.config.certDir, 'account.url');
    
    if (fs.existsSync(accountUrlPath)) {
      return fs.readFileSync(accountUrlPath, 'utf8');
    }
    
    return undefined;
  }

  /**
   * Start certificate rotation interval
   */
  private startCertRotationInterval(): void {
    if (this.certRotationInterval) {
      clearInterval(this.certRotationInterval);
    }
    
    // Check for certificate rotation daily
    this.certRotationInterval = setInterval(async () => {
      await this.checkCertRotation();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * Start session ticket key rotation interval
   */
  private startSessionTicketRotationInterval(): void {
    if (this.sessionTicketRotationInterval) {
      clearInterval(this.sessionTicketRotationInterval);
    }
    
    // Check for session ticket key rotation hourly
    this.sessionTicketRotationInterval = setInterval(async () => {
      await this.checkSessionTicketKeyRotation();
    }, 60 * 60 * 1000);
  }

  /**
   * Check if certificate rotation is needed
   */
  private async checkCertRotation(): Promise<void> {
    if (!this.activeCert) {
      await this.generateNewCertificate();
      return;
    }
    
    // Check if certificate is about to expire (within 7 days)
    const sevenDaysFromNow = new Date();
    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);
    
    if (this.activeCert.expiresAt <= sevenDaysFromNow) {
      logger.info('Certificate rotation needed, generating new certificate');
      await this.generateNewCertificate();
    }
  }

  /**
   * Check if session ticket key rotation is needed
   */
  private async checkSessionTicketKeyRotation(): Promise<void> {
    // Check if we need to generate a new session ticket key
    const activeKeys = this.sessionTicketKeys.filter(key => key.isActive);
    
    if (activeKeys.length < 2) {
      await this.generateNewSessionTicketKey();
    }
    
    // Check if any keys are about to expire
    const oneHourFromNow = new Date();
    oneHourFromNow.setHours(oneHourFromNow.getHours() + 1);
    
    const expiringKeys = activeKeys.filter(key => key.expiresAt <= oneHourFromNow);
    
    if (expiringKeys.length > 0) {
      await this.generateNewSessionTicketKey();
    }
  }

  /**
   * Load active certificate from database
   */
  private async loadActiveCertificate(): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM certificates WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1'
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.activeCert = {
          id: row.id,
          cert: row.cert_data,
          key: row.key_data,
          ca: row.ca_data,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          isActive: row.is_active,
          issuer: row.issuer,
          subject: row.subject,
          serialNumber: row.serial_number,
          fingerprint: row.fingerprint
        };
        
        this.certCache.set(this.activeCert.id, this.activeCert);
        
        // Write certificate files
        await this.writeCertificateFiles(this.activeCert);
        
        logger.info(`Loaded active certificate (ID: ${this.activeCert.id})`);
      } else {
        // No active certificate found, generate a new one
        await this.generateNewCertificate();
      }
    } catch (error) {
      logger.error('Failed to load active certificate:', error);
      throw error;
    }
  }

  /**
   * Initialize session ticket keys
   */
  private async initializeSessionTicketKeys(): Promise<void> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM session_ticket_keys WHERE is_active = TRUE ORDER BY created_at DESC'
      );
      
      if (result.rows.length > 0) {
        this.sessionTicketKeys = result.rows.map(row => ({
          id: row.id,
          key: row.key_data,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          isActive: row.is_active
        }));
        
        logger.info(`Loaded ${this.sessionTicketKeys.length} active session ticket keys`);
      } else {
        // No active session ticket keys found, generate new ones
        await this.generateNewSessionTicketKey();
        await this.generateNewSessionTicketKey();
      }
    } catch (error) {
      logger.error('Failed to initialize session ticket keys:', error);
      throw error;
    }
  }

  /**
   * Generate new session ticket key
   */
  private async generateNewSessionTicketKey(): Promise<SessionTicketKey> {
    try {
      // Generate random key
      const key = crypto.randomBytes(48);
      
      // Set expiration (24 hours from now)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);
      
      // Insert into database
      const result = await this.pool.query(
        'INSERT INTO session_ticket_keys (key_data, expires_at, is_active) VALUES ($1, $2, TRUE) RETURNING *',
        [key, expiresAt]
      );
      
      const newKey: SessionTicketKey = {
        id: result.rows[0].id,
        key: result.rows[0].key_data,
        createdAt: result.rows[0].created_at,
        expiresAt: result.rows[0].expires_at,
        isActive: result.rows[0].is_active
      };
      
      this.sessionTicketKeys.push(newKey);
      
      logger.info(`Generated new session ticket key (ID: ${newKey.id})`);
      
      return newKey;
    } catch (error) {
      logger.error('Failed to generate new session ticket key:', error);
      throw error;
    }
  }

  /**
   * Write certificate files to disk
   */
  private async writeCertificateFiles(cert: Certificate): Promise<void> {
    try {
      // Write certificate
      fs.writeFileSync(
        path.join(this.config.certDir, this.config.certFile),
        cert.cert
      );
      
      // Write private key
      fs.writeFileSync(
        path.join(this.config.certDir, this.config.keyFile),
        cert.key
      );
      
      // Write CA certificate if available
      if (cert.ca) {
        fs.writeFileSync(
          path.join(this.config.certDir, this.config.caFile),
          cert.ca
        );
      }
      
      logger.info('Certificate files written to disk');
    } catch (error) {
      logger.error('Failed to write certificate files:', error);
      throw error;
    }
  }

  /**
   * Generate new certificate
   */
  private async generateNewCertificate(): Promise<Certificate> {
    try {
      let cert: Certificate;
      
      if (this.config.useLetsEncrypt && this.acmeClient) {
        cert = await this.generateLetsEncryptCertificate();
      } else {
        cert = await this.generateSelfSignedCertificate();
      }
      
      // Deactivate current active certificate
      if (this.activeCert) {
        await this.pool.query(
          'UPDATE certificates SET is_active = FALSE WHERE id = $1',
          [this.activeCert.id]
        );
        
        this.activeCert.isActive = false;
        this.certCache.set(this.activeCert.id, this.activeCert);
      }
      
      // Set new certificate as active
      await this.pool.query(
        'UPDATE certificates SET is_active = TRUE WHERE id = $1',
        [cert.id]
      );
      
      cert.isActive = true;
      this.activeCert = cert;
      this.certCache.set(cert.id, cert);
      
      // Write certificate files
      await this.writeCertificateFiles(cert);
      
      logger.info(`Generated new certificate (ID: ${cert.id})`);
      
      return cert;
    } catch (error) {
      logger.error('Failed to generate new certificate:', error);
      throw error;
    }
  }

  /**
   * Generate Let's Encrypt certificate
   */
  private async generateLetsEncryptCertificate(): Promise<Certificate> {
    if (!this.acmeClient || !this.config.domainName) {
      throw new Error('ACME client not initialized or domain name not set');
    }
    
    try {
      // Create new order
      const order = await this.acmeClient.createOrder({
        identifiers: [{ type: 'dns', value: this.config.domainName }]
      });
      
      // Get authorizations
      const authorizations = await this.acmeClient.getAuthorizations(order);
      
      // Complete challenges
      for (const auth of authorizations) {
        const challenge = auth.challenges.find((c: acme.Challenge) => c.type === 'http-01');
        
        if (!challenge) {
          throw new Error('No HTTP-01 challenge found');
        }
        
        // Create verification file
        const verificationPath = path.join(this.config.certDir, '.well-known', 'acme-challenge', challenge.token);
        fs.mkdirSync(path.dirname(verificationPath), { recursive: true });
        const keyAuthorization = this.acmeClient.getKeyAuthorization(challenge);
        fs.writeFileSync(verificationPath, keyAuthorization);
        
        // Wait for challenge to be verified
        await this.acmeClient.completeChallenge(challenge);
        await this.acmeClient.waitForValidStatus(challenge);
      }
      
      // Finalize order
      const [key, csr] = await acme.acmeCrypto.createCsr({
        commonName: this.config.domainName,
        altNames: [this.config.domainName]
      });
      
      await this.acmeClient.finalizeOrder(order, csr);
      
      // Wait for order to be valid
      const finalizedOrder = await this.acmeClient.waitForValidStatus(order);
      
      // Download certificate
      const certChain = await this.acmeClient.getCertificate(finalizedOrder);
      
      // Parse certificate
      const certPem = certChain.toString();
      const keyPem = key.toString();
      
      // Create certificate object
      const certObj = forge.pki.certificateFromPem(certPem);
      const expiresAt = new Date(certObj.validity.notAfter);
      
      const newCert: Certificate = {
        id: crypto.randomUUID(),
        cert: certPem,
        key: keyPem,
        ca: '',
        createdAt: new Date(),
        expiresAt,
        isActive: false,
        issuer: certObj.issuer.getField('CN').value,
        subject: certObj.subject.getField('CN').value,
        serialNumber: certObj.serialNumber,
        fingerprint: forge.util.bytesToHex(forge.pki.getPublicKeyFingerprint(certObj.publicKey))
      };
      
      // Insert into database
      await this.pool.query(
        `INSERT INTO certificates (
          id, cert_data, key_data, ca_data, created_at, expires_at, is_active,
          issuer, subject, serial_number, fingerprint
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          newCert.id,
          newCert.cert,
          newCert.key,
          newCert.ca,
          newCert.createdAt,
          newCert.expiresAt,
          newCert.isActive,
          newCert.issuer,
          newCert.subject,
          newCert.serialNumber,
          newCert.fingerprint
        ]
      );
      
      return newCert;
    } catch (error) {
      logger.error('Failed to generate Let\'s Encrypt certificate:', error);
      throw error;
    }
  }

  /**
   * Generate self-signed certificate
   */
  private async generateSelfSignedCertificate(): Promise<Certificate> {
    try {
      // Generate key pair
      const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
      
      // Create certificate
      const cert = forge.pki.createCertificate();
      
      // Setup certificate details
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + this.config.certRotationInterval);
      
      const attrs = [{
        name: 'commonName',
        value: 'Vici Self-Signed Certificate'
      }, {
        name: 'countryName',
        value: 'US'
      }, {
        shortName: 'ST',
        value: 'California'
      }, {
        name: 'localityName',
        value: 'San Francisco'
      }, {
        name: 'organizationName',
        value: 'Vici'
      }, {
        shortName: 'OU',
        value: 'Development'
      }];
      
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      
      // Sign certificate
      cert.sign(keys.privateKey, forge.md.sha256.create());
      
      // Convert to PEM
      const certPem = forge.pki.certificateToPem(cert);
      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
      
      // Create certificate object
      const newCert: Certificate = {
        id: crypto.randomUUID(),
        cert: certPem,
        key: keyPem,
        ca: '',
        createdAt: new Date(),
        expiresAt: cert.validity.notAfter,
        isActive: false,
        issuer: cert.issuer.getField('CN').value,
        subject: cert.subject.getField('CN').value,
        serialNumber: cert.serialNumber,
        fingerprint: forge.util.bytesToHex(forge.pki.getPublicKeyFingerprint(cert.publicKey))
      };
      
      // Insert into database
      await this.pool.query(
        `INSERT INTO certificates (
          id, cert_data, key_data, ca_data, created_at, expires_at, is_active,
          issuer, subject, serial_number, fingerprint
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          newCert.id,
          newCert.cert,
          newCert.key,
          newCert.ca,
          newCert.createdAt,
          newCert.expiresAt,
          newCert.isActive,
          newCert.issuer,
          newCert.subject,
          newCert.serialNumber,
          newCert.fingerprint
        ]
      );
      
      return newCert;
    } catch (error) {
      logger.error('Failed to generate self-signed certificate:', error);
      throw error;
    }
  }

  /**
   * Get certificate by ID
   */
  private async getCertificateById(certId: string): Promise<Certificate> {
    // Check cache first
    if (this.certCache.has(certId)) {
      return this.certCache.get(certId)!;
    }
    
    try {
      const result = await this.pool.query(
        'SELECT * FROM certificates WHERE id = $1',
        [certId]
      );
      
      if (result.rows.length === 0) {
        throw new Error(`Certificate not found: ${certId}`);
      }
      
      const row = result.rows[0];
      const cert: Certificate = {
        id: row.id,
        cert: row.cert_data,
        key: row.key_data,
        ca: row.ca_data,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        isActive: row.is_active,
        issuer: row.issuer,
        subject: row.subject,
        serialNumber: row.serial_number,
        fingerprint: row.fingerprint
      };
      
      this.certCache.set(cert.id, cert);
      
      return cert;
    } catch (error) {
      logger.error(`Failed to get certificate by ID: ${certId}`, error);
      throw error;
    }
  }

  /**
   * Get HTTPS options for server
   */
  getHttpsOptions(): https.ServerOptions {
    if (!this.activeCert) {
      throw new Error('No active certificate available');
    }
    
    const options: https.ServerOptions = {
      cert: fs.readFileSync(path.join(this.config.certDir, this.config.certFile)),
      key: fs.readFileSync(path.join(this.config.certDir, this.config.keyFile)),
      minVersion: this.config.minTlsVersion as any,
      ciphers: this.config.cipherSuites.join(':'),
      honorCipherOrder: true,
      requestCert: this.config.verifyClientCert,
      rejectUnauthorized: this.config.requireClientCert,
      secureOptions: crypto.constants.SSL_OP_NO_SSLv2 | 
                    crypto.constants.SSL_OP_NO_SSLv3 | 
                    crypto.constants.SSL_OP_NO_TLSv1 | 
                    crypto.constants.SSL_OP_NO_TLSv1_1 |
                    crypto.constants.SSL_OP_NO_COMPRESSION |
                    crypto.constants.SSL_OP_CIPHER_SERVER_PREFERENCE,
      sessionTimeout: 3600, // 1 hour
      sessionTickets: this.config.useSessionTickets,
      ticketKeys: this.sessionTicketKeys.map(key => {
        const buffer = Buffer.from(key.key);
        return buffer;
      }),
      ocspStapling: this.config.useOcspStapling,
      secureRenegotiation: this.config.useSecureRenegotiation,
      ecdhCurve: 'auto',
      sigalgs: [
        'ecdsa_secp256r1_sha256',
        'ecdsa_secp384r1_sha384',
        'ecdsa_secp521r1_sha512',
        'rsa_pss_rsae_sha256',
        'rsa_pss_rsae_sha384',
        'rsa_pss_rsae_sha512',
        'rsa_pkcs1_sha256',
        'rsa_pkcs1_sha384',
        'rsa_pkcs1_sha512'
      ].join(':'),
      maxVersion: 'TLSv1.3'
    };
    
    // Add CA certificate if available
    if (this.activeCert.ca) {
      options.ca = fs.readFileSync(path.join(this.config.certDir, this.config.caFile));
    }
    
    return options;
  }

  /**
   * Create HTTPS server
   */
  createHttpsServer(app: any): https.Server {
    if (!this.activeCert) {
      throw new Error('No active certificate available');
    }
    
    const options = this.getHttpsOptions();
    
    this.httpsServer = https.createServer(options, app);
    
    // Add HSTS header if enabled
    if (this.config.useHsts) {
      this.httpsServer.on('request', (req, res) => {
        res.setHeader('Strict-Transport-Security', `max-age=${this.config.hstsMaxAge}; includeSubDomains; preload`);
      });
    }
    
    return this.httpsServer;
  }

  /**
   * Get certificate history
   */
  async getCertificateHistory(): Promise<Certificate[]> {
    try {
      const result = await this.pool.query(
        'SELECT * FROM certificates ORDER BY created_at DESC'
      );
      
      return result.rows.map(row => ({
        id: row.id,
        cert: row.cert_data,
        key: row.key_data,
        ca: row.ca_data,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        isActive: row.is_active,
        issuer: row.issuer,
        subject: row.subject,
        serialNumber: row.serial_number,
        fingerprint: row.fingerprint
      }));
    } catch (error) {
      logger.error('Failed to get certificate history:', error);
      throw error;
    }
  }

  /**
   * End the service
   */
  async end(): Promise<void> {
    try {
      // Clear intervals
      if (this.certRotationInterval) {
        clearInterval(this.certRotationInterval);
        this.certRotationInterval = null;
      }
      
      if (this.sessionTicketRotationInterval) {
        clearInterval(this.sessionTicketRotationInterval);
        this.sessionTicketRotationInterval = null;
      }
      
      // Close HTTPS server if running
      if (this.httpsServer) {
        this.httpsServer.close();
        this.httpsServer = null;
      }
      
      logger.info('Transport encryption service ended');
    } catch (error) {
      logger.error('Failed to end transport encryption service:', error);
      throw error;
    }
  }
} 