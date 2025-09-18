import type { ServerConfig, HealthCheckConfig, ServerHealth, Logger } from '../types/index.js';
import { createDefaultLogger, createServerKey } from '../utils/index.js';
import * as net from 'net';

export enum HealthCheckType {
  HTTP = 'http',
  HTTPS = 'https',
  TCP = 'tcp',
}

export interface AdvancedHealthCheckConfig extends HealthCheckConfig {
  type?: HealthCheckType;
  expectedStatusCodes?: number[];
  expectedResponseBody?: string | RegExp;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  maxRedirects?: number;
  userAgent?: string;
}

export interface HealthCheckResult {
  healthy: boolean;
  responseTime: number;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  timestamp: Date;
}

export class AdvancedHealthChecker {
  private readonly config: AdvancedHealthCheckConfig;
  private readonly logger: Logger;
  private readonly serverHealth: Map<string, ServerHealth> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(config: AdvancedHealthCheckConfig = {}, logger?: Logger) {
    this.config = this.createDefaultConfig(config);
    this.logger = logger || createDefaultLogger();
  }

  async checkServer(server: ServerConfig): Promise<HealthCheckResult> {
    const startTime = Date.now();
    const serverKey = createServerKey(server);

    try {
      let result: HealthCheckResult;

      switch (this.config.type) {
        case HealthCheckType.TCP:
          result = await this.performTcpHealthCheck(server);
          break;
        case HealthCheckType.HTTP:
        case HealthCheckType.HTTPS:
          result = await this.performHttpHealthCheck(server);
          break;
        default:
          throw new Error(`Unsupported health check type: ${this.config.type}`);
      }

      result.responseTime = Date.now() - startTime;
      this.updateServerHealth(serverKey, server, result);

      this.logger.debug(`Health check completed for ${serverKey}`, {
        healthy: result.healthy,
        responseTime: result.responseTime,
        type: this.config.type,
      });

      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      };

      this.updateServerHealth(serverKey, server, result);
      this.logger.error(`Health check failed for ${serverKey}`, error);

      return result;
    }
  }

  private async performTcpHealthCheck(server: ServerConfig): Promise<HealthCheckResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const startTime = Date.now();
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
          error: 'Connection timeout',
          timestamp: new Date(),
        });
      }, this.config.timeout);

      socket.on('connect', () => {
        clearTimeout(timeout);
        cleanup();
        resolve({
          healthy: true,
          responseTime: Date.now() - startTime,
          timestamp: new Date(),
        });
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        cleanup();
        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
          error: error.message,
          timestamp: new Date(),
        });
      });

      socket.connect(server.port, server.host);
    });
  }

  private async performHttpHealthCheck(server: ServerConfig): Promise<HealthCheckResult> {
    const protocol = this.config.type === HealthCheckType.HTTPS ? 'https' : 'http';
    const url = `${protocol}://${server.host}:${server.port}${this.config.endpoint}`;

    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;

      // Use dynamic import to handle both HTTP and HTTPS
      const httpModule = protocol === 'https' ?
        require('https') : require('http');

      const requestOptions = {
        method: 'GET',
        timeout: this.config.timeout,
        headers: {
          'User-Agent': this.config.userAgent,
          ...this.config.headers,
        },
      };

      const request = httpModule.request(url, requestOptions, (response: any) => {
        if (resolved) return;

        let responseBody = '';
        response.setEncoding('utf8');

        response.on('data', (chunk: string) => {
          responseBody += chunk;
        });

        response.on('end', () => {
          if (resolved) return;
          resolved = true;

          const responseTime = Date.now() - startTime;
          const isHealthy = this.evaluateHttpResponse(response.statusCode, responseBody);

          resolve({
            healthy: isHealthy,
            responseTime,
            statusCode: response.statusCode,
            responseBody: responseBody.length > 500 ? responseBody.substring(0, 500) + '...' : responseBody,
            timestamp: new Date(),
          });
        });
      });

      request.on('error', (error: Error) => {
        if (resolved) return;
        resolved = true;

        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
          error: error.message,
          timestamp: new Date(),
        });
      });

      request.on('timeout', () => {
        if (resolved) return;
        resolved = true;
        request.destroy();

        resolve({
          healthy: false,
          responseTime: Date.now() - startTime,
          error: 'Request timeout',
          timestamp: new Date(),
        });
      });

      request.end();
    });
  }

  private evaluateHttpResponse(statusCode: number, responseBody: string): boolean {
    // Check status code
    const expectedCodes = this.config.expectedStatusCodes || [200, 201, 202, 204];
    if (!expectedCodes.includes(statusCode)) {
      return false;
    }

    // Check response body if expected
    if (this.config.expectedResponseBody) {
      if (typeof this.config.expectedResponseBody === 'string') {
        return responseBody.includes(this.config.expectedResponseBody);
      } else if (this.config.expectedResponseBody instanceof RegExp) {
        return this.config.expectedResponseBody.test(responseBody);
      }
    }

    return true;
  }

  private updateServerHealth(serverKey: string, server: ServerConfig, result: HealthCheckResult): void {
    const currentHealth = this.serverHealth.get(serverKey) || {
      server,
      healthy: true,
      lastCheck: new Date(),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };

    currentHealth.lastCheck = result.timestamp;
    currentHealth.responseTime = result.responseTime;

    if (result.healthy) {
      currentHealth.consecutiveSuccesses++;
      currentHealth.consecutiveFailures = 0;
      delete currentHealth.error;

      if (!currentHealth.healthy && currentHealth.consecutiveSuccesses >= (this.config.successThreshold || 2)) {
        currentHealth.healthy = true;
        this.logger.info(`Server ${serverKey} is now healthy`);
      }
    } else {
      currentHealth.consecutiveFailures++;
      currentHealth.consecutiveSuccesses = 0;
      if (result.error) {
        currentHealth.error = result.error;
      }

      if (currentHealth.healthy && currentHealth.consecutiveFailures >= (this.config.failureThreshold || 3)) {
        currentHealth.healthy = false;
        this.logger.warn(`Server ${serverKey} is now unhealthy`);
      }
    }

    this.serverHealth.set(serverKey, currentHealth);
  }

  async checkMultipleServers(servers: ServerConfig[]): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();

    const promises = servers.map(async (server) => {
      const result = await this.checkServer(server);
      const serverKey = createServerKey(server);
      results.set(serverKey, result);
      return { serverKey, result };
    });

    await Promise.allSettled(promises);
    return results;
  }

  startPeriodicHealthChecks(servers: ServerConfig[]): void {
    if (this.healthCheckInterval) {
      this.stopPeriodicHealthChecks();
    }

    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.checkMultipleServers(servers);
      } catch (error) {
        this.logger.error('Error during periodic health checks', error);
      }
    }, this.config.interval || 30000);

    this.logger.info('Started periodic health checks', {
      interval: this.config.interval,
      type: this.config.type,
      endpoint: this.config.endpoint,
    });
  }

  stopPeriodicHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      // Don't assign undefined to optional property
      this.logger.info('Stopped periodic health checks');
    }
  }

  getServerHealth(serverKey: string): ServerHealth | undefined {
    return this.serverHealth.get(serverKey);
  }

  getAllServerHealth(): Map<string, ServerHealth> {
    return new Map(this.serverHealth);
  }

  getHealthyServers(): ServerHealth[] {
    return Array.from(this.serverHealth.values()).filter(health => health.healthy);
  }

  getUnhealthyServers(): ServerHealth[] {
    return Array.from(this.serverHealth.values()).filter(health => !health.healthy);
  }

  private createDefaultConfig(config: AdvancedHealthCheckConfig): AdvancedHealthCheckConfig {
    const result: AdvancedHealthCheckConfig = {
      enabled: config.enabled ?? true,
      type: config.type ?? HealthCheckType.HTTP,
      endpoint: config.endpoint ?? '/health',
      interval: config.interval ?? 30000,
      timeout: config.timeout ?? 5000,
      retries: config.retries ?? 3,
      successThreshold: config.successThreshold ?? 2,
      failureThreshold: config.failureThreshold ?? 3,
      expectedStatusCodes: config.expectedStatusCodes ?? [200, 201, 202, 204],
      headers: config.headers ?? {},
      followRedirects: config.followRedirects ?? false,
      maxRedirects: config.maxRedirects ?? 3,
      userAgent: config.userAgent ?? 'FlowControl-HealthChecker/1.0',
    };

    if (config.expectedResponseBody) {
      result.expectedResponseBody = config.expectedResponseBody;
    }

    return result;
  }

  destroy(): void {
    this.stopPeriodicHealthChecks();
    this.serverHealth.clear();
    this.logger.info('Advanced health checker destroyed');
  }
}