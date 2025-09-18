import { CircuitBreaker, CircuitBreakerError, CircuitState } from '../../src/resilience/circuit-breaker.js';

// Mock logger
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Basic Circuit Breaker Behavior', () => {
    it('should start in CLOSED state', () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should execute successful operations in CLOSED state', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');
      const mockOperation = jest.fn().mockResolvedValue('success');

      const result = await breaker.execute(mockOperation);

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(1);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should handle operation failures in CLOSED state', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');
      const error = new Error('Operation failed');
      const mockOperation = jest.fn().mockRejectedValue(error);

      await expect(breaker.execute(mockOperation)).rejects.toThrow('Operation failed');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition to OPEN state after failure threshold', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 3,
        minimumRequests: 3,
      }, mockLogger, 'test-service');

      const error = new Error('Operation failed');
      const mockOperation = jest.fn().mockRejectedValue(error);

      // Execute 3 failed operations
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(mockOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker opened'),
        expect.any(Object)
      );
    });

    it('should reject operations immediately in OPEN state', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 2,
      }, mockLogger, 'test-service');

      const error = new Error('Operation failed');
      const failingOperation = jest.fn().mockRejectedValue(error);

      // Trigger circuit to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Now try a new operation - should be rejected immediately
      const newOperation = jest.fn().mockResolvedValue('success');
      await expect(breaker.execute(newOperation)).rejects.toThrow(CircuitBreakerError);
      expect(newOperation).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after recovery timeout', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 2,
        recoveryTimeout: 1000,
      }, mockLogger, 'test-service');

      const error = new Error('Operation failed');
      const failingOperation = jest.fn().mockRejectedValue(error);

      // Trigger circuit to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Fast-forward time to trigger recovery
      jest.advanceTimersByTime(1100);

      // Next operation should transition to HALF_OPEN
      const testOperation = jest.fn().mockResolvedValue('success');
      const result = await breaker.execute(testOperation);

      expect(result).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.CLOSED); // Success should close it
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker transitioned to HALF_OPEN'),
        expect.any(Object)
      );
    });

    it('should return to OPEN if operation fails in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 2,
        recoveryTimeout: 1000,
      }, mockLogger, 'test-service');

      const error = new Error('Operation failed');
      const failingOperation = jest.fn().mockRejectedValue(error);

      // Trigger circuit to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Fast-forward to recovery time
      jest.advanceTimersByTime(1100);

      // Try operation that fails in HALF_OPEN
      const stillFailingOperation = jest.fn().mockRejectedValue(error);
      await expect(breaker.execute(stillFailingOperation)).rejects.toThrow('Operation failed');

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should close circuit after successful operation in HALF_OPEN', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 2,
        recoveryTimeout: 1000,
      }, mockLogger, 'test-service');

      const error = new Error('Operation failed');
      const failingOperation = jest.fn().mockRejectedValue(error);

      // Trigger circuit to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Fast-forward to recovery time
      jest.advanceTimersByTime(1100);

      // Successful operation should close the circuit
      const successOperation = jest.fn().mockResolvedValue('recovered');
      const result = await breaker.execute(successOperation);

      expect(result).toBe('recovered');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker closed'),
        expect.any(Object)
      );
    });
  });

  describe('Failure Rate Calculation', () => {
    it('should calculate failure rate correctly', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 5,
        expectedFailureRate: 0.5, // 50%
        minimumRequests: 10,
        monitoringPeriod: 60000,
      }, mockLogger, 'test-service');

      const successOperation = jest.fn().mockResolvedValue('success');
      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Execute 10 operations: 7 success, 3 failures (30% failure rate)
      for (let i = 0; i < 7; i++) {
        await breaker.execute(successOperation);
      }

      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Should still be closed because failure rate (30%) < expected (50%)
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      // Add 3 more failures to reach 60% failure rate
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Now should be open because failure rate (60%) > expected (50%)
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should not open circuit if minimum requests not reached', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 5,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Execute only 3 failing operations (less than minimumRequests)
      for (let i = 0; i < 3; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Should still be closed because we haven't reached minimum requests
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('Time Window Management', () => {
    it('should reset counters after monitoring period', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 3,
        minimumRequests: 3,
        monitoringPeriod: 60000, // 1 minute
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Execute 2 failing operations
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      // Fast-forward past monitoring period
      jest.advanceTimersByTime(61000);

      // Execute one more failing operation
      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      // Should still be closed because counters were reset
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should maintain state within monitoring period', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 3,
        minimumRequests: 3,
        monitoringPeriod: 60000,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Execute 2 failing operations
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      // Fast-forward but stay within monitoring period
      jest.advanceTimersByTime(30000);

      // Execute one more failing operation
      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      // Should be open because we reached failure threshold within monitoring period
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should provide accurate statistics', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      const successOperation = jest.fn().mockResolvedValue('success');
      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Execute some operations
      await breaker.execute(successOperation);
      await breaker.execute(successOperation);

      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.totalFailures).toBe(1);
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.failureRate).toBeCloseTo(1/3, 2);
      expect(stats.state).toBe(CircuitState.CLOSED);
    });

    it('should track request duration', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      const slowOperation = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'slow-success';
      });

      // Use real timers for this test
      jest.useRealTimers();

      const result = await breaker.execute(slowOperation);
      expect(result).toBe('slow-success');

      const stats = breaker.getStats();
      expect(stats.averageResponseTime).toBeGreaterThan(0);

      jest.useFakeTimers();
    });

    it('should provide circuit breaker configuration', () => {
      const config = {
        failureThreshold: 10,
        recoveryTimeout: 30000,
        monitoringPeriod: 120000,
        expectedFailureRate: 0.3,
        minimumRequests: 20,
      };

      const breaker = new CircuitBreaker( config, mockLogger);
      const stats = breaker.getStats();

      expect(stats.config.failureThreshold).toBe(10);
      expect(stats.config.recoveryTimeout).toBe(30000);
      expect(stats.config.monitoringPeriod).toBe(120000);
      expect(stats.config.expectedFailureRate).toBe(0.3);
      expect(stats.config.minimumRequests).toBe(20);
    });
  });

  describe('Manual Control', () => {
    it('should allow manual reset', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 2,
        minimumRequests: 2,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Trigger circuit to open
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Manually reset
      breaker.reset();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker manually reset'),
        expect.any(Object)
      );

      // Should be able to execute operations again
      const successOperation = jest.fn().mockResolvedValue('success');
      const result = await breaker.execute(successOperation);
      expect(result).toBe('success');
    });

    it('should allow manual opening', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.forceOpen();

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Operations should be rejected
      const operation = jest.fn().mockResolvedValue('success');
      await expect(breaker.execute(operation)).rejects.toThrow(CircuitBreakerError);
      expect(operation).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle synchronous errors', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      const syncErrorOperation = jest.fn().mockImplementation(() => {
        throw new Error('Synchronous error');
      });

      await expect(breaker.execute(syncErrorOperation)).rejects.toThrow('Synchronous error');
    });

    it('should handle timeout errors specifically', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      const timeoutOperation = jest.fn().mockRejectedValue(new Error('TIMEOUT'));

      await expect(breaker.execute(timeoutOperation)).rejects.toThrow('TIMEOUT');

      const stats = breaker.getStats();
      expect(stats.totalFailures).toBe(1);
    });

    it('should properly categorize circuit breaker errors', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 1,
        minimumRequests: 1,
      }, mockLogger, 'test-service');

      // Trigger circuit to open
      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));
      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Next operation should throw CircuitBreakerError
      const operation = jest.fn().mockResolvedValue('success');

      let caughtError;
      try {
        await breaker.execute(operation);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(CircuitBreakerError);
      expect(caughtError.message).toContain('Circuit breaker is OPEN');
      expect(caughtError.state).toBe(CircuitState.OPEN);
      expect(caughtError.serviceName).toBe('test-service');
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent requests correctly', async () => {
      const breaker = new CircuitBreaker({}, mockLogger, 'test-service');

      const operation = jest.fn().mockResolvedValue('success');

      // Execute multiple operations concurrently
      const promises = Array.from({ length: 10 }, () => breaker.execute(operation));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      expect(results.every(r => r === 'success')).toBe(true);
      expect(operation).toHaveBeenCalledTimes(10);

      const stats = breaker.getStats();
      expect(stats.totalRequests).toBe(10);
      expect(stats.totalSuccesses).toBe(10);
    });

    it('should handle race conditions during state transitions', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 5,
        minimumRequests: 5,
        recoveryTimeout: 1000,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Trigger circuit to open with concurrent failures
      const failurePromises = Array.from({ length: 5 }, () =>
        breaker.execute(failingOperation).catch(() => {})
      );

      await Promise.all(failurePromises);
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Fast-forward to recovery time
      jest.advanceTimersByTime(1100);

      // Multiple concurrent operations during recovery
      const successOperation = jest.fn().mockResolvedValue('success');
      const recoveryPromises = Array.from({ length: 3 }, () =>
        breaker.execute(successOperation).catch(() => {})
      );

      await Promise.all(recoveryPromises);

      // Should have handled the race condition gracefully
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('Custom Configurations', () => {
    it('should work with very low failure threshold', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 1,
        minimumRequests: 1,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should work with very high failure threshold', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 100,
        minimumRequests: 100,
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Even with many failures, should not open due to high threshold
      for (let i = 0; i < 50; i++) {
        try {
          await breaker.execute(failingOperation);
        } catch (e) {
          // Expected failures
        }
      }

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should work with very short recovery timeout', async () => {
      const breaker = new CircuitBreaker( {
        failureThreshold: 1,
        minimumRequests: 1,
        recoveryTimeout: 10, // Very short
      }, mockLogger, 'test-service');

      const failingOperation = jest.fn().mockRejectedValue(new Error('failed'));

      // Trigger circuit to open
      try {
        await breaker.execute(failingOperation);
      } catch (e) {
        // Expected failure
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Fast-forward just past recovery time
      jest.advanceTimersByTime(15);

      // Should be able to transition to HALF_OPEN quickly
      const successOperation = jest.fn().mockResolvedValue('success');
      const result = await breaker.execute(successOperation);

      expect(result).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });
});