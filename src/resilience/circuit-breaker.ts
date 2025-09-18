import type { Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  recoveryTimeout?: number;
  monitoringPeriod?: number;
  expectedFailureRate?: number;
  minimumRequests?: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  requests: number;
  rejections: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  nextAttempt?: Date;
}

export class CircuitBreakerError extends Error {
  public readonly state?: CircuitState;
  public readonly serviceName?: string;

  constructor(message: string, state?: CircuitState, serviceName?: string) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.state = state;
    this.serviceName = serviceName;
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private requests: number = 0;
  private rejections: number = 0;
  private lastFailureTime: Date | null = null;
  private lastSuccessTime: Date | null = null;
  private nextAttempt: Date | null = null;
  private readonly config: Required<CircuitBreakerConfig>;
  private readonly logger: Logger;
  private readonly serviceName: string;

  constructor(config: CircuitBreakerConfig = {}, logger?: Logger, serviceName: string = 'unknown-service') {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      recoveryTimeout: config.recoveryTimeout ?? 60000,
      monitoringPeriod: config.monitoringPeriod ?? 60000,
      expectedFailureRate: config.expectedFailureRate ?? 0.5,
      minimumRequests: config.minimumRequests ?? 10,
    };
    this.logger = logger || createDefaultLogger();
    this.serviceName = serviceName;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.requests++;

    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitState.HALF_OPEN;
        this.logger.info('Circuit breaker transitioned to HALF_OPEN state', { serviceName: this.serviceName });
      } else {
        this.rejections++;
        throw new CircuitBreakerError('Circuit breaker is OPEN', this.state, this.serviceName);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.logger.info('Circuit breaker closed after successful request', { serviceName: this.serviceName });
      this.resetCounts();
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
      this.logger.warn('Circuit breaker opened after failure in HALF_OPEN state');
    } else if (this.state === CircuitState.CLOSED && this.shouldOpen()) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
      this.logger.warn('Circuit breaker opened due to failure threshold exceeded', {
        failures: this.failures,
        threshold: this.config.failureThreshold,
      });
    }
  }

  private shouldOpen(): boolean {
    if (this.requests < this.config.minimumRequests) {
      return false;
    }

    const failureRate = this.failures / this.requests;
    return (
      this.failures >= this.config.failureThreshold ||
      failureRate >= this.config.expectedFailureRate
    );
  }

  private shouldAttemptReset(): boolean {
    return (
      this.nextAttempt !== null &&
      new Date() >= this.nextAttempt
    );
  }

  private resetCounts(): void {
    this.failures = 0;
    this.successes = 0;
    this.requests = 0;
    this.rejections = 0;
    // Don't assign undefined to nextAttempt here since it's optional
  }

  getStats(): CircuitBreakerStats & {
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
    failureRate: number;
    config: Required<CircuitBreakerConfig>;
    averageResponseTime: number;
  } {
    const stats: CircuitBreakerStats & {
      totalRequests: number;
      totalFailures: number;
      totalSuccesses: number;
      failureRate: number;
      config: Required<CircuitBreakerConfig>;
      averageResponseTime: number;
    } = {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      requests: this.requests,
      rejections: this.rejections,
      totalRequests: this.requests,
      totalFailures: this.failures,
      totalSuccesses: this.successes,
      failureRate: this.requests > 0 ? this.failures / this.requests : 0,
      config: { ...this.config },
      averageResponseTime: 0, // Would need to track timing
    };

    if (this.lastFailureTime) {
      stats.lastFailureTime = this.lastFailureTime;
    }

    if (this.lastSuccessTime) {
      stats.lastSuccessTime = this.lastSuccessTime;
    }

    if (this.nextAttempt) {
      stats.nextAttempt = this.nextAttempt;
    }

    return stats;
  }

  getState(): CircuitState {
    return this.state;
  }

  getDetailedStats(): CircuitBreakerStats & {
    config: Required<CircuitBreakerConfig>;
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
    failureRate: number;
    averageResponseTime: number;
  } {
    const baseStats = this.getStats();
    return {
      ...baseStats,
      config: { ...this.config },
      totalRequests: this.requests,
      totalFailures: this.failures,
      totalSuccesses: this.successes,
      failureRate: this.requests > 0 ? this.failures / this.requests : 0,
      averageResponseTime: 0, // Would need to track timing
    };
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.resetCounts();
    // Reset optional properties by setting them to null
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.nextAttempt = null;
    this.logger.info('Circuit breaker manually reset', { serviceName: this.serviceName });
  }

  forceOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttempt = new Date(Date.now() + this.config.recoveryTimeout);
    this.logger.warn('Circuit breaker manually forced open');
  }

  forceClose(): void {
    this.state = CircuitState.CLOSED;
    this.nextAttempt = null;
    this.logger.info('Circuit breaker manually forced closed');
  }
}