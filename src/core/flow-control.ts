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
import { createDefaultLogger } from '../utils/index.js';
import { validateFlowControlConfig, ConfigValidationError } from '../validation/index.js';

export class FlowControl {
  private readonly config: FlowControlConfig;
  private readonly logger: Logger;
  private rateLimiter?: FixedWindowRateLimiter;
  private loadBalancer?: RoundRobinLoadBalancer;
  private middleware?: FlowControlMiddleware;

  private constructor(config: FlowControlConfig, logger?: Logger) {
    this.config = this.validateConfiguration(config);
    this.logger = logger || createDefaultLogger();
    this.middleware = this.createMiddleware();
  }

  static async create(config: FlowControlConfig, logger?: Logger): Promise<FlowControl> {
    const instance = new FlowControl(config, logger);
    await instance.initializeComponents();

    instance.logger.info('FlowControl initialized', {
      rateLimiterEnabled: !!instance.rateLimiter,
      loadBalancerEnabled: !!instance.loadBalancer,
      serverCount: instance.config.loadBalancer?.servers?.length || 0,
    });

    return instance;
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

  async destroy(): Promise<void> {
    this.logger.info('Destroying FlowControl instance');

    const destroyPromises: Promise<void>[] = [];

    if (this.rateLimiter) {
      destroyPromises.push(this.rateLimiter.destroy());
    }

    if (this.loadBalancer) {
      destroyPromises.push(Promise.resolve(this.loadBalancer.destroy()));
    }

    await Promise.allSettled(destroyPromises);
  }

  private validateConfiguration(config: FlowControlConfig): FlowControlConfig {
    const { error, value } = validateFlowControlConfig(config);

    if (error) {
      const validationError = new ConfigValidationError(
        'Configuration validation failed',
        error
      );
      throw new FlowControlError(
        validationError.getFormattedMessage(),
        'INVALID_CONFIG'
      );
    }

    return value;
  }

  private async initializeComponents(): Promise<void> {
    if (this.config.rateLimiter) {
      this.logger.debug('Initializing rate limiter');
      this.rateLimiter = await FixedWindowRateLimiter.create(this.config.rateLimiter, this.logger);
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