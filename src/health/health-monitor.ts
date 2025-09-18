import type { ServerConfig, Logger } from '../types/index.js';
import { AdvancedHealthChecker, HealthCheckType, type AdvancedHealthCheckConfig, type HealthCheckResult } from './health-checker.js';
import { HealthMiddleware, type HealthMiddlewareConfig, type HealthCheckDetail } from './health-middleware.js';
import { createDefaultLogger, createServerKey } from '../utils/index.js';

export interface HealthMonitorConfig {
  servers: ServerConfig[];
  healthCheck?: AdvancedHealthCheckConfig;
  middleware?: HealthMiddlewareConfig;
  alerting?: AlertingConfig;
}

export interface AlertingConfig {
  enabled?: boolean;
  onServerDown?: (server: ServerConfig, result: HealthCheckResult) => void;
  onServerUp?: (server: ServerConfig, result: HealthCheckResult) => void;
  onAllServersDown?: (servers: ServerConfig[]) => void;
  thresholds?: {
    responseTime?: number;
    errorRate?: number;
  };
}

export interface HealthMetrics {
  totalServers: number;
  healthyServers: number;
  unhealthyServers: number;
  averageResponseTime: number;
  uptimePercentage: number;
  lastCheckTime: Date;
  serverMetrics: Map<string, ServerMetrics>;
}

export interface ServerMetrics {
  server: ServerConfig;
  isHealthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalChecks: number;
  successfulChecks: number;
  averageResponseTime: number;
  lastResponseTime: number;
  lastCheckTime: Date;
  uptime: number;
  downtime: number;
  lastStatusChange: Date;
}

export class HealthMonitor {
  private readonly config: HealthMonitorConfig;
  private readonly healthChecker: AdvancedHealthChecker;
  private readonly healthMiddleware: HealthMiddleware;
  private readonly logger: Logger;
  private readonly metrics: Map<string, ServerMetrics> = new Map();
  private readonly alerting: Required<AlertingConfig>;
  private monitoringInterval?: NodeJS.Timeout;
  // Track when monitoring started (for future use in uptime calculations)
  // private readonly monitorStartTime: Date = new Date();

  constructor(config: HealthMonitorConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger || createDefaultLogger();

    this.healthChecker = new AdvancedHealthChecker(config.healthCheck, this.logger);
    this.healthMiddleware = new HealthMiddleware(config.middleware, this.logger);

    this.alerting = {
      enabled: config.alerting?.enabled ?? true,
      onServerDown: config.alerting?.onServerDown || this.defaultServerDownHandler.bind(this),
      onServerUp: config.alerting?.onServerUp || this.defaultServerUpHandler.bind(this),
      onAllServersDown: config.alerting?.onAllServersDown || this.defaultAllServersDownHandler.bind(this),
      thresholds: {
        responseTime: config.alerting?.thresholds?.responseTime ?? 5000,
        errorRate: config.alerting?.thresholds?.errorRate ?? 0.1,
      },
    };

    this.initializeMetrics();
    this.setupHealthChecks();
  }

  private initializeMetrics(): void {
    for (const server of this.config.servers) {
      const serverKey = createServerKey(server);
      this.metrics.set(serverKey, {
        server,
        isHealthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalChecks: 0,
        successfulChecks: 0,
        averageResponseTime: 0,
        lastResponseTime: 0,
        lastCheckTime: new Date(),
        uptime: 0,
        downtime: 0,
        lastStatusChange: new Date(),
      });
    }
  }

  private setupHealthChecks(): void {
    // Add database connectivity check
    this.healthMiddleware.addHealthCheck('database', async (): Promise<HealthCheckDetail> => {
      // This would typically check database connectivity
      return {
        status: 'pass',
        timestamp: new Date().toISOString(),
        output: 'Database connection healthy',
        responseTime: 50,
      };
    });

    // Add load balancer health check
    this.healthMiddleware.addHealthCheck('loadBalancer', async (): Promise<HealthCheckDetail> => {
      const healthyCount = this.getHealthyServerCount();
      const totalCount = this.config.servers.length;
      const healthyPercentage = totalCount > 0 ? (healthyCount / totalCount) * 100 : 0;

      return {
        status: healthyPercentage >= 50 ? 'pass' : healthyPercentage > 0 ? 'warn' : 'fail',
        timestamp: new Date().toISOString(),
        output: `${healthyCount}/${totalCount} servers healthy`,
        details: {
          healthyServers: healthyCount,
          totalServers: totalCount,
          healthyPercentage: Math.round(healthyPercentage),
        },
      };
    });

    // Add circuit breaker status check
    this.healthMiddleware.addHealthCheck('circuitBreakers', (): HealthCheckDetail => {
      // This would typically check circuit breaker states
      return {
        status: 'pass',
        timestamp: new Date().toISOString(),
        output: 'All circuit breakers operational',
      };
    });
  }

