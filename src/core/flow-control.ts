import type { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { Options as ProxyOptions } from 'http-proxy-middleware';
import type {
  FlowControlConfig,
  FlowControlMiddleware,
  Logger,
} from '../types/index.js';
import { FlowControlError, LoadBalancerError } from '../types/index.js';
import { FixedWindowRateLimiter } from '../rate-limiter/fixed-window.js';
import { RoundRobinLoadBalancer } from '../load-balancer/round-robin.js';
import { createDefaultLogger, validateConfig } from '../utils/index.js';

export class FlowControl {
  private readonly config: FlowControlConfig;
  private readonly logger: Logger;
  private rateLimiter?: FixedWindowRateLimiter;
  private loadBalancer?: RoundRobinLoadBalancer;
  private middleware?: FlowControlMiddleware;

  constructor(config: FlowControlConfig, logger?: Logger) {
    this.validateConfiguration(config);
    this.config = config;
    this.logger = logger || createDefaultLogger();

    this.initializeComponents();
    this.middleware = this.createMiddleware();

    this.logger.info('FlowControl initialized', {
      rateLimiterEnabled: !!this.rateLimiter,
      loadBalancerEnabled: !!this.loadBalancer,
      serverCount: this.config.loadBalancer?.servers?.length || 0,
    });
  }

  getMiddleware(): FlowControlMiddleware {
    if (!this.middleware) {
      throw new FlowControlError('Middleware not initialized', 'MIDDLEWARE_NOT_INITIALIZED');
    }
    return this.middleware;
  }

  getRateLimiter(): FixedWindowRateLimiter | undefined {
    return this.rateLimiter;
  }

  getLoadBalancer(): RoundRobinLoadBalancer | undefined {
    return this.loadBalancer;
  }

  getStats(): any {
    const stats: any = {
      rateLimiter: this.rateLimiter ? { enabled: true } : { enabled: false },
      loadBalancer: this.loadBalancer
        ? { enabled: true, ...this.loadBalancer.getStats() }
        : { enabled: false },
    };

    return stats;
  }

  destroy(): void {
    this.logger.info('Destroying FlowControl instance');

    if (this.rateLimiter) {
      this.rateLimiter.destroy();
    }

    if (this.loadBalancer) {
      this.loadBalancer.destroy();
    }
  }

  private validateConfiguration(config: FlowControlConfig): void {
    if (!config) {
      throw new FlowControlError('Configuration is required', 'INVALID_CONFIG');
    }

    if (!config.rateLimiter && !config.loadBalancer) {
      throw new FlowControlError(
        'At least one of rateLimiter or loadBalancer must be configured',
        'INVALID_CONFIG',
      );
    }

    if (config.rateLimiter) {
      validateConfig(config.rateLimiter, ['windowMs', 'maxRequests']);
      if (config.rateLimiter.windowMs <= 0) {
        throw new FlowControlError('windowMs must be positive', 'INVALID_CONFIG');
      }
      if (config.rateLimiter.maxRequests <= 0) {
        throw new FlowControlError('maxRequests must be positive', 'INVALID_CONFIG');
      }
    }

    if (config.loadBalancer) {
      validateConfig(config.loadBalancer, ['servers']);
      if (!Array.isArray(config.loadBalancer.servers) || config.loadBalancer.servers.length === 0) {
        throw new FlowControlError('servers array cannot be empty', 'INVALID_CONFIG');
      }

      for (const server of config.loadBalancer.servers) {
        validateConfig(server, ['host', 'port']);
        if (typeof server.port !== 'number' || server.port <= 0 || server.port > 65535) {
          throw new FlowControlError('Invalid server port', 'INVALID_CONFIG');
        }
      }
    }
  }

  private initializeComponents(): void {
    if (this.config.rateLimiter) {
      this.logger.debug('Initializing rate limiter');
      this.rateLimiter = new FixedWindowRateLimiter(this.config.rateLimiter, undefined, this.logger);
    }

    if (this.config.loadBalancer) {
      this.logger.debug('Initializing load balancer');
      this.loadBalancer = new RoundRobinLoadBalancer(
        this.config.loadBalancer.servers,
        this.config.loadBalancer.healthCheck,
        this.logger,
      );
    }
  }

  private createMiddleware(): FlowControlMiddleware {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const startTime = Date.now();

      try {
        if (this.rateLimiter) {
          const rateLimitResult = await this.rateLimiter.checkLimit(req);

          if (!rateLimitResult.allowed) {
            this.rateLimiter.sendRateLimitResponse(res, rateLimitResult.info);
            return;
          }

          this.rateLimiter.setHeaders(res, rateLimitResult.info);
        }

        if (this.loadBalancer) {
          await this.handleLoadBalancedRequest(req, res, next, startTime);
        } else {
          next();
        }
      } catch (error) {
        this.logger.error('Middleware error', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Internal server error',
            message: 'An unexpected error occurred',
          });
        }
      }
    };
  }

  private async handleLoadBalancedRequest(
    req: Request,
    res: Response,
    next: NextFunction,
    startTime: number,
  ): Promise<void> {
    const selectedServer = this.loadBalancer!.getNextServer();

    if (!selectedServer) {
      throw new LoadBalancerError('No healthy servers available', 'NO_HEALTHY_SERVERS');
    }

    const targetUrl = `${selectedServer.protocol || 'http'}://${selectedServer.host}:${selectedServer.port}`;

    const proxyOptions: ProxyOptions = {
      target: targetUrl,
      changeOrigin: true,
      timeout: this.config.loadBalancer?.proxyTimeout || 30000,
      on: {
        error: (err: Error) => {
          const responseTime = Date.now() - startTime;
          this.loadBalancer!.recordRequest(selectedServer, false, responseTime);
          this.logger.error('Proxy error', {
            server: targetUrl,
            error: err.message,
            responseTime,
          });
        },
        proxyRes: (proxyRes: any) => {
          const responseTime = Date.now() - startTime;
          const success = proxyRes.statusCode ? proxyRes.statusCode < 500 : false;
          this.loadBalancer!.recordRequest(selectedServer, success, responseTime);

          this.logger.debug('Proxy response', {
            server: targetUrl,
            statusCode: proxyRes.statusCode,
            responseTime,
            success,
          });
        },
      },
    };

    const proxy = createProxyMiddleware(proxyOptions);
    proxy(req, res, next);
  }
}