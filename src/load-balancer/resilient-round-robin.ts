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
import { CircuitBreakerFactory, type CircuitBreakerConfig } from '../resilience/index.js';

export interface ResilientLoadBalancerConfig {
  servers: ServerConfig[];
  healthCheck?: HealthCheckConfig;
  circuitBreaker?: CircuitBreakerConfig;
}

export class ResilientRoundRobinLoadBalancer {
  private servers: ServerConfig[];
  private currentIndex: number = 0;
  private serverHealth: Map<string, ServerHealth> = new Map();
  private serverStats: Map<string, ServerStats> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;
  private readonly healthCheckConfig: HealthCheckConfig;
  private readonly circuitBreakerFactory: CircuitBreakerFactory;
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private readonly logger: Logger;

  constructor(config: ResilientLoadBalancerConfig, logger?: Logger) {
    if (!config.servers || config.servers.length === 0) {
      throw new LoadBalancerError('At least one server must be configured');
    }

    this.servers = config.servers;
    this.logger = logger || createDefaultLogger();
    this.healthCheckConfig = this.createDefaultHealthCheckConfig(config.healthCheck);
    this.circuitBreakerConfig = config.circuitBreaker || {};
    this.circuitBreakerFactory = new CircuitBreakerFactory(this.logger);

    this.initializeServers();

    if (this.healthCheckConfig.enabled) {
      this.startHealthChecks();
    }
  }

  async getNextServer(): Promise<ServerConfig | null> {
    const healthyServers = this.getHealthyServers();

    if (healthyServers.length === 0) {
      this.logger.warn('No healthy servers available');
      return null;
    }

    if (this.currentIndex >= healthyServers.length) {
      this.currentIndex = 0;
    }

    const server = healthyServers[this.currentIndex];
    if (!server) {
      return null;
    }
    this.currentIndex = (this.currentIndex + 1) % healthyServers.length;

    // Check circuit breaker for this server
    const serverKey = createServerKey(server);
    const breakerStats = this.circuitBreakerFactory.getBreakerStats(serverKey);

    // If circuit breaker is open, try next server
    if (breakerStats && breakerStats.state === 'open') {
      this.logger.debug(`Circuit breaker open for server ${serverKey}, trying next server`);
      // Recursively try next server (with protection against infinite recursion)
      const availableServers = healthyServers.filter(s => {
        const key = createServerKey(s);
        const stats = this.circuitBreakerFactory.getBreakerStats(key);
        return !stats || stats.state !== 'open';
      });

      if (availableServers.length === 0) {
        this.logger.warn('All servers have open circuit breakers');
        return null;
      }

      // Find the next available server in our rotation
      for (let i = 0; i < healthyServers.length; i++) {
        const nextServer = healthyServers[(this.currentIndex + i) % healthyServers.length];
        if (!nextServer) {
          continue;
        }
        const nextServerKey = createServerKey(nextServer);
        const nextStats = this.circuitBreakerFactory.getBreakerStats(nextServerKey);

        if (!nextStats || nextStats.state !== 'open') {
          this.currentIndex = (this.currentIndex + i + 1) % healthyServers.length;
          return nextServer;
        }
      }

      return null;
    }

    return server;
  }

  async executeWithCircuitBreaker<T>(
    server: ServerConfig,
    operation: () => Promise<T>
  ): Promise<T> {
    const serverKey = createServerKey(server);
    return this.circuitBreakerFactory.executeWithBreaker(
      serverKey,
      operation,
      this.circuitBreakerConfig
    );
  }

  recordRequest(server: ServerConfig, success: boolean, responseTime: number): void {
    const serverKey = createServerKey(server);
    const stats = this.getOrCreateServerStats(serverKey);

    stats.requests++;
    stats.totalResponseTime += responseTime;
    stats.averageResponseTime = stats.totalResponseTime / stats.requests;
    stats.lastUsed = new Date();

    if (!success) {
      stats.errors++;
    }

    // Update circuit breaker indirectly by recording the result
    // The circuit breaker will be updated when executeWithCircuitBreaker is called
    if (success) {
      this.logger.debug(`Request succeeded for server ${serverKey}`, { responseTime });
    } else {
      this.logger.warn(`Request failed for server ${serverKey}`, { responseTime });
    }
  }

  private getHealthyServers(): ServerConfig[] {
    return this.servers.filter(server => {
      const serverKey = createServerKey(server);
      const health = this.serverHealth.get(serverKey);
      return health ? health.healthy : true;
    });
  }

  private initializeServers(): void {
    for (const server of this.servers) {
      const serverKey = createServerKey(server);

      this.serverHealth.set(serverKey, {
        server,
        healthy: true,
        lastCheck: new Date(),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      });

      this.getOrCreateServerStats(serverKey);
    }

    this.logger.info(`Initialized ${this.servers.length} servers`);
  }

