import type { Request, Response, NextFunction } from 'express';
import { StructuredLogger, type LogContext } from './structured-logger.js';
import { randomUUID } from 'crypto';

export interface LoggingMiddlewareConfig {
  logger?: StructuredLogger;
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  includeHeaders?: boolean;
  excludeHeaders?: string[];
  includeQuery?: boolean;
  includeParams?: boolean;
  logRequests?: boolean;
  logResponses?: boolean;
  logErrors?: boolean;
  logLevel?: 'info' | 'debug';
  generateRequestId?: boolean;
  requestIdHeader?: string;
  maxBodySize?: number;
  skipPaths?: (string | RegExp)[];
  skipUserAgents?: (string | RegExp)[];
  customFields?: (req: Request, res: Response) => Record<string, any>;
  sanitizeHeaders?: (headers: Record<string, any>) => Record<string, any>;
  sanitizeBody?: (body: any) => any;
}

export interface RequestContext {
  requestId: string;
  startTime: number;
  method: string;
  url: string;
  path: string;
  query?: Record<string, any>;
  params?: Record<string, any>;
  headers?: Record<string, any>;
  body?: any;
  userAgent?: string;
  ip?: string;
  userId?: string;
  sessionId?: string;
}

export interface ResponseContext {
  statusCode: number;
  headers?: Record<string, any>;
  body?: any;
  size?: number;
  duration: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
    startTime?: number;
    logger?: StructuredLogger;
  }
}

export class LoggingMiddleware {
  private config: {
    includeRequestBody: boolean;
    includeResponseBody: boolean;
    includeHeaders: boolean;
    excludeHeaders: string[];
    includeQuery: boolean;
    includeParams: boolean;
    logRequests: boolean;
    logResponses: boolean;
    logErrors: boolean;
    logLevel: 'info' | 'debug';
    generateRequestId: boolean;
    requestIdHeader: string;
    maxBodySize: number;
    skipPaths: (string | RegExp)[];
    skipUserAgents: (string | RegExp)[];
    logger: StructuredLogger;
    customFields?: (req: Request, res: Response) => Record<string, any>;
    sanitizeHeaders?: (headers: Record<string, any>) => Record<string, any>;
    sanitizeBody?: (body: any) => any;
  };

  constructor(config: LoggingMiddlewareConfig = {}) {
    this.config = {
      logger: config.logger ?? new StructuredLogger(),
      includeRequestBody: config.includeRequestBody ?? false,
      includeResponseBody: config.includeResponseBody ?? false,
      includeHeaders: config.includeHeaders ?? true,
      excludeHeaders: config.excludeHeaders ?? [
        'authorization', 'cookie', 'set-cookie', 'x-api-key',
        'x-auth-token', 'x-access-token', 'x-refresh-token'
      ],
      includeQuery: config.includeQuery ?? true,
      includeParams: config.includeParams ?? true,
      logRequests: config.logRequests ?? true,
      logResponses: config.logResponses ?? true,
      logErrors: config.logErrors ?? true,
      logLevel: config.logLevel ?? 'info',
      generateRequestId: config.generateRequestId ?? true,
      requestIdHeader: config.requestIdHeader ?? 'x-request-id',
      maxBodySize: config.maxBodySize ?? 10240, // 10KB
      skipPaths: config.skipPaths ?? ['/health', '/metrics', '/favicon.ico'],
      skipUserAgents: config.skipUserAgents ?? [/^kube-probe/, /^ELB-HealthChecker/],
    };

    if (config.customFields) {
      this.config.customFields = config.customFields;
    }
    if (config.sanitizeHeaders) {
      this.config.sanitizeHeaders = config.sanitizeHeaders;
    }
    if (config.sanitizeBody) {
      this.config.sanitizeBody = config.sanitizeBody;
    }
  }

  getMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (this.shouldSkip(req)) {
        return next();
      }

      this.setupRequest(req);
      this.logRequest(req);
      this.setupResponse(req, res);

