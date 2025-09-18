import {
  validateFlowControlConfig,
  flowControlConfigSchema,
  ConfigValidationError,
  serverSchema,
  healthCheckSchema,
  rateLimiterSchema,
  loadBalancerSchema,
  securitySchema,
  loggingSchema,
  redisStoreSchema,
} from '../../src/validation/index.js';

describe('Configuration Validation', () => {
  describe('FlowControl Configuration', () => {
    it('should validate minimal valid configuration', () => {
      const config = {
        rateLimiter: {
          maxRequests: 100,
        },
      };

      const { error, value } = validateFlowControlConfig(config);

      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        rateLimiter: {
          maxRequests: 100,
          windowMs: 60000, // default
          message: 'Too many requests', // default
        },
      });
    });

    it('should require at least one of rateLimiter or loadBalancer', () => {
      const config = {};

      const { error } = validateFlowControlConfig(config);

      expect(error).toBeDefined();
      expect(error!.message).toContain('At least one of rateLimiter or loadBalancer');
    });

    it('should validate complete configuration with all features', () => {
      const config = {
        rateLimiter: {
          windowMs: 120000,
          maxRequests: 50,
          message: 'Custom rate limit message',
          store: 'redis',
        },
        loadBalancer: {
          servers: [
            { host: 'api1.example.com', port: 8080, weight: 0.7 },
            { host: 'api2.example.com', port: 8080, weight: 0.3 },
          ],
          strategy: 'weighted',
          healthCheck: {
            enabled: true,
            endpoint: '/api/health',
            interval: 10000,
            timeout: 3000,
          },
          proxyTimeout: 45000,
        },
        security: {
          ipFilter: {
            mode: 'whitelist',
            whitelist: ['192.168.1.0/24', '10.0.0.1'],
          },
          headers: {
            contentSecurityPolicy: {
              enabled: true,
              directives: {
                'default-src': ["'self'"],
                'script-src': ["'self'", "'unsafe-inline'"],
              },
            },
          },
        },
        logging: {
          level: 'debug',
          maskSensitiveData: true,
        },
        store: {
          type: 'redis',
          redis: {
            host: 'redis.example.com',
            port: 6380,
            password: 'redis-password',
            keyPrefix: 'my-app:',
          },
        },
      };

      const { error, value } = validateFlowControlConfig(config);

      expect(error).toBeUndefined();
      expect(value.rateLimiter?.maxRequests).toBe(50);
      expect(value.loadBalancer?.servers).toHaveLength(2);
      expect(value.security?.ipFilter?.mode).toBe('whitelist');
      expect(value.store?.redis?.host).toBe('redis.example.com');
    });

    it('should reject unknown properties', () => {
      const config = {
        rateLimiter: {
          maxRequests: 100,
        },
        unknownProperty: 'should be stripped',
      };

      const { error, value } = validateFlowControlConfig(config);

      expect(error).toBeUndefined();
      expect(value).not.toHaveProperty('unknownProperty');
    });
  });

  describe('Server Schema', () => {
    it('should validate valid server configuration', () => {
      const server = {
        host: 'api.example.com',
        port: 8080,
        weight: 0.5,
        maxConnections: 100,
      };

      const { error, value } = serverSchema.validate(server);

      expect(error).toBeUndefined();
      expect(value).toEqual(server);
    });

    it('should require host and port', () => {
      const server = {
        port: 8080,
      };

      const { error } = serverSchema.validate(server);

      expect(error).toBeDefined();
      expect(error!.details[0].path).toEqual(['host']);
    });

    it('should validate port range', () => {
      const server = {
        host: 'api.example.com',
        port: 70000, // Invalid port
      };

      const { error } = serverSchema.validate(server);

      expect(error).toBeDefined();
      expect(error!.message).toContain('less than or equal to 65535');
    });

    it('should validate hostname format', () => {
      const server = {
        host: 'invalid_hostname!',
        port: 8080,
      };

      const { error } = serverSchema.validate(server);

      expect(error).toBeDefined();
    });
  });

  describe('Health Check Schema', () => {
    it('should validate with defaults', () => {
      const { error, value } = healthCheckSchema.validate({});

      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        enabled: true,
        endpoint: '/health',
        interval: 30000,
        timeout: 5000,
        expectedStatus: 200,
      });
    });

    it('should validate custom configuration', () => {
      const config = {
        enabled: true,
        endpoint: '/api/status',
        interval: 15000,
        timeout: 2000,
        successThreshold: 2,
        failureThreshold: 5,
        expectedStatus: 204,
        expectedBody: 'OK',
        headers: {
          'Authorization': 'Bearer token',
          'X-Health-Check': 'true',
        },
      };

      const { error, value } = healthCheckSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value).toEqual(config);
    });

    it('should validate endpoint as relative URI', () => {
      const config = {
        endpoint: 'http://external.com/health', // Should be relative
      };

      const { error } = healthCheckSchema.validate(config);

      expect(error).toBeDefined();
    });
  });

  describe('Rate Limiter Schema', () => {
    it('should require maxRequests', () => {
      const config = {
        windowMs: 60000,
      };

      const { error } = rateLimiterSchema.validate(config);

      expect(error).toBeDefined();
      expect(error!.details[0].path).toEqual(['maxRequests']);
    });

    it('should validate store types', () => {
      const config = {
        maxRequests: 100,
        store: 'invalid-store',
      };

      const { error } = rateLimiterSchema.validate(config);

      expect(error).toBeDefined();
      expect(error!.message).toContain('must be one of');
    });

    it('should apply defaults', () => {
      const config = {
        maxRequests: 50,
      };

      const { error, value } = rateLimiterSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value).toMatchObject({
        maxRequests: 50,
        windowMs: 60000,
        message: 'Too many requests',
        standardHeaders: true,
        legacyHeaders: false,
        store: 'memory',
      });
    });
  });

  describe('Load Balancer Schema', () => {
    it('should require servers array', () => {
      const config = {};

      const { error } = loadBalancerSchema.validate(config);

      expect(error).toBeDefined();
      expect(error!.details[0].path).toEqual(['servers']);
    });

    it('should require at least one server', () => {
      const config = {
        servers: [],
      };

      const { error } = loadBalancerSchema.validate(config);

      expect(error).toBeDefined();
      expect(error!.message).toContain('at least 1 items');
    });

    it('should validate strategy options', () => {
      const config = {
        servers: [{ host: 'api.example.com', port: 8080 }],
        strategy: 'invalid-strategy',
      };

      const { error } = loadBalancerSchema.validate(config);

      expect(error).toBeDefined();
    });
  });

  describe('Security Schema', () => {
    it('should validate IP filter configuration', () => {
      const config = {
        ipFilter: {
          mode: 'whitelist',
          whitelist: ['192.168.1.0/24', '10.0.0.1'],
          defaultAction: 'deny',
        },
      };

      const { error, value } = securitySchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.ipFilter?.whitelist).toHaveLength(2);
    });

    it('should validate IP addresses and CIDR ranges', () => {
      const config = {
        ipFilter: {
          whitelist: ['invalid-ip', '192.168.1.0/24'],
        },
      };

      const { error } = securitySchema.validate(config);

      expect(error).toBeDefined();
    });

    it('should validate security headers configuration', () => {
      const config = {
        headers: {
          contentSecurityPolicy: {
            enabled: true,
            directives: {
              'default-src': ["'self'"],
              'script-src': ["'self'", "'unsafe-inline'"],
            },
          },
          strictTransportSecurity: {
            enabled: true,
            maxAge: 31536000,
            includeSubDomains: false,
          },
        },
      };

      const { error, value } = securitySchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.headers?.contentSecurityPolicy?.directives).toBeDefined();
    });
  });

  describe('Logging Schema', () => {
    it('should validate log levels', () => {
      const config = {
        level: 'invalid-level',
      };

      const { error } = loggingSchema.validate(config);

      expect(error).toBeDefined();
    });

    it('should validate transport configuration', () => {
      const config = {
        level: 'info',
        transports: [
          {
            type: 'console',
            level: 'debug',
            options: {
              prettyPrint: true,
            },
          },
          {
            type: 'file',
            options: {
              filename: 'app.log',
            },
          },
        ],
      };

      const { error, value } = loggingSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.transports).toHaveLength(2);
    });
  });

  describe('Redis Store Schema', () => {
    it('should validate basic Redis configuration', () => {
      const config = {
        host: 'redis.example.com',
        port: 6380,
        password: 'secret',
        db: 2,
        keyPrefix: 'app:',
      };

      const { error, value } = redisStoreSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value).toMatchObject(config);
      expect(value.host).toBe('redis.example.com');
      expect(value.port).toBe(6380);
    });

    it('should validate cluster configuration', () => {
      const config = {
        cluster: {
          enabledNodes: [
            { host: 'redis1.example.com', port: 6379 },
            { host: 'redis2.example.com', port: 6379 },
          ],
          enableReadyCheck: true,
          maxRedirections: 16,
        },
      };

      const { error, value } = redisStoreSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.cluster?.enabledNodes).toHaveLength(2);
    });

    it('should validate sentinel configuration', () => {
      const config = {
        sentinel: {
          sentinels: [
            { host: 'sentinel1.example.com', port: 26379 },
            { host: 'sentinel2.example.com', port: 26379 },
          ],
          name: 'mymaster',
          password: 'sentinel-password',
        },
      };

      const { error, value } = redisStoreSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.sentinel?.sentinels).toHaveLength(2);
    });

    it('should allow both cluster and sentinel (but prefer cluster)', () => {
      const config = {
        cluster: {
          enabledNodes: [{ host: 'redis1.example.com', port: 6379 }],
        },
        sentinel: {
          sentinels: [{ host: 'sentinel1.example.com', port: 26379 }],
          name: 'mymaster',
        },
      };

      const { error, value } = redisStoreSchema.validate(config);

      expect(error).toBeUndefined();
      expect(value.cluster).toBeDefined();
      expect(value.sentinel).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should provide detailed error information', () => {
      const config = {
        rateLimiter: {
          windowMs: 'invalid', // Should be number
          maxRequests: -1, // Should be positive
        },
        loadBalancer: {
          servers: [
            { host: 'invalid_host!', port: 70000 }, // Invalid host and port
          ],
        },
      };

      const { error } = validateFlowControlConfig(config);

      expect(error).toBeDefined();
      expect(error!.details.length).toBeGreaterThan(1);

      const errorsByPath = error!.details.reduce((acc, detail) => {
        const path = detail.path.join('.');
        acc[path] = detail.message;
        return acc;
      }, {} as Record<string, string>);

      expect(errorsByPath['rateLimiter.windowMs']).toBeDefined();
      expect(errorsByPath['rateLimiter.maxRequests']).toBeDefined();
      expect(errorsByPath['loadBalancer.servers.0.port']).toBeDefined();
    });
  });

  describe('ConfigValidationError', () => {
    it('should format error messages correctly', () => {
      const config = {
        rateLimiter: {
          maxRequests: -1,
        },
      };

      const { error } = validateFlowControlConfig(config);
      const validationError = new ConfigValidationError('Test error', error);

      const formattedMessage = validationError.getFormattedMessage();
      expect(formattedMessage).toContain('Test error');
      expect(formattedMessage).toContain('rateLimiter.maxRequests');

      const errorsByPath = validationError.getErrorsByPath();
      expect(errorsByPath['rateLimiter.maxRequests']).toBeDefined();

      expect(validationError.hasErrorForField('rateLimiter.maxRequests')).toBe(true);
      expect(validationError.hasErrorForField('nonexistent.field')).toBe(false);

      const fieldErrors = validationError.getErrorsForField('rateLimiter.maxRequests');
      expect(fieldErrors).toHaveLength(1);
    });
  });
});