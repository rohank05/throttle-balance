import type {
  ServerConfig,
  ServerHealth,
  HealthCheckConfig,
  LoadBalancerStats,
  ServerStats,
  Logger,
} from '../types/index.js';
import { LoadBalancerError } from '../types/index.js';
import { createDefaultLogger, createServerKey } from '../utils/index.js';

export class RoundRobinLoadBalancer {
  private servers: ServerConfig[];
  private currentIndex: number = 0;
  private serverHealth: Map<string, ServerHealth> = new Map();
  private serverStats: Map<string, ServerStats> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;
  private readonly healthCheckConfig: Required<HealthCheckConfig>;
  private readonly logger: Logger;

  constructor(
    servers: ServerConfig[],
    healthCheckConfig?: HealthCheckConfig,
    logger?: Logger,
  ) {
    if (!servers || servers.length === 0) {
      throw new LoadBalancerError('At least one server must be configured');
    }

    this.servers = servers;
    this.logger = logger || createDefaultLogger();
    this.healthCheckConfig = this.createDefaultHealthCheckConfig(healthCheckConfig);

    this.initializeServers();

    if (this.healthCheckConfig.enabled) {
      this.startHealthChecks();
    }
  }

  getNextServer(): ServerConfig | null {
    const healthyServers = this.getHealthyServers();

    if (healthyServers.length === 0) {
      this.logger.warn('No healthy servers available');
      return null;
    }

    if (this.currentIndex >= healthyServers.length) {
      this.currentIndex = 0;
    }

    const selectedServer = healthyServers[this.currentIndex];
    if (!selectedServer) {
      return null;
    }

    this.currentIndex = (this.currentIndex + 1) % healthyServers.length;

    this.updateServerStats(selectedServer);
    this.logger.debug('Selected server for request', {
      server: `${selectedServer.host}:${selectedServer.port}`,
      index: this.currentIndex - 1,
    });

    return selectedServer;
  }

  getServerHealth(server: ServerConfig): ServerHealth | undefined {
    const key = createServerKey(server.host, server.port, server.protocol);
    return this.serverHealth.get(key);
  }

  getHealthyServers(): ServerConfig[] {
    return this.servers.filter((server) => {
      const health = this.getServerHealth(server);
      return health?.healthy !== false;
    });
  }

  getStats(): LoadBalancerStats {
    let totalRequests = 0;
    let totalErrors = 0;

    for (const stats of this.serverStats.values()) {
      totalRequests += stats.requests;
      totalErrors += stats.errors;
    }

    return {
      totalRequests,
      totalErrors,
      serverStats: new Map(this.serverStats),
    };
  }

  async checkServerHealth(server: ServerConfig): Promise<boolean> {
    const startTime = Date.now();
    const serverKey = createServerKey(server.host, server.port, server.protocol);
    const url = `${server.protocol || 'http'}://${server.host}:${server.port}${this.healthCheckConfig.endpoint}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.healthCheckConfig.timeout);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseTime = Date.now() - startTime;
      const isHealthy = response.ok;

      this.updateServerHealth(server, isHealthy, responseTime);

      this.logger.debug('Health check completed', {
        server: serverKey,
        healthy: isHealthy,
        responseTime,
        status: response.status,
      });

      return isHealthy;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateServerHealth(server, false, responseTime, error);

      this.logger.debug('Health check failed', {
        server: serverKey,
        error: error instanceof Error ? error.message : 'Unknown error',
        responseTime,
      });

      return false;
    }
  }

  recordRequest(server: ServerConfig, success: boolean, responseTime?: number): void {
    const serverKey = createServerKey(server.host, server.port, server.protocol);
    const stats = this.serverStats.get(serverKey);

    if (stats) {
      stats.requests++;
      stats.lastUsed = new Date();

      if (!success) {
        stats.errors++;
      }

      if (responseTime !== undefined) {
        stats.totalResponseTime += responseTime;
        stats.averageResponseTime = stats.totalResponseTime / stats.requests;
      }

      this.serverStats.set(serverKey, stats);
    }
  }

  private initializeServers(): void {
    for (const server of this.servers) {
      const serverKey = createServerKey(server.host, server.port, server.protocol);

      this.serverHealth.set(serverKey, {
        server,
        healthy: true,
        lastCheck: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });

      this.serverStats.set(serverKey, {
        requests: 0,
        errors: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        lastUsed: new Date(),
      });
    }
  }

  private updateServerHealth(
    server: ServerConfig,
    healthy: boolean,
    responseTime?: number,
    error?: unknown,
  ): void {
    const serverKey = createServerKey(server.host, server.port, server.protocol);
    const currentHealth = this.serverHealth.get(serverKey);

    if (!currentHealth) return;

    const updatedHealth: ServerHealth = {
      ...currentHealth,
      healthy,
      lastCheck: new Date(),
      ...(responseTime !== undefined && { responseTime }),
      ...(error instanceof Error && { error: error.message }),
    };

    if (healthy) {
      updatedHealth.consecutiveSuccesses = currentHealth.consecutiveSuccesses + 1;
      updatedHealth.consecutiveFailures = 0;
    } else {
      updatedHealth.consecutiveFailures = currentHealth.consecutiveFailures + 1;
      updatedHealth.consecutiveSuccesses = 0;
    }

    this.serverHealth.set(serverKey, updatedHealth);

    if (currentHealth.healthy !== healthy) {
      this.logger.info(`Server ${serverKey} is now ${healthy ? 'healthy' : 'unhealthy'}`);
    }
  }

  private updateServerStats(server: ServerConfig): void {
    const serverKey = createServerKey(server.host, server.port, server.protocol);
    const stats = this.serverStats.get(serverKey);

    if (stats) {
      stats.lastUsed = new Date();
      this.serverStats.set(serverKey, stats);
    }
  }

  private async startHealthChecks(): Promise<void> {
    this.logger.info('Starting health checks', {
      interval: this.healthCheckConfig.interval,
      timeout: this.healthCheckConfig.timeout,
    });

    this.healthCheckInterval = setInterval(async () => {
      const healthCheckPromises = this.servers.map((server) => this.checkServerHealth(server));
      await Promise.allSettled(healthCheckPromises);
    }, this.healthCheckConfig.interval);

    await Promise.allSettled(this.servers.map((server) => this.checkServerHealth(server)));
  }

  private createDefaultHealthCheckConfig(
    config?: HealthCheckConfig,
  ): Required<HealthCheckConfig> {
    return {
      enabled: config?.enabled !== false,
      endpoint: config?.endpoint || '/health',
      interval: config?.interval || 30000,
      timeout: config?.timeout || 5000,
      retries: config?.retries || 3,
      successThreshold: config?.successThreshold || 2,
      failureThreshold: config?.failureThreshold || 3,
    };
  }

  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }
}