import { DataValidationService } from '../dataValidationService';
import { ErrorHandlingService } from '../errorHandlingService';
import { Pool } from 'pg';
import { z } from 'zod';

describe('DataValidationService', () => {
  let service: DataValidationService;
  let errorHandlingService: ErrorHandlingService;
  let dbPool: Pool;

  const testConfig = {
    enabled: true,
    strictMode: true,
    maxStringLength: 100,
    allowedHtmlTags: ['p', 'br', 'strong', 'em'],
    allowedHtmlAttributes: ['class', 'id'],
    customValidators: {}
  };

  beforeEach(() => {
    errorHandlingService = ErrorHandlingService.getInstance();
    dbPool = new Pool();
    service = DataValidationService.getInstance(testConfig, errorHandlingService, dbPool);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateInput', () => {
    const testSchema = z.object({
      name: z.string().min(1),
      age: z.number().min(0),
      email: z.string().email()
    });

    it('should validate correct input', () => {
      const input = {
        name: 'John Doe',
        age: 30,
        email: 'john@example.com'
      };

      const result = service.validateInput(input, testSchema);
      expect(result).toEqual(input);
    });

    it('should throw error for invalid input', () => {
      const input = {
        name: '',
        age: -1,
        email: 'invalid-email'
      };

      expect(() => service.validateInput(input, testSchema)).toThrow();
    });
  });

  describe('sanitizeHtml', () => {
    it('should sanitize HTML content', () => {
      const input = '<p>Hello <script>alert("xss")</script>World</p>';
      const expected = '<p>Hello World</p>';
      expect(service.sanitizeHtml(input)).toBe(expected);
    });

    it('should allow specified HTML tags', () => {
      const input = '<p>Hello <strong>World</strong></p>';
      expect(service.sanitizeHtml(input)).toBe(input);
    });
  });

  describe('escapeHtml', () => {
    it('should escape HTML content', () => {
      const input = '<p>Hello World</p>';
      const expected = '&lt;p&gt;Hello World&lt;/p&gt;';
      expect(service.escapeHtml(input)).toBe(expected);
    });
  });

  describe('validateQueryParams', () => {
    it('should validate and sanitize query parameters', () => {
      const query = 'SELECT * FROM users WHERE name = $1 AND age = $2';
      const params = ['John Doe', 30];
      const result = service.validateQueryParams(query, params);
      expect(result).toEqual(['John Doe', 30]);
    });

    it('should throw error for parameter count mismatch', () => {
      const query = 'SELECT * FROM users WHERE name = $1';
      const params = ['John Doe', 30];
      expect(() => service.validateQueryParams(query, params)).toThrow();
    });
  });

  describe('validateJsonPayload', () => {
    const testSchema = z.object({
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string())
    });

    it('should validate correct JSON payload', () => {
      const payload = {
        title: 'Test Title',
        content: 'Test Content',
        tags: ['test', 'validation']
      };

      const result = service.validateJsonPayload(payload, testSchema);
      expect(result).toEqual(payload);
    });

    it('should throw error for invalid JSON payload', () => {
      const payload = {
        title: 123,
        content: 'Test Content',
        tags: 'not an array'
      };

      expect(() => service.validateJsonPayload(payload, testSchema)).toThrow();
    });
  });

  describe('validateEmail', () => {
    it('should validate correct email addresses', () => {
      expect(service.validateEmail('test@example.com')).toBe(true);
      expect(service.validateEmail('user.name@domain.co.uk')).toBe(true);
    });

    it('should reject invalid email addresses', () => {
      expect(service.validateEmail('invalid-email')).toBe(false);
      expect(service.validateEmail('test@')).toBe(false);
      expect(service.validateEmail('@example.com')).toBe(false);
    });
  });

  describe('validatePassword', () => {
    it('should validate strong passwords', () => {
      expect(service.validatePassword('Password123!')).toBe(true);
      expect(service.validatePassword('StrongP@ssw0rd')).toBe(true);
    });

    it('should reject weak passwords', () => {
      expect(service.validatePassword('password')).toBe(false);
      expect(service.validatePassword('Password123')).toBe(false);
      expect(service.validatePassword('P@ss')).toBe(false);
    });
  });

  describe('validateUrl', () => {
    it('should validate correct URLs', () => {
      expect(service.validateUrl('https://example.com')).toBe(true);
      expect(service.validateUrl('http://localhost:3000')).toBe(true);
    });

    it('should reject invalid URLs', () => {
      expect(service.validateUrl('not-a-url')).toBe(false);
      expect(service.validateUrl('http://')).toBe(false);
    });
  });

  describe('validatePhone', () => {
    it('should validate correct phone numbers', () => {
      expect(service.validatePhone('+1 (555) 123-4567')).toBe(true);
      expect(service.validatePhone('5551234567')).toBe(true);
    });

    it('should reject invalid phone numbers', () => {
      expect(service.validatePhone('123')).toBe(false);
      expect(service.validatePhone('abc')).toBe(false);
    });
  });

  describe('validateCreditCard', () => {
    it('should validate correct credit card numbers', () => {
      expect(service.validateCreditCard('4532015112830366')).toBe(true); // Visa
      expect(service.validateCreditCard('5577000055770004')).toBe(true); // Mastercard
    });

    it('should reject invalid credit card numbers', () => {
      expect(service.validateCreditCard('1234567890123456')).toBe(false);
      expect(service.validateCreditCard('453201511283036')).toBe(false);
    });
  });

  describe('validateDateFormat', () => {
    it('should validate correct date formats', () => {
      expect(service.validateDateFormat('2023-01-01', 'YYYY-MM-DD')).toBe(true);
      expect(service.validateDateFormat('01/01/2023', 'MM/DD/YYYY')).toBe(true);
    });

    it('should reject invalid date formats', () => {
      expect(service.validateDateFormat('2023-13-01', 'YYYY-MM-DD')).toBe(false);
      expect(service.validateDateFormat('not-a-date', 'YYYY-MM-DD')).toBe(false);
    });
  });

  describe('validateFileType', () => {
    it('should validate allowed file types', () => {
      const file = new File([''], 'test.pdf', { type: 'application/pdf' });
      expect(service.validateFileType(file, ['application/pdf'])).toBe(true);
    });

    it('should reject disallowed file types', () => {
      const file = new File([''], 'test.exe', { type: 'application/exe' });
      expect(service.validateFileType(file, ['application/pdf'])).toBe(false);
    });
  });

  describe('validateFileSize', () => {
    it('should validate file size within limit', () => {
      const file = new File([''], 'test.pdf', { type: 'application/pdf' });
      Object.defineProperty(file, 'size', { value: 1024 * 1024 }); // 1MB
      expect(service.validateFileSize(file, 2 * 1024 * 1024)).toBe(true); // 2MB limit
    });

    it('should reject files exceeding size limit', () => {
      const file = new File([''], 'test.pdf', { type: 'application/pdf' });
      Object.defineProperty(file, 'size', { value: 3 * 1024 * 1024 }); // 3MB
      expect(service.validateFileSize(file, 2 * 1024 * 1024)).toBe(false); // 2MB limit
    });
  });
}); 