import { RequestValidator, RequestValidationError } from '../../src/security/request-validator.js';
import type { Request, Response } from 'express';

// Mock request object
const mockRequest = (data: Partial<Request> = {}): Partial<Request> => ({
  method: 'POST',
  path: '/api/test',
  headers: {},
  query: {},
  params: {},
  body: {},
  ...data,
});

const mockResponse = (): Partial<Response> => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('RequestValidator', () => {
  describe('Field Validation', () => {
    it('should validate required string fields', () => {
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
          { field: 'email', type: 'email', required: true },
        ],
      });

      const req = mockRequest({
        body: { username: 'testuser', email: 'test@example.com' },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing required fields', () => {
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
          { field: 'password', type: 'string', required: true },
        ],
      });

      const req = mockRequest({
        body: { username: 'testuser' }, // missing password
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].field).toBe('password');
      expect(result.errors[0].message).toContain('required');
    });

    it('should validate string length constraints', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'username',
            type: 'string',
            required: true,
            minLength: 3,
            maxLength: 20,
          },
        ],
      });

      // Too short
      let req = mockRequest({ body: { username: 'ab' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('at least 3 characters');

      // Too long
      req = mockRequest({ body: { username: 'a'.repeat(25) } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('at most 20 characters');

      // Just right
      req = mockRequest({ body: { username: 'validuser' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate number fields and ranges', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'age',
            type: 'number',
            required: true,
            min: 18,
            max: 120,
          },
        ],
      });

      // Invalid number
      let req = mockRequest({ body: { age: 'not-a-number' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('must be a number');

      // Too small
      req = mockRequest({ body: { age: '15' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('at least 18');

      // Too large
      req = mockRequest({ body: { age: '150' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('at most 120');

      // Valid
      req = mockRequest({ body: { age: '25' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate email format', () => {
      const validator = new RequestValidator({
        body: [{ field: 'email', type: 'email', required: true }],
      });

      // Invalid email
      let req = mockRequest({ body: { email: 'invalid-email' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('valid email');

      // Valid email
      req = mockRequest({ body: { email: 'test@example.com' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate URL format', () => {
      const validator = new RequestValidator({
        body: [{ field: 'website', type: 'url', required: true }],
      });

      // Invalid URL
      let req = mockRequest({ body: { website: 'not-a-url' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('valid URL');

      // Valid URL
      req = mockRequest({ body: { website: 'https://example.com' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate boolean fields', () => {
      const validator = new RequestValidator({
        body: [{ field: 'isActive', type: 'boolean', required: true }],
      });

      // Valid boolean values
      const validValues = [true, false, 'true', 'false'];
      for (const value of validValues) {
        const req = mockRequest({ body: { isActive: value } }) as Request;
        const result = validator.validateRequest(req);
        expect(result.valid).toBe(true);
      }

      // Invalid boolean
      const req = mockRequest({ body: { isActive: 'maybe' } }) as Request;
      const result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('must be a boolean');
    });

    it('should validate JSON fields', () => {
      const validator = new RequestValidator({
        body: [{ field: 'config', type: 'json', required: true }],
      });

      // Invalid JSON
      let req = mockRequest({ body: { config: '{invalid json}' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('valid JSON');

      // Valid JSON
      req = mockRequest({ body: { config: '{"key": "value"}' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate pattern matching', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'phoneNumber',
            type: 'string',
            required: true,
            pattern: /^\+\d{1,3}\d{10}$/,
          },
        ],
      });

      // Invalid pattern
      let req = mockRequest({ body: { phoneNumber: '123-456-7890' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('format is invalid');

      // Valid pattern
      req = mockRequest({ body: { phoneNumber: '+1234567890123' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should validate allowed values', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'status',
            type: 'string',
            required: true,
            allowedValues: ['active', 'inactive', 'pending'],
          },
        ],
      });

      // Invalid value
      let req = mockRequest({ body: { status: 'unknown' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('must be one of');

      // Valid value
      req = mockRequest({ body: { status: 'active' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should support custom validators', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'customField',
            type: 'custom',
            required: true,
            validator: (value: any) => {
              if (value !== 'expected') {
                return 'Value must be "expected"';
              }
              return true;
            },
          },
        ],
      });

      // Invalid custom validation
      let req = mockRequest({ body: { customField: 'wrong' } }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toBe('Value must be "expected"');

      // Valid custom validation
      req = mockRequest({ body: { customField: 'expected' } }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });
  });

  describe('Content Type Validation', () => {
    it('should validate allowed content types', () => {
      const validator = new RequestValidator({
        allowedContentTypes: ['application/json'],
      });

      // Valid content type
      let req = mockRequest({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }) as Request;
      let result = validator.validateRequest(req);
      expect(result.valid).toBe(true);

      // Invalid content type
      req = mockRequest({
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
      }) as Request;
      result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Content type');
      expect(result.errors[0].message).toContain('not allowed');
    });

    it('should skip content type validation for GET requests', () => {
      const validator = new RequestValidator({
        allowedContentTypes: ['application/json'],
      });

      const req = mockRequest({
        method: 'GET',
        headers: { 'content-type': 'text/plain' },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });
  });

  describe('Strict Mode', () => {
    it('should reject unexpected fields in strict mode', () => {
      const validator = new RequestValidator({
        strictMode: true,
        body: [
          { field: 'username', type: 'string', required: true },
        ],
      });

      const req = mockRequest({
        body: {
          username: 'testuser',
          unexpectedField: 'value', // This should be rejected
        },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'unexpectedField')).toBe(true);
    });

    it('should allow unexpected fields when strict mode is off', () => {
      const validator = new RequestValidator({
        strictMode: false,
        body: [
          { field: 'username', type: 'string', required: true },
        ],
      });

      const req = mockRequest({
        body: {
          username: 'testuser',
          unexpectedField: 'value',
        },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });
  });

  describe('Input Sanitization', () => {
    it('should sanitize input by default', () => {
      const validator = new RequestValidator({
        sanitizeInput: true,
        body: [
          { field: 'message', type: 'string', required: true },
        ],
      });

      const req = mockRequest({
        body: {
          message: '<script>alert("xss")</script>',
        },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
      expect(result.sanitizedData?.body?.message).not.toContain('<script>');
      expect(result.sanitizedData?.body?.message).toContain('&lt;script&gt;');
    });

    it('should not sanitize when disabled', () => {
      const validator = new RequestValidator({
        sanitizeInput: false,
        body: [
          { field: 'message', type: 'string', required: true },
        ],
      });

      const req = mockRequest({
        body: {
          message: '<script>alert("xss")</script>',
        },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
      expect(result.sanitizedData).toBeUndefined();
    });
  });

  describe('Express Middleware', () => {
    it('should pass valid requests through', () => {
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
        ],
      });

      const middleware = validator.getMiddleware();
      const req = mockRequest({
        body: { username: 'testuser' },
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should reject invalid requests', () => {
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
        ],
      });

      const middleware = validator.getMiddleware();
      const req = mockRequest({
        body: {}, // missing required username
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation Error',
          code: 'VALIDATION_ERROR',
          errors: expect.arrayContaining([
            expect.objectContaining({
              field: 'username',
              message: expect.stringContaining('required'),
            }),
          ]),
        })
      );
    });

    it('should apply sanitized data to request', () => {
      const validator = new RequestValidator({
        sanitizeInput: true,
        body: [
          { field: 'message', type: 'string', required: true },
        ],
      });

      const middleware = validator.getMiddleware();
      const req = mockRequest({
        body: {
          message: '<script>evil</script>Safe content',
        },
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body.message).toContain('&lt;script&gt;');
      expect(req.body.message).toContain('Safe content');
    });

    it('should call validation error callback', () => {
      const onValidationError = jest.fn();
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
        ],
        onValidationError,
      });

      const middleware = validator.getMiddleware();
      const req = mockRequest({
        body: {}, // missing required field
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(onValidationError).toHaveBeenCalledWith(
        req,
        expect.arrayContaining([
          expect.objectContaining({
            field: 'username',
          }),
        ])
      );
    });
  });

  describe('Validation Rules Management', () => {
    it('should allow adding rules at runtime', () => {
      const validator = new RequestValidator();

      validator.addRule('body', {
        field: 'newField',
        type: 'string',
        required: true,
      });

      const req = mockRequest({
        body: { newField: 'value' },
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });

    it('should allow removing rules at runtime', () => {
      const validator = new RequestValidator({
        body: [
          { field: 'username', type: 'string', required: true },
        ],
      });

      // Remove the rule
      const removed = validator.removeRule('body', 'username');
      expect(removed).toBe(true);

      // Request without username should now be valid
      const req = mockRequest({
        body: {},
      }) as Request;

      const result = validator.validateRequest(req);
      expect(result.valid).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should provide rule statistics', () => {
      const validator = new RequestValidator({
        headers: [
          { field: 'authorization', type: 'string', required: true },
        ],
        query: [
          { field: 'page', type: 'number', required: false },
          { field: 'limit', type: 'number', required: false },
        ],
        body: [
          { field: 'username', type: 'string', required: true },
        ],
        maxBodySize: 2048,
        allowedContentTypes: ['application/json'],
      });

      const stats = validator.getStats();
      expect(stats.rulesCount.headers).toBe(1);
      expect(stats.rulesCount.query).toBe(2);
      expect(stats.rulesCount.body).toBe(1);
      expect(stats.rulesCount.params).toBe(0);
      expect(stats.config.maxBodySize).toBe(2048);
      expect(stats.config.allowedContentTypes).toEqual(['application/json']);
    });
  });

  describe('Error Handling', () => {
    it('should handle middleware errors gracefully', () => {
      const validator = new RequestValidator({
        body: [
          {
            field: 'test',
            type: 'custom',
            validator: () => {
              throw new Error('Validator error');
            },
          },
        ],
      });

      const middleware = validator.getMiddleware();
      const req = mockRequest({
        body: { test: 'value' },
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal Server Error',
          code: 'VALIDATION_MIDDLEWARE_ERROR',
        })
      );
    });
  });

  describe('Multiple Validation Locations', () => {
    it('should validate headers, query, params, and body', () => {
      const validator = new RequestValidator({
        headers: [
          { field: 'authorization', type: 'string', required: true },
        ],
        query: [
          { field: 'page', type: 'number', required: true },
        ],
        params: [
          { field: 'id', type: 'string', required: true },
        ],
        body: [
          { field: 'data', type: 'string', required: true },
        ],
      });

      // Valid request
      let req = mockRequest({
        headers: { authorization: 'Bearer token' },
        query: { page: '1' },
        params: { id: 'user123' },
        body: { data: 'test data' },
      }) as Request;

      let result = validator.validateRequest(req);
      expect(result.valid).toBe(true);

      // Invalid request (missing header)
      req = mockRequest({
        headers: {}, // missing authorization
        query: { page: '1' },
        params: { id: 'user123' },
        body: { data: 'test data' },
      }) as Request;

      result = validator.validateRequest(req);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.location === 'header' && e.field === 'authorization')).toBe(true);
    });
  });
});