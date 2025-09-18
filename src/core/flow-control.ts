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
import { PrometheusExporter, MetricsCollector } from '../metrics/index.js';
import { OpenTelemetryTracer, SpanMiddleware } from '../telemetry/index.js';
import { ShutdownManager } from '../lifecycle/index.js';
import { HealthAggregator, PerformanceMonitor } from '../monitoring/index.js';

export class FlowControl {
  private readonly config: FlowControlConfig;
  private readonly logger: Logger;
  private rateLimiter?: FixedWindowRateLimiter;
  private loadBalancer?: RoundRobinLoadBalancer;
  private middleware?: FlowControlMiddleware;

  // Phase 3 Observability Components
  private prometheusExporter?: PrometheusExporter;
  private metricsCollector?: MetricsCollector;
  private openTelemetryTracer?: OpenTelemetryTracer;
  private spanMiddleware?: SpanMiddleware;
  private shutdownManager?: ShutdownManager;
  private healthAggregator?: HealthAggregator;
  private performanceMonitor?: PerformanceMonitor;

  private constructor(config: FlowControlConfig, logger?: Logger) {
    this.config = this.validateConfiguration(config);
    this.logger = logger || createDefaultLogger();
    this.middleware = this.createMiddleware();
  }

  static async create(config: FlowControlConfig, logger?: Logger): Promise<FlowControl> {
    const instance = new FlowControl(config, logger);
    await instance.initializeComponents();
    await instance.initializeObservability();

    instance.logger.info('FlowControl initialized', {
      rateLimiterEnabled: !!instance.rateLimiter,
      loadBalancerEnabled: !!instance.loadBalancer,
      serverCount: instance.config.loadBalancer?.servers?.length || 0,
      observabilityEnabled: !!instance.config.observability,
      metricsEnabled: !!instance.prometheusExporter,
      tracingEnabled: !!instance.openTelemetryTracer,
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

  getLogger(): Logger {
    return this.logger;
  }

  // Phase 3 Observability Getters
  getPrometheusExporter(): PrometheusExporter | undefined {
    return this.prometheusExporter;
  }

  getMetricsCollector(): MetricsCollector | undefined {
    return this.metricsCollector;
  }

  getOpenTelemetryTracer(): OpenTelemetryTracer | undefined {
    return this.openTelemetryTracer;
  }

  getShutdownManager(): ShutdownManager | undefined {
    return this.shutdownManager;
  }

  getHealthAggregator(): HealthAggregator | undefined {
    return this.healthAggregator;
  }

  getPerformanceMonitor(): PerformanceMonitor | undefined {
    return this.performanceMonitor;
  }

  getStats(): any {
    const stats: any = {
      rateLimiter: this.rateLimiter ? { enabled: true } : { enabled: false },
      loadBalancer: this.loadBalancer
        ? { enabled: true, ...this.loadBalancer.getStats() }
        : { enabled: false },
      observability: {
        metrics: !!this.prometheusExporter,
        tracing: !!this.openTelemetryTracer,
        healthAggregation: !!this.healthAggregator,
        performanceMonitoring: !!this.performanceMonitor,
      },
    };

    // Add performance metrics if available
    if (this.performanceMonitor) {
      const perfSummary = this.performanceMonitor.getPerformanceSummary();
      stats.performance = {
        current: perfSummary.current,
        trends: perfSummary.trends,
        alertCount: perfSummary.recentAlerts.length,
      };
    }

    // Add health status if available
    if (this.healthAggregator) {
      const health = this.healthAggregator.getAggregatedHealth();
      stats.health = {
        status: health.status,
        uptime: health.uptime,
        dependencyCount: health.metrics.totalDependencies,
        healthyDependencies: health.metrics.healthyDependencies,
        serverCount: health.metrics.totalServers,
        healthyServers: health.metrics.healthyServers,
      };
    }

    return stats;
  }

  async destroy(): Promise<void> {
    this.logger.info('Destroying FlowControl instance');

    // Use shutdown manager if available for graceful shutdown
    if (this.shutdownManager) {
      await this.shutdownManager.initiateShutdown();
      return;
    }

    // Fallback to manual destruction
    const destroyPromises: Promise<void>[] = [];

    if (this.rateLimiter) {
      destroyPromises.push(this.rateLimiter.destroy());
    }

    if (this.loadBalancer) {
      destroyPromises.push(Promise.resolve(this.loadBalancer.destroy()));
    }

    // Destroy observability components
    if (this.metricsCollector) {
      destroyPromises.push(Promise.resolve(this.metricsCollector.destroy()));
    }

    if (this.prometheusExporter) {
      destroyPromises.push(Promise.resolve(this.prometheusExporter.destroy()));
    }

    if (this.openTelemetryTracer) {
      destroyPromises.push(this.openTelemetryTracer.destroy());
    }

    if (this.healthAggregator) {
      destroyPromises.push(Promise.resolve(this.healthAggregator.destroy()));
    }

    if (this.performanceMonitor) {
      destroyPromises.push(Promise.resolve(this.performanceMonitor.destroy()));
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

  private async initializeObservability(): Promise<void> {
    const observability = this.config.observability;
    if (!observability) {
      return;
    }

    this.logger.debug('Initializing observability components');

    // Initialize metrics components
    if (observability.metrics?.enabled !== false) {
      if (observability.metrics?.prometheus?.enabled !== false) {
        const prometheusConfig: any = {};
        if (observability.metrics?.prometheus?.prefix) {
          prometheusConfig.prefix = observability.metrics.prometheus.prefix;
        }
        if (observability.metrics?.prometheus && (observability.metrics.prometheus as any)?.registry) {
          prometheusConfig.registry = (observability.metrics.prometheus as any).registry;
        }
        if (observability.metrics?.prometheus && (observability.metrics.prometheus as any)?.collectDefaultMetrics !== undefined) {
          prometheusConfig.collectDefaultMetrics = (observability.metrics.prometheus as any).collectDefaultMetrics;
        }

        this.prometheusExporter = new PrometheusExporter(prometheusConfig, this.logger);
      }

      if (observability.metrics?.collector?.enabled !== false) {
        const collectorConfig: any = {};
        if (observability.metrics?.collector?.collectInterval) {
          collectorConfig.collectInterval = observability.metrics.collector.collectInterval;
        }
        if (observability.metrics?.collector?.bufferSize) {
          collectorConfig.bufferSize = observability.metrics.collector.bufferSize;
        }
        this.metricsCollector = new MetricsCollector(collectorConfig, this.logger);

        // Connect metrics collector to Prometheus exporter
        if (this.prometheusExporter) {
          this.metricsCollector.setPrometheusExporter(this.prometheusExporter);
        }
      }
    }

    // Initialize tracing components
    if (observability.tracing?.enabled !== false) {
      const tracingConfig: any = {
        serviceName: observability.tracing?.serviceName || 'flow-control',
      };
      if (observability.tracing?.serviceVersion) {
        tracingConfig.serviceVersion = observability.tracing.serviceVersion;
      }
      if (observability.tracing?.jaeger) {
        tracingConfig.jaeger = observability.tracing.jaeger;
      }
      if (observability.tracing?.sampling) {
        tracingConfig.sampling = observability.tracing.sampling;
      }
      this.openTelemetryTracer = new OpenTelemetryTracer(tracingConfig, this.logger);

      this.spanMiddleware = new SpanMiddleware(this.openTelemetryTracer, {}, this.logger);
    }

    // Initialize performance monitoring
    if (observability.performance?.enabled !== false) {
      const perfConfig: any = {
        enabled: observability.performance?.monitoring !== false,
      };
      if (observability.performance?.collectInterval) {
        perfConfig.collectInterval = observability.performance.collectInterval;
      }
      if (observability.performance?.thresholds?.memory) {
        perfConfig.memoryThresholds = observability.performance.thresholds.memory;
      }
      if (observability.performance?.thresholds?.cpu) {
        perfConfig.cpuThresholds = observability.performance.thresholds.cpu;
      }
      if (observability.performance?.thresholds?.latency) {
        perfConfig.latencyThresholds = observability.performance.thresholds.latency;
      }
      this.performanceMonitor = new PerformanceMonitor(perfConfig, this.logger);
    }

    // Initialize health aggregation
    if (observability.healthCheck?.enabled !== false && observability.healthCheck?.aggregation !== false) {
      const healthConfig: any = {};
      if (observability.healthCheck?.checkInterval) {
        healthConfig.checkInterval = observability.healthCheck.checkInterval;
      }
      this.healthAggregator = new HealthAggregator(healthConfig, this.logger);

      // Update health aggregator with server health if load balancer is available
      if (this.loadBalancer) {
        // TODO: Integrate with load balancer health checks
      }
    }

    // Initialize shutdown manager
    if (observability.gracefulShutdown?.enabled !== false) {
      const shutdownConfig: any = {};
      if (observability.gracefulShutdown?.gracefulTimeoutMs) {
        shutdownConfig.gracefulTimeoutMs = observability.gracefulShutdown.gracefulTimeoutMs;
      }
      if (observability.gracefulShutdown?.forceExitTimeoutMs) {
        shutdownConfig.forceExitTimeoutMs = observability.gracefulShutdown.forceExitTimeoutMs;
      }
      this.shutdownManager = new ShutdownManager(shutdownConfig, this.logger);

      // Register shutdown tasks for all components
      if (this.metricsCollector) {
        this.shutdownManager.addMetricsShutdown('metrics-collector', async () => {
          this.metricsCollector!.forceFlush();
          this.metricsCollector!.destroy();
        });
      }

      if (this.openTelemetryTracer) {
        this.shutdownManager.addTracingShutdown('opentelemetry', async () => {
          await this.openTelemetryTracer!.shutdown();
        });
      }

      if (this.healthAggregator) {
        this.shutdownManager.addShutdownTask({
          name: 'health-aggregator',
          priority: 300,
          task: () => this.healthAggregator!.destroy(),
        });
      }

      if (this.performanceMonitor) {
        this.shutdownManager.addShutdownTask({
          name: 'performance-monitor',
          priority: 350,
          task: () => this.performanceMonitor!.destroy(),
        });
      }
    }
  }

  private createMiddleware(): FlowControlMiddleware {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const startTime = Date.now();

      try {
        // Apply span middleware if tracing is enabled
        if (this.spanMiddleware) {
          const spanMiddleware = this.spanMiddleware.createMiddleware();
          spanMiddleware(req, res, () => {}); // Initialize tracing context
        }

        // Rate limiting
        if (this.rateLimiter) {
          const rateLimitStartTime = Date.now();
          const rateLimitResult = await this.rateLimiter.checkLimit(req);
          const rateLimitDuration = Date.now() - rateLimitStartTime;

          // Record metrics
          if (this.metricsCollector) {
            this.metricsCollector.recordRateLimiterRequest(rateLimitResult);
          }

          // Record timing for tracing
          if (this.spanMiddleware) {
            SpanMiddleware.recordRateLimiterTiming(req, rateLimitDuration);
            SpanMiddleware.recordRateLimitResult(
              req,
              rateLimitResult.allowed,
              rateLimitResult.info.remaining,
              rateLimitResult.info.limit
            );
          }

          if (!rateLimitResult.allowed) {
            this.rateLimiter.sendRateLimitResponse(res, rateLimitResult.info);

            // Record security event
            if (this.spanMiddleware) {
              SpanMiddleware.recordSecurityEvent(req, 'rate_limit_blocked', {
                limit: rateLimitResult.info.limit,
                remaining: rateLimitResult.info.remaining,
              });
            }

            // Record final HTTP metrics
            this.recordHttpMetrics(req, res, startTime, 429);
            return;
          }

          this.rateLimiter.setHeaders(res, rateLimitResult.info);
        }

        // Load balancing
        if (this.loadBalancer) {
          await this.handleLoadBalancedRequest(req, res, next, startTime);
        } else {
          // Record final HTTP metrics for non-load-balanced requests
          const originalSend = res.send;
          res.send = function(body: any) {
            const result = originalSend.call(this, body);
            // Record metrics after response is sent
            setImmediate(() => {
              const flowControl = (this as any).locals?.flowControl;
              if (flowControl) {
                flowControl.recordHttpMetrics(req, res, startTime, res.statusCode);
              }
            });
            return result;
          }.bind(res);

          // Store FlowControl instance for metrics recording
          res.locals = res.locals || {};
          res.locals.flowControl = this;

          next();
        }
      } catch (error) {
        this.logger.error('Middleware error', error);

        // Record error metrics
        if (this.metricsCollector) {
          this.metricsCollector.recordHttpRequest(
            req.method,
            req.path,
            500,
            Date.now() - startTime
          );
        }

        // Record exception in tracing
        if (this.openTelemetryTracer) {
          this.openTelemetryTracer.recordException(error instanceof Error ? error : new Error('Unknown error'));
        }

        if (!res.headersSent) {
          res.status(500).json({
            error: 'Internal server error',
            message: 'An unexpected error occurred',
          });
        }
      }
    };
  }

  private recordHttpMetrics(req: Request, res: Response, startTime: number, statusCode: number): void {
    const duration = Date.now() - startTime;

    if (this.metricsCollector) {
      this.metricsCollector.recordHttpRequest(
        req.method,
        req.path,
        statusCode,
        duration,
        parseInt(req.get('content-length') || '0'),
        parseInt(res.get('content-length') || '0')
      );
    }
  }

  private async handleLoadBalancedRequest(
    req: Request,
    res: Response,
    next: NextFunction,
    startTime: number,
  ): Promise<void> {
    const loadBalancerStartTime = Date.now();
    const selectedServer = this.loadBalancer!.getNextServer();
    const loadBalancerDuration = Date.now() - loadBalancerStartTime;

    if (!selectedServer) {
      throw new LoadBalancerError('No healthy servers available', 'NO_HEALTHY_SERVERS');
    }

    const targetUrl = `${selectedServer.protocol || 'http'}://${selectedServer.host}:${selectedServer.port}`;
    const serverKey = `${selectedServer.host}:${selectedServer.port}`;

    // Record load balancer timing
    if (this.spanMiddleware) {
      SpanMiddleware.recordLoadBalancerTiming(req, loadBalancerDuration, serverKey);
    }

    const proxyOptions: ProxyOptions = {
      target: targetUrl,
      changeOrigin: true,
      timeout: this.config.loadBalancer?.proxyTimeout || 30000,
      on: {
        error: (err: Error) => {
          const responseTime = Date.now() - startTime;
          const proxyDuration = Date.now() - loadBalancerStartTime;

          this.loadBalancer!.recordRequest(selectedServer, false, responseTime);

          // Record metrics
          if (this.metricsCollector) {
            this.metricsCollector.recordLoadBalancerRequest(
              selectedServer,
              req.method,
              500, // Error status
              responseTime,
              false
            );
          }

          // Record tracing data
          if (this.spanMiddleware) {
            SpanMiddleware.recordProxyTiming(req, proxyDuration, targetUrl);
          }

          // Record final HTTP metrics
          this.recordHttpMetrics(req, res, startTime, 500);

          this.logger.error('Proxy error', {
            server: targetUrl,
            error: err.message,
            responseTime,
          });
        },
        proxyRes: (proxyRes: any) => {
          const responseTime = Date.now() - startTime;
          const proxyDuration = Date.now() - loadBalancerStartTime;
          const success = proxyRes.statusCode ? proxyRes.statusCode < 500 : false;

          this.loadBalancer!.recordRequest(selectedServer, success, responseTime);

          // Record metrics
          if (this.metricsCollector) {
            this.metricsCollector.recordLoadBalancerRequest(
              selectedServer,
              req.method,
              proxyRes.statusCode || 500,
              responseTime,
              success
            );
          }

          // Record tracing data
          if (this.spanMiddleware) {
            SpanMiddleware.recordProxyTiming(req, proxyDuration, targetUrl);
          }

          // Record final HTTP metrics
          this.recordHttpMetrics(req, res, startTime, proxyRes.statusCode || 500);

          this.logger.debug('Proxy response', {
            server: targetUrl,
            statusCode: proxyRes.statusCode,
            responseTime,
            success,
          });
        },
      },
    };

    // Wrap proxy request in tracing span if enabled
    if (this.openTelemetryTracer) {
      await this.openTelemetryTracer.traceProxyRequest(
        targetUrl,
        req.method,
        async () => {
          const proxy = createProxyMiddleware(proxyOptions);
          proxy(req, res, next);
        }
      );
    } else {
      const proxy = createProxyMiddleware(proxyOptions);
      proxy(req, res, next);
    }
  }
}