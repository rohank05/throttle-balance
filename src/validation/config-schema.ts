import Joi from 'joi';
import type {
  FlowControlConfig,
  RateLimiterConfig,
  LoadBalancerConfig,
  CircuitBreakerConfig,
  HealthCheckConfig,
  SecurityConfig,
  LoggingConfig
} from '../types/index.js';

// Server schema for load balancer
const serverSchema = Joi.object({
  host: Joi.string().hostname().required(),
  port: Joi.number().integer().min(1).max(65535).required(),
  weight: Joi.number().min(0).max(1).default(1),
  maxConnections: Joi.number().integer().min(1).optional(),
});

// Health check configuration schema
const healthCheckSchema = Joi.object({
  enabled: Joi.boolean().default(true),
  endpoint: Joi.string().uri({ relativeOnly: true }).default('/health'),
  interval: Joi.number().integer().min(1000).default(30000),
  timeout: Joi.number().integer().min(100).default(5000),
  successThreshold: Joi.number().integer().min(1).default(1),
  failureThreshold: Joi.number().integer().min(1).default(3),
  expectedStatus: Joi.number().integer().min(100).max(599).default(200),
  expectedBody: Joi.string().optional(),
  headers: Joi.object().pattern(Joi.string(), Joi.string()).optional(),
});

// Circuit breaker configuration schema
const circuitBreakerSchema = Joi.object({
  failureThreshold: Joi.number().integer().min(1).default(5),
  recoveryTimeout: Joi.number().integer().min(1000).default(60000),
  monitoringPeriod: Joi.number().integer().min(1000).default(60000),
  expectedFailureRate: Joi.number().min(0).max(1).default(0.5),
  minimumRequests: Joi.number().integer().min(1).default(10),
});

// Rate limiter configuration schema
const rateLimiterSchema = Joi.object({
  windowMs: Joi.number().integer().min(1000).default(60000),
  maxRequests: Joi.number().integer().min(1).required(),
  message: Joi.string().default('Too many requests'),
  standardHeaders: Joi.boolean().default(true),
  legacyHeaders: Joi.boolean().default(false),
  store: Joi.string().valid('memory', 'redis').default('memory'),
  keyGenerator: Joi.function().optional(),
  onLimitReached: Joi.function().optional(),
  skipFailedRequests: Joi.boolean().default(false),
  skipSuccessfulRequests: Joi.boolean().default(false),
});

// Load balancer configuration schema
const loadBalancerSchema = Joi.object({
  servers: Joi.array().items(serverSchema).min(1).required(),
  strategy: Joi.string().valid('round-robin', 'weighted', 'least-connections').default('round-robin'),
  healthCheck: healthCheckSchema.optional(),
  proxyTimeout: Joi.number().integer().min(1000).default(30000),
  retryAttempts: Joi.number().integer().min(0).default(3),
  retryDelay: Joi.number().integer().min(0).default(1000),
  circuitBreaker: circuitBreakerSchema.optional(),
});

// Security configuration schemas
const ipFilterSchema = Joi.object({
  mode: Joi.string().valid('whitelist', 'blacklist', 'hybrid').default('hybrid'),
  whitelist: Joi.array().items(Joi.string().ip({ version: ['ipv4', 'ipv6'], cidr: 'optional' })).optional(),
  blacklist: Joi.array().items(Joi.string().ip({ version: ['ipv4', 'ipv6'], cidr: 'optional' })).optional(),
  defaultAction: Joi.string().valid('allow', 'deny').default('allow'),
  customRules: Joi.array().items(Joi.object({
    pattern: Joi.string().required(),
    action: Joi.string().valid('allow', 'deny').required(),
    priority: Joi.number().integer().min(1).default(100),
  })).optional(),
});

const securityRateLimiterSchema = Joi.object({
  maxAttempts: Joi.number().integer().min(1).default(5),
  windowMs: Joi.number().integer().min(1000).default(60000),
  blockDuration: Joi.number().integer().min(1000).default(300000),
  progressiveDelay: Joi.boolean().default(false),
  store: Joi.object().optional(),
  keyGenerator: Joi.function().optional(),
});

