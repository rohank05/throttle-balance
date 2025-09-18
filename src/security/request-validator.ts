import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export interface ValidationRule {
  field: string;
  type: 'string' | 'number' | 'boolean' | 'email' | 'url' | 'json' | 'custom';
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  validator?: (value: any) => boolean | string;
  sanitize?: boolean;
  allowedValues?: any[];
}

export interface RequestValidationConfig {
  headers?: ValidationRule[];
  query?: ValidationRule[];
  body?: ValidationRule[];
  params?: ValidationRule[];
  maxBodySize?: number;
  allowedContentTypes?: string[];
  sanitizeInput?: boolean;
  strictMode?: boolean;
  onValidationError?: (req: Request, errors: ValidationError[]) => void;
}

export interface ValidationError {
  field: string;
  location: 'header' | 'query' | 'body' | 'param';
  message: string;
  value?: any;
  rule?: ValidationRule;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  sanitizedData?: {
    headers?: Record<string, any>;
    query?: Record<string, any>;
    body?: any;
    params?: Record<string, any>;
  };
}

export class RequestValidationError extends Error {
  public readonly statusCode: number;
  public readonly errors: ValidationError[];

  constructor(message: string, errors: ValidationError[]) {
    super(message);
    this.name = 'RequestValidationError';
    this.statusCode = 400;
    this.errors = errors;
  }
}

export class RequestValidator {
  private readonly config: RequestValidationConfig;
  private readonly logger: Logger;

  constructor(config: RequestValidationConfig = {}, logger?: Logger) {
    this.config = {
      maxBodySize: config.maxBodySize || 1024 * 1024, // 1MB
      allowedContentTypes: config.allowedContentTypes || [
        'application/json',
        'application/x-www-form-urlencoded',
        'text/plain',
        'multipart/form-data',
      ],
      sanitizeInput: config.sanitizeInput ?? true,
      strictMode: config.strictMode ?? false,
      ...config,
    };
    this.logger = logger || createDefaultLogger();
  }

  validateRequest(req: Request): ValidationResult {
    const errors: ValidationError[] = [];
    const sanitizedData: any = {};

    // Validate content type
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.headers['content-type'];
      if (contentType && this.config.allowedContentTypes) {
        const isAllowed = this.config.allowedContentTypes.some(allowed =>
          contentType.toLowerCase().startsWith(allowed.toLowerCase())
        );
        if (!isAllowed) {
          errors.push({
            field: 'content-type',
            location: 'header',
            message: `Content type '${contentType}' is not allowed`,
          });
        }
      }
    }

    // Validate headers
    if (this.config.headers) {
      const { valid, sanitized, validationErrors } = this.validateObject(
        req.headers,
        this.config.headers,
        'header'
      );
      if (!valid) {
        errors.push(...validationErrors);
      }
      if (sanitized) {
        sanitizedData.headers = sanitized;
      }
    }

    // Validate query parameters
    if (this.config.query) {
      const { valid, sanitized, validationErrors } = this.validateObject(
        req.query,
        this.config.query,
        'query'
      );
      if (!valid) {
        errors.push(...validationErrors);
      }
      if (sanitized) {
        sanitizedData.query = sanitized;
      }
    }

    // Validate URL parameters
    if (this.config.params) {
      const { valid, sanitized, validationErrors } = this.validateObject(
        req.params,
        this.config.params,
        'param'
      );
      if (!valid) {
        errors.push(...validationErrors);
      }
      if (sanitized) {
        sanitizedData.params = sanitized;
      }
    }

    // Validate body
    if (this.config.body && req.body) {
      const { valid, sanitized, validationErrors } = this.validateObject(
        req.body,
        this.config.body,
        'body'
      );
      if (!valid) {
        errors.push(...validationErrors);
      }
      if (sanitized) {
        sanitizedData.body = sanitized;
      }
    }

    const isValid = errors.length === 0;

    this.logger.debug('Request validation completed', {
      valid: isValid,
      errorCount: errors.length,
      path: req.path,
      method: req.method,
    });