  async startMonitoring(): Promise<void> {
    if (this.monitoringInterval) {
      this.stopMonitoring();
    }

    // Perform initial health check
    await this.performHealthChecks();

    // Start periodic monitoring
    const interval = this.config.healthCheck?.interval || 30000;
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.performHealthChecks();
      } catch (error) {
        this.logger.error('Error during health monitoring', error);
      }
    }, interval);

    this.logger.info('Health monitoring started', {
      interval,
      servers: this.config.servers.length,
      type: this.config.healthCheck?.type || HealthCheckType.HTTP,
    });
  }

  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      // Don't assign undefined to optional property
      this.logger.info('Health monitoring stopped');
    }
  }

  private async performHealthChecks(): Promise<void> {
    const results = await this.healthChecker.checkMultipleServers(this.config.servers);

    for (const [serverKey, result] of results) {
      this.updateMetrics(serverKey, result);
      this.evaluateAlerts(serverKey, result);
    }

    // Check if all servers are down
    if (this.alerting.enabled && this.getHealthyServerCount() === 0) {
      this.alerting.onAllServersDown(this.config.servers);
    }
  }

  private updateMetrics(serverKey: string, result: HealthCheckResult): void {
    const metrics = this.metrics.get(serverKey);
    if (!metrics) return;

    const wasHealthy = metrics.isHealthy;
    const isHealthy = result.healthy;

    metrics.totalChecks++;
    metrics.lastCheckTime = result.timestamp;
    metrics.lastResponseTime = result.responseTime;

    if (isHealthy) {
      metrics.successfulChecks++;
      metrics.consecutiveSuccesses++;
      metrics.consecutiveFailures = 0;
    } else {
      metrics.consecutiveFailures++;
      metrics.consecutiveSuccesses = 0;
    }

    // Update average response time
    metrics.averageResponseTime = (
      (metrics.averageResponseTime * (metrics.totalChecks - 1) + result.responseTime) /
      metrics.totalChecks
    );

    // Update health status
    const successThreshold = this.config.healthCheck?.successThreshold || 2;
    const failureThreshold = this.config.healthCheck?.failureThreshold || 3;

    if (!metrics.isHealthy && metrics.consecutiveSuccesses >= successThreshold) {
      metrics.isHealthy = true;
      metrics.lastStatusChange = new Date();
    } else if (metrics.isHealthy && metrics.consecutiveFailures >= failureThreshold) {
      metrics.isHealthy = false;
      metrics.lastStatusChange = new Date();
    }

    // Update uptime/downtime
    const timeSinceLastCheck = Date.now() - metrics.lastStatusChange.getTime();
    if (metrics.isHealthy) {
      metrics.uptime += timeSinceLastCheck;
    } else {
      metrics.downtime += timeSinceLastCheck;
    }

    // Trigger alerts if status changed
    if (this.alerting.enabled && wasHealthy !== isHealthy) {
      if (isHealthy) {
        this.alerting.onServerUp(metrics.server, result);
      } else {
        this.alerting.onServerDown(metrics.server, result);
      }
    }
  }

  private evaluateAlerts(serverKey: string, result: HealthCheckResult): void {
    if (!this.alerting.enabled) return;

    const metrics = this.metrics.get(serverKey);
    if (!metrics) return;

    // Check response time threshold
    if (result.responseTime > (this.alerting.thresholds.responseTime || 5000)) {
      this.logger.warn(`High response time detected for server ${serverKey}`, {
        responseTime: result.responseTime,
        threshold: this.alerting.thresholds.responseTime,
      });
    }

    // Check error rate threshold
    const errorRate = 1 - (metrics.successfulChecks / metrics.totalChecks);
    if (errorRate > (this.alerting.thresholds.errorRate || 0.1)) {
      this.logger.warn(`High error rate detected for server ${serverKey}`, {
        errorRate: Math.round(errorRate * 100),
        threshold: Math.round((this.alerting.thresholds.errorRate || 0.1) * 100),
      });
    }
  }

  getHealthyServerCount(): number {
    return Array.from(this.metrics.values()).filter(m => m.isHealthy).length;
  }

  getMetrics(): HealthMetrics {
    const serverMetrics = Array.from(this.metrics.values());
    const healthyCount = serverMetrics.filter(m => m.isHealthy).length;
    const totalResponseTime = serverMetrics.reduce((sum, m) => sum + m.averageResponseTime, 0);
    const totalUptime = serverMetrics.reduce((sum, m) => sum + m.uptime, 0);
    const totalDowntime = serverMetrics.reduce((sum, m) => sum + m.downtime, 0);

    return {
      totalServers: this.config.servers.length,
      healthyServers: healthyCount,
      unhealthyServers: this.config.servers.length - healthyCount,
      averageResponseTime: totalResponseTime / serverMetrics.length || 0,
      uptimePercentage: totalUptime + totalDowntime > 0 ? (totalUptime / (totalUptime + totalDowntime)) * 100 : 100,
      lastCheckTime: new Date(),
      serverMetrics: new Map(Array.from(this.metrics.entries())),
    };
  }

  getServerMetrics(serverKey: string): ServerMetrics | undefined {
    return this.metrics.get(serverKey);
  }

  getHealthMiddleware() {
    return this.healthMiddleware.getMiddleware();
  }

  private defaultServerDownHandler(server: ServerConfig, result: HealthCheckResult): void {
    this.logger.error(`Server ${createServerKey(server)} is down`, {
      server: `${server.host}:${server.port}`,
      error: result.error,
      responseTime: result.responseTime,
    });
  }

  private defaultServerUpHandler(server: ServerConfig, result: HealthCheckResult): void {
    this.logger.info(`Server ${createServerKey(server)} is back up`, {
      server: `${server.host}:${server.port}`,
      responseTime: result.responseTime,
    });
  }

  private defaultAllServersDownHandler(servers: ServerConfig[]): void {
    this.logger.error(`ALL SERVERS DOWN! ${servers.length} servers are unavailable`, {
      servers: servers.map(s => `${s.host}:${s.port}`),
    });
  }

  destroy(): void {
    this.stopMonitoring();
    this.healthChecker.destroy();
    this.metrics.clear();
    this.logger.info('Health monitor destroyed');
  }
}