  private getOrCreateServerStats(serverKey: string): ServerStats {
    if (!this.serverStats.has(serverKey)) {
      this.serverStats.set(serverKey, {
        requests: 0,
        errors: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        lastUsed: new Date(),
      });
    }
    return this.serverStats.get(serverKey)!;
  }

  private createDefaultHealthCheckConfig(config?: HealthCheckConfig): HealthCheckConfig {
    const result: HealthCheckConfig = {
      enabled: config?.enabled ?? true,
      endpoint: config?.endpoint ?? '/health',
      interval: config?.interval ?? 30000,
      timeout: config?.timeout ?? 5000,
      retries: config?.retries ?? 3,
      successThreshold: config?.successThreshold ?? 2,
      failureThreshold: config?.failureThreshold ?? 3,
      type: config?.type ?? 'http',
      expectedStatusCodes: config?.expectedStatusCodes ?? [200],
      headers: config?.headers ?? {},
    };

    if (config?.expectedResponseBody) {
      result.expectedResponseBody = config.expectedResponseBody;
    }

    return result;
  }

  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.healthCheckConfig.interval);

    this.logger.info('Health checks started', {
      interval: this.healthCheckConfig.interval,
      endpoint: this.healthCheckConfig.endpoint,
    });
  }

  private async performHealthChecks(): Promise<void> {
    const healthCheckPromises = this.servers.map(server => this.checkServerHealth(server));
    await Promise.allSettled(healthCheckPromises);
  }

  private async checkServerHealth(server: ServerConfig): Promise<void> {
    const serverKey = createServerKey(server);
    const health = this.serverHealth.get(serverKey)!;

    try {
      // Simulate health check - in real implementation, this would make HTTP request
      const startTime = Date.now();
      const isHealthy = await this.performHealthCheckRequest(server);
      const responseTime = Date.now() - startTime;

      health.lastCheck = new Date();
      health.responseTime = responseTime;

      if (isHealthy) {
        health.consecutiveSuccesses++;
        health.consecutiveFailures = 0;

        if (!health.healthy && health.consecutiveSuccesses >= (this.healthCheckConfig.successThreshold || 2)) {
          health.healthy = true;
          this.logger.info(`Server ${serverKey} is now healthy`);
        }
      } else {
        health.consecutiveFailures++;
        health.consecutiveSuccesses = 0;

        if (health.healthy && health.consecutiveFailures >= (this.healthCheckConfig.failureThreshold || 3)) {
          health.healthy = false;
          this.logger.warn(`Server ${serverKey} is now unhealthy`);
        }
      }
    } catch (error) {
      health.consecutiveFailures++;
      health.consecutiveSuccesses = 0;
      health.lastCheck = new Date();
      health.error = error instanceof Error ? error.message : 'Unknown error';

      if (health.healthy && health.consecutiveFailures >= (this.healthCheckConfig.failureThreshold || 3)) {
        health.healthy = false;
        this.logger.error(`Server ${serverKey} health check failed`, error);
      }
    }
  }

  private async performHealthCheckRequest(server: ServerConfig): Promise<boolean> {
    // This is a simplified implementation
    // In a real scenario, you would make an HTTP request to the health endpoint
    // const url = `${server.protocol || 'http'}://${server.host}:${server.port}${this.healthCheckConfig.endpoint}`;

    // For now, we'll simulate a health check that occasionally fails
    // Replace this with actual HTTP request implementation
    return new Promise<boolean>((resolve) => {
      setTimeout(() => {
        // Simulate 90% success rate based on server configuration
        const successRate = (server.metadata && server.metadata['successRate']) || 0.9;
        resolve(Math.random() < successRate);
      }, Math.random() * 100);
    });
  }

  getStats(): LoadBalancerStats {
    const stats: LoadBalancerStats = {
      totalRequests: 0,
      totalErrors: 0,
      serverStats: new Map(),
    };

    for (const [serverKey, serverStats] of this.serverStats) {
      stats.totalRequests += serverStats.requests;
      stats.totalErrors += serverStats.errors;
      stats.serverStats.set(serverKey, { ...serverStats });
    }

    return stats;
  }

  getServerHealth(): Map<string, ServerHealth> {
    return new Map(this.serverHealth);
  }

  getCircuitBreakerStats(): Record<string, any> {
    return this.circuitBreakerFactory.getAllStats();
  }

  resetCircuitBreaker(serverKey: string): void {
    this.circuitBreakerFactory.resetBreaker(serverKey);
  }

  resetAllCircuitBreakers(): void {
    this.circuitBreakerFactory.resetAllBreakers();
  }

  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.circuitBreakerFactory.destroy();
    this.logger.info('Resilient load balancer destroyed');
  }
}