const requestValidatorSchema = Joi.object({
  headers: Joi.array().items(Joi.object({
    field: Joi.string().required(),
    type: Joi.string().valid('string', 'number', 'boolean').required(),
    required: Joi.boolean().default(false),
    pattern: Joi.string().optional(),
    minLength: Joi.number().integer().min(0).optional(),
    maxLength: Joi.number().integer().min(0).optional(),
    min: Joi.number().optional(),
    max: Joi.number().optional(),
  })).optional(),
  query: Joi.array().items(Joi.object({
    field: Joi.string().required(),
    type: Joi.string().valid('string', 'number', 'boolean').required(),
    required: Joi.boolean().default(false),
    pattern: Joi.string().optional(),
    minLength: Joi.number().integer().min(0).optional(),
    maxLength: Joi.number().integer().min(0).optional(),
    min: Joi.number().optional(),
    max: Joi.number().optional(),
  })).optional(),
  body: Joi.array().items(Joi.object({
    field: Joi.string().required(),
    type: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').required(),
    required: Joi.boolean().default(false),
    pattern: Joi.string().optional(),
    minLength: Joi.number().integer().min(0).optional(),
    maxLength: Joi.number().integer().min(0).optional(),
    min: Joi.number().optional(),
    max: Joi.number().optional(),
  })).optional(),
  params: Joi.array().items(Joi.object({
    field: Joi.string().required(),
    type: Joi.string().valid('string', 'number', 'boolean').required(),
    required: Joi.boolean().default(false),
    pattern: Joi.string().optional(),
    minLength: Joi.number().integer().min(0).optional(),
    maxLength: Joi.number().integer().min(0).optional(),
    min: Joi.number().optional(),
    max: Joi.number().optional(),
  })).optional(),
  sanitization: Joi.object({
    enabled: Joi.boolean().default(true),
    htmlEscape: Joi.boolean().default(true),
    trimWhitespace: Joi.boolean().default(true),
    removeNullBytes: Joi.boolean().default(true),
  }).optional(),
});

const securityHeadersSchema = Joi.object({
  contentSecurityPolicy: Joi.object({
    enabled: Joi.boolean().default(true),
    directives: Joi.object().pattern(
      Joi.string(),
      Joi.array().items(Joi.string())
    ).optional(),
  }).optional(),
  strictTransportSecurity: Joi.object({
    enabled: Joi.boolean().default(true),
    maxAge: Joi.number().integer().min(0).default(31536000),
    includeSubDomains: Joi.boolean().default(true),
    preload: Joi.boolean().default(false),
  }).optional(),
  frameOptions: Joi.string().valid('DENY', 'SAMEORIGIN').default('DENY'),
  contentTypeOptions: Joi.boolean().default(true),
  xssProtection: Joi.object({
    enabled: Joi.boolean().default(true),
    mode: Joi.string().valid('block', 'report').default('block'),
    reportUri: Joi.string().uri().optional(),
  }).optional(),
  referrerPolicy: Joi.string().valid(
    'no-referrer',
    'no-referrer-when-downgrade',
    'origin',
    'origin-when-cross-origin',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url'
  ).default('strict-origin-when-cross-origin'),
  permissionsPolicy: Joi.object().pattern(
    Joi.string(),
    Joi.array().items(Joi.string())
  ).optional(),
});

const securitySchema = Joi.object({
  ipFilter: ipFilterSchema.optional(),
  rateLimiter: securityRateLimiterSchema.optional(),
  requestValidator: requestValidatorSchema.optional(),
  headers: securityHeadersSchema.optional(),
});

// Logging configuration schema
const loggingSchema = Joi.object({
  level: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  transports: Joi.array().items(Joi.object({
    type: Joi.string().valid('console', 'file').required(),
    level: Joi.string().valid('error', 'warn', 'info', 'debug').optional(),
    options: Joi.object().optional(),
  })).min(1).optional(),
  defaultContext: Joi.object().optional(),
  enableStackTrace: Joi.boolean().default(true),
  maskSensitiveData: Joi.boolean().default(true),
  sensitiveFields: Joi.array().items(Joi.string()).optional(),
});

// Redis store configuration schema
const redisStoreSchema = Joi.object({
  host: Joi.string().hostname().default('localhost'),
  port: Joi.number().integer().min(1).max(65535).default(6379),
  password: Joi.string().optional(),
  db: Joi.number().integer().min(0).default(0),
  keyPrefix: Joi.string().default('flow-control:'),
  maxRetriesPerRequest: Joi.number().integer().min(0).default(3),
  enableOfflineQueue: Joi.boolean().default(true),

  // Cluster configuration
  cluster: Joi.object({
    enabledNodes: Joi.array().items(serverSchema.keys({
      weight: Joi.forbidden(),
      maxConnections: Joi.forbidden(),
    })).min(1).optional(),
    enableReadyCheck: Joi.boolean().default(true),
    maxRedirections: Joi.number().integer().min(1).default(16),
    retryDelayOnFailover: Joi.number().integer().min(0).default(100),
    maxRetriesPerRequest: Joi.number().integer().min(0).default(3),
  }).optional(),

  // Sentinel configuration
  sentinel: Joi.object({
    sentinels: Joi.array().items(serverSchema.keys({
      weight: Joi.forbidden(),
      maxConnections: Joi.forbidden(),
    })).min(1).required(),
    name: Joi.string().required(),
    password: Joi.string().optional(),
    db: Joi.number().integer().min(0).default(0),
  }).optional(),
});