    return {
      valid: isValid,
      errors,
      sanitizedData: Object.keys(sanitizedData).length > 0 ? sanitizedData : undefined,
    };
  }

  private validateObject(
    obj: Record<string, any>,
    rules: ValidationRule[],
    location: 'header' | 'query' | 'body' | 'param'
  ): { valid: boolean; sanitized: Record<string, any> | undefined; validationErrors: ValidationError[] } {
    const errors: ValidationError[] = [];
    const sanitized: Record<string, any> = {};

    for (const rule of rules) {
      const value = obj[rule.field];
      const validationResult = this.validateField(value, rule);

      if (validationResult !== true) {
        errors.push({
          field: rule.field,
          location,
          message: typeof validationResult === 'string' ? validationResult : `Invalid ${rule.field}`,
          value,
          rule,
        });
      } else if (this.config.sanitizeInput && rule.sanitize !== false) {
        sanitized[rule.field] = this.sanitizeValue(value, rule);
      }
    }

    // In strict mode, check for unexpected fields
    if (this.config.strictMode) {
      const allowedFields = new Set(rules.map(rule => rule.field));
      for (const field in obj) {
        if (!allowedFields.has(field)) {
          errors.push({
            field,
            location,
            message: `Unexpected field '${field}' is not allowed`,
            value: obj[field],
          });
        }
      }
    }

    const sanitizedResult = Object.keys(sanitized).length > 0 ? sanitized : undefined;

    return {
      valid: errors.length === 0,
      sanitized: sanitizedResult,
      validationErrors: errors,
    };
  }

  private validateField(value: any, rule: ValidationRule): boolean | string {
    // Check if field is required
    if (rule.required && (value === undefined || value === null || value === '')) {
      return `${rule.field} is required`;
    }

    // Skip validation if field is not required and empty
    if (!rule.required && (value === undefined || value === null || value === '')) {
      return true;
    }

    // Type validation
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') {
          return `${rule.field} must be a string`;
        }
        break;
      case 'number':
        const num = Number(value);
        if (isNaN(num)) {
          return `${rule.field} must be a number`;
        }
        value = num;
        break;
      case 'boolean':
        if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
          return `${rule.field} must be a boolean`;
        }
        break;
      case 'email':
        if (typeof value !== 'string' || !this.isValidEmail(value)) {
          return `${rule.field} must be a valid email`;
        }
        break;
      case 'url':
        if (typeof value !== 'string' || !this.isValidUrl(value)) {
          return `${rule.field} must be a valid URL`;
        }
        break;
      case 'json':
        if (typeof value === 'string') {
          try {
            JSON.parse(value);
          } catch {
            return `${rule.field} must be valid JSON`;
          }
        }
        break;
      case 'custom':
        if (rule.validator) {
          const result = rule.validator(value);
          if (result !== true) {
            return typeof result === 'string' ? result : `${rule.field} is invalid`;
          }
        }
        break;
    }

    // Length validation for strings
    if (typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        return `${rule.field} must be at least ${rule.minLength} characters`;
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        return `${rule.field} must be at most ${rule.maxLength} characters`;
      }
    }

    // Numeric range validation
    if (typeof value === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        return `${rule.field} must be at least ${rule.min}`;
      }
      if (rule.max !== undefined && value > rule.max) {
        return `${rule.field} must be at most ${rule.max}`;
      }
    }

    // Pattern validation
    if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
      return `${rule.field} format is invalid`;
    }

    // Allowed values validation
    if (rule.allowedValues && !rule.allowedValues.includes(value)) {
      return `${rule.field} must be one of: ${rule.allowedValues.join(', ')}`;
    }

    return true;
  }

  private sanitizeValue(value: any, _rule: ValidationRule): any {
    if (typeof value !== 'string') {
      return value;
    }

    let sanitized = value;

    // Basic HTML entity encoding
    sanitized = sanitized
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');

    // Remove control characters except tab, newline, and carriage return
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Trim whitespace
    sanitized = sanitized.trim();

    return sanitized;
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  getMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      try {
        const result = this.validateRequest(req);

        if (!result.valid) {
          if (this.config.onValidationError) {
            this.config.onValidationError(req, result.errors);
          }

          this.logger.warn('Request validation failed', {
            path: req.path,
            method: req.method,
            errors: result.errors,
            ip: req.ip,
          });

          res.status(400).json({
            error: 'Validation Error',
            message: 'Request validation failed',
            code: 'VALIDATION_ERROR',
            errors: result.errors.map(err => ({
              field: err.field,
              location: err.location,
              message: err.message,
            })),
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Apply sanitized data if available
        if (result.sanitizedData) {
          if (result.sanitizedData.headers) {
            Object.assign(req.headers, result.sanitizedData.headers);
          }
          if (result.sanitizedData.query) {
            Object.assign(req.query, result.sanitizedData.query);
          }
          if (result.sanitizedData.body) {
            req.body = result.sanitizedData.body;
          }
          if (result.sanitizedData.params) {
            Object.assign(req.params, result.sanitizedData.params);
          }
        }

        next();
      } catch (error) {
        this.logger.error('Request validation middleware error', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Request validation failed',
          code: 'VALIDATION_MIDDLEWARE_ERROR',
          timestamp: new Date().toISOString(),
        });
      }
    };
  }

  addRule(location: 'headers' | 'query' | 'body' | 'params', rule: ValidationRule): void {
    if (!this.config[location]) {
      this.config[location] = [];
    }
    this.config[location]!.push(rule);
    this.logger.info(`Added validation rule for ${location}.${rule.field}`);
  }

  removeRule(location: 'headers' | 'query' | 'body' | 'params', fieldName: string): boolean {
    if (!this.config[location]) {
      return false;
    }

    const index = this.config[location]!.findIndex(rule => rule.field === fieldName);
    if (index > -1) {
      this.config[location]!.splice(index, 1);
      this.logger.info(`Removed validation rule for ${location}.${fieldName}`);
      return true;
    }
    return false;
  }

  getStats(): {
    rulesCount: {
      headers: number;
      query: number;
      body: number;
      params: number;
    };
    config: {
      maxBodySize: number;
      allowedContentTypes: string[];
      sanitizeInput: boolean;
      strictMode: boolean;
    };
  } {
    return {
      rulesCount: {
        headers: this.config.headers?.length || 0,
        query: this.config.query?.length || 0,
        body: this.config.body?.length || 0,
        params: this.config.params?.length || 0,
      },
      config: {
        maxBodySize: this.config.maxBodySize || 0,
        allowedContentTypes: this.config.allowedContentTypes || [],
        sanitizeInput: this.config.sanitizeInput || false,
        strictMode: this.config.strictMode || false,
      },
    };
  }
}