      next();
    };
  }

  private shouldSkip(req: Request): boolean {
    // Check skip paths
    for (const skipPath of this.config.skipPaths) {
      if (typeof skipPath === 'string') {
        if (req.path === skipPath) {
          return true;
        }
      } else if (skipPath instanceof RegExp) {
        if (skipPath.test(req.path)) {
          return true;
        }
      }
    }

    // Check skip user agents
    const userAgent = req.headers['user-agent'];
    if (userAgent) {
      for (const skipUA of this.config.skipUserAgents) {
        if (typeof skipUA === 'string') {
          if (userAgent.includes(skipUA)) {
            return true;
          }
        } else if (skipUA instanceof RegExp) {
          if (skipUA.test(userAgent)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private setupRequest(req: Request): void {
    // Generate or extract request ID
    if (this.config.generateRequestId) {
      req.requestId = req.headers[this.config.requestIdHeader] as string || randomUUID();
    }

    req.startTime = Date.now();

    // Create request-scoped logger
    const context: LogContext = {
      component: 'http-middleware',
    };

    if (req.requestId) {
      context.requestId = req.requestId;
    }

    req.logger = this.config.logger.child(context);
  }

  private logRequest(req: Request): void {
    if (!this.config.logRequests) {
      return;
    }

    const requestContext = this.buildRequestContext(req);
    const logData: any = {
      type: 'request',
      ...requestContext,
    };

    if (this.config.customFields) {
      try {
        const customData = this.config.customFields(req, {} as Response);
        Object.assign(logData, customData);
      } catch (error) {
        this.config.logger.warn('Failed to extract custom fields for request', { error });
      }
    }

    const message = `${req.method} ${req.path}`;

    if (this.config.logLevel === 'debug') {
      req.logger?.debug(message, logData);
    } else {
      req.logger?.info(message, logData);
    }
  }

  private setupResponse(req: Request, res: Response): void {
    const originalSend = res.send;
    const originalJson = res.json;

    let responseBody: any;

    // Intercept response body
    if (this.config.includeResponseBody) {
      res.send = function(body) {
        responseBody = body;
        return originalSend.call(this, body);
      };

      res.json = function(obj) {
        responseBody = obj;
        return originalJson.call(this, obj);
      };
    }

    // Log response when finished
    const logResponse = () => {
      if (this.config.logResponses) {
        const responseContext = this.buildResponseContext(res, responseBody, req.startTime!);
        this.logResponse(req, res, responseContext);
      }
    };

    // Handle response completion
    res.on('finish', logResponse);
    res.on('close', () => {
      if (!res.headersSent) {
        logResponse();
      }
    });

    // Handle errors on response end
    res.on('finish', () => {
      if (res.statusCode >= 400 && req.logger) {
        const errorContext = {
          statusCode: res.statusCode,
          path: req.path,
          method: req.method,
          duration: Date.now() - req.startTime!,
        };

        if (req.logger && res.statusCode >= 500) {
          req.logger.error(`HTTP Error ${res.statusCode}`, errorContext);
        } else if (req.logger) {
          req.logger.warn(`HTTP Client Error ${res.statusCode}`, errorContext);
        }
      }
    });
  }

  private buildRequestContext(req: Request): RequestContext {
    const context: RequestContext = {
      requestId: req.requestId!,
      startTime: req.startTime!,
      method: req.method,
      url: req.url,
      path: req.path,
    };

    const clientIP = req.ip || req.socket.remoteAddress;
    if (clientIP) {
      context.ip = clientIP;
    }

    const userAgent = req.headers['user-agent'];
    if (userAgent && typeof userAgent === 'string') {
      context.userAgent = userAgent;
    }

    if (this.config.includeQuery && Object.keys(req.query).length > 0) {
      context.query = req.query as Record<string, any>;
    }

    if (this.config.includeParams && Object.keys(req.params).length > 0) {
      context.params = req.params;
    }

    if (this.config.includeHeaders) {
      context.headers = this.sanitizeHeaders(req.headers);
    }

    if (this.config.includeRequestBody && req.body) {
      context.body = this.sanitizeBody(req.body);
    }

    return context;
  }

  private buildResponseContext(res: Response, body: any, startTime: number): ResponseContext {
    const context: ResponseContext = {
      statusCode: res.statusCode,
      duration: Date.now() - startTime,
    };

    if (this.config.includeHeaders) {
      const headers: Record<string, any> = {};
      res.getHeaderNames().forEach(name => {
        headers[name] = res.getHeader(name);
      });
      context.headers = this.sanitizeHeaders(headers);
    }

    if (this.config.includeResponseBody && body !== undefined) {
      context.body = this.sanitizeBody(body);
    }

    // Calculate response size if possible
    const contentLength = res.getHeader('content-length');
    if (contentLength) {
      context.size = parseInt(contentLength as string, 10);
    }

    return context;
  }

  private logResponse(req: Request, res: Response, responseContext: ResponseContext): void {
    const logData: any = {
      type: 'response',
      requestId: req.requestId,
      ...responseContext,
    };

    if (this.config.customFields) {
      try {
        const customData = this.config.customFields(req, res);
        Object.assign(logData, customData);
      } catch (error) {
        this.config.logger.warn('Failed to extract custom fields for response', { error });
      }
    }

    const message = `${req.method} ${req.path} ${res.statusCode} - ${responseContext.duration}ms`;

    if (res.statusCode >= 500) {
      req.logger?.error(message, logData);
    } else if (res.statusCode >= 400) {
      req.logger?.warn(message, logData);
    } else if (this.config.logLevel === 'debug') {
      req.logger?.debug(message, logData);
    } else {
      req.logger?.info(message, logData);
    }
  }

  private sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
    if (this.config.sanitizeHeaders) {
      return this.config.sanitizeHeaders(headers);
    }

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (this.config.excludeHeaders.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private sanitizeBody(body: any): any {
    if (this.config.sanitizeBody) {
      return this.config.sanitizeBody(body);
    }

    if (!body) {
      return body;
    }

    // Limit body size
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > this.config.maxBodySize) {
      return `[TRUNCATED - Size: ${bodyStr.length} bytes]`;
    }

    return body;
  }

  updateConfig(newConfig: Partial<LoggingMiddlewareConfig>): void {
    Object.assign(this.config, newConfig);
  }

  getConfig(): LoggingMiddlewareConfig {
    const config: LoggingMiddlewareConfig = {
      logger: this.config.logger,
      includeRequestBody: this.config.includeRequestBody,
      includeResponseBody: this.config.includeResponseBody,
      includeHeaders: this.config.includeHeaders,
      excludeHeaders: [...this.config.excludeHeaders],
      includeQuery: this.config.includeQuery,
      includeParams: this.config.includeParams,
      logRequests: this.config.logRequests,
      logResponses: this.config.logResponses,
      logErrors: this.config.logErrors,
      logLevel: this.config.logLevel,
      generateRequestId: this.config.generateRequestId,
      requestIdHeader: this.config.requestIdHeader,
      maxBodySize: this.config.maxBodySize,
      skipPaths: [...this.config.skipPaths],
      skipUserAgents: [...this.config.skipUserAgents],
    };

    if (this.config.customFields) {
      config.customFields = this.config.customFields;
    }
    if (this.config.sanitizeHeaders) {
      config.sanitizeHeaders = this.config.sanitizeHeaders;
    }
    if (this.config.sanitizeBody) {
      config.sanitizeBody = this.config.sanitizeBody;
    }

    return config;
  }

  getStats(): {
    requestsLogged: number;
    responsesLogged: number;
    errorsLogged: number;
    skipPathsCount: number;
    skipUserAgentsCount: number;
  } {
    return {
      requestsLogged: 0, // These would be tracked in a real implementation
      responsesLogged: 0,
      errorsLogged: 0,
      skipPathsCount: this.config.skipPaths.length,
      skipUserAgentsCount: this.config.skipUserAgents.length,
    };
  }
}