// Observability configuration schema
const observabilitySchema = Joi.object({
  metrics: Joi.object({
    enabled: Joi.boolean().default(true),
    prometheus: Joi.object({
      enabled: Joi.boolean().default(true),
      endpoint: Joi.string().default('/metrics'),
      prefix: Joi.string().default('flow_control_'),
      registry: Joi.any().optional(), // Allow custom registry for testing
      collectDefaultMetrics: Joi.boolean().optional(), // Allow disabling default metrics
    }).optional(),
    collector: Joi.object({
      enabled: Joi.boolean().default(true),
      collectInterval: Joi.number().integer().min(1000).default(5000),
      bufferSize: Joi.number().integer().min(10).default(1000),
    }).optional(),
  }).optional(),
  tracing: Joi.object({
    enabled: Joi.boolean().default(false),
    serviceName: Joi.string().default('flow-control'),
    serviceVersion: Joi.string().optional(),
    jaeger: Joi.object({
      endpoint: Joi.string().uri().optional(),
      agentHost: Joi.string().hostname().default('localhost'),
      agentPort: Joi.number().integer().min(1).max(65535).default(6832),
    }).optional(),
    sampling: Joi.object({
      ratio: Joi.number().min(0).max(1).default(0.1),
    }).optional(),
  }).optional(),
  healthCheck: Joi.object({
    enabled: Joi.boolean().default(false),
    endpoint: Joi.string().default('/health'),
    checkInterval: Joi.number().integer().min(1000).default(30000),
    aggregation: Joi.boolean().default(false),
  }).optional(),
  performance: Joi.object({
    enabled: Joi.boolean().default(false),
    monitoring: Joi.boolean().default(true),
    collectInterval: Joi.number().integer().min(1000).default(5000),
    thresholds: Joi.object({
      memory: Joi.object({
        warning: Joi.number().min(0).max(1).default(0.8),
        critical: Joi.number().min(0).max(1).default(0.9),
      }).optional(),
      cpu: Joi.object({
        warning: Joi.number().min(0).max(100).default(80),
        critical: Joi.number().min(0).max(100).default(90),
      }).optional(),
      latency: Joi.object({
        warning: Joi.number().min(0).default(1000),
        critical: Joi.number().min(0).default(2000),
      }).optional(),
    }).optional(),
  }).optional(),
  gracefulShutdown: Joi.object({
    enabled: Joi.boolean().default(false),
    gracefulTimeoutMs: Joi.number().integer().min(1000).default(30000),
    forceExitTimeoutMs: Joi.number().integer().min(1000).default(10000),
  }).optional(),
}).optional();

// Main FlowControl configuration schema
export const flowControlConfigSchema = Joi.object({
  rateLimiter: rateLimiterSchema.optional(),
  loadBalancer: loadBalancerSchema.optional(),
  security: securitySchema.optional(),
  logging: loggingSchema.optional(),
  store: Joi.object({
    type: Joi.string().valid('memory', 'redis').default('memory'),
    redis: redisStoreSchema.optional(),
  }).optional(),
  observability: observabilitySchema,
}).or('rateLimiter', 'loadBalancer').messages({
  'object.missing': 'At least one of rateLimiter or loadBalancer must be configured',
});

// Validation function
export function validateFlowControlConfig(config: any): {
  value: FlowControlConfig;
  error?: Joi.ValidationError
} {
  const { error, value } = flowControlConfigSchema.validate(config, {
    abortEarly: false,
    allowUnknown: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    return { error, value: config };
  }

  return { value };
}

// Export individual schemas for testing
export {
  serverSchema,
  healthCheckSchema,
  circuitBreakerSchema,
  rateLimiterSchema,
  loadBalancerSchema,
  securitySchema,
  loggingSchema,
  redisStoreSchema,
  observabilitySchema,
};