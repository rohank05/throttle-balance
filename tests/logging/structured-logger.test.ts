import {
  StructuredLogger,
  ConsoleTransport,
  FileTransport,
  LogLevel,
} from '../../src/logging/structured-logger.js';
import type { LogEntry, LogTransport } from '../../src/logging/structured-logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock transport for testing
class MockTransport implements LogTransport {
  name = 'mock';
  level: LogLevel;
  entries: LogEntry[] = [];

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  clear(): void {
    this.entries = [];
  }
}

describe('StructuredLogger', () => {
  describe('Basic Logging', () => {
    it('should log messages at different levels', () => {
      const mockTransport = new MockTransport(LogLevel.DEBUG);
      const logger = new StructuredLogger({
        level: LogLevel.DEBUG,
        transports: [mockTransport],
      });

      logger.error('Error message');
      logger.warn('Warning message');
      logger.info('Info message');
      logger.debug('Debug message');

      expect(mockTransport.entries).toHaveLength(4);
      expect(mockTransport.entries[0].level).toBe(LogLevel.ERROR);
      expect(mockTransport.entries[1].level).toBe(LogLevel.WARN);
      expect(mockTransport.entries[2].level).toBe(LogLevel.INFO);
      expect(mockTransport.entries[3].level).toBe(LogLevel.DEBUG);
    });

    it('should respect log level filtering', () => {
      const mockTransport = new MockTransport(LogLevel.DEBUG);
      const logger = new StructuredLogger({
        level: LogLevel.WARN, // Only WARN and ERROR should be logged
        transports: [mockTransport],
      });

      logger.error('Error message');
      logger.warn('Warning message');
      logger.info('Info message'); // Should be filtered out
      logger.debug('Debug message'); // Should be filtered out

      expect(mockTransport.entries).toHaveLength(2);
      expect(mockTransport.entries[0].level).toBe(LogLevel.ERROR);
      expect(mockTransport.entries[1].level).toBe(LogLevel.WARN);
    });

    it('should include timestamps by default', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [mockTransport],
      });

      logger.info('Test message');

      expect(mockTransport.entries[0].timestamp).toBeDefined();
      expect(new Date(mockTransport.entries[0].timestamp)).toBeInstanceOf(Date);
    });

    it('should support custom timestamp formats', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        timestampFormat: 'unix',
        transports: [mockTransport],
      });

      logger.info('Test message');

      const timestamp = mockTransport.entries[0].timestamp;
      expect(typeof timestamp).toBe('string');
      expect(Number(timestamp)).toBeGreaterThan(0);
    });

    it('should support custom timestamp formatter', () => {
      const mockTransport = new MockTransport();
      const customFormatter = jest.fn(() => 'custom-timestamp');
      const logger = new StructuredLogger({
        timestampFormat: 'custom',
        customTimestampFormatter: customFormatter,
        transports: [mockTransport],
      });

      logger.info('Test message');

      expect(customFormatter).toHaveBeenCalled();
      expect(mockTransport.entries[0].timestamp).toBe('custom-timestamp');
    });
  });

  describe('Metadata Handling', () => {
    it('should handle metadata objects', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [mockTransport],
        maskSensitiveData: false,
      });

      logger.info('User action', {
        userId: '123',
        action: 'login',
        ip: '192.168.1.1',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.userId).toBe('123');
      expect(entry.context?.metadata).toEqual({
        action: 'login',
        ip: '192.168.1.1',
      });
    });

    it('should handle Error objects', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [mockTransport],
      });

      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.js:1:1';

      logger.error('An error occurred', error);

      const entry = mockTransport.entries[0];
      expect(entry.error).toBeDefined();
      expect(entry.error?.name).toBe('Error');
      expect(entry.error?.message).toBe('Test error');
      expect(entry.error?.stack).toContain('Error: Test error');
    });

    it('should extract context fields from metadata', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [mockTransport],
      });

      logger.info('Request processed', {
        requestId: 'req-123',
        userId: 'user-456',
        duration: 250,
        statusCode: 200,
        extra: 'metadata',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.requestId).toBe('req-123');
      expect(entry.context?.userId).toBe('user-456');
      expect(entry.context?.duration).toBe(250);
      expect(entry.context?.statusCode).toBe(200);
      expect(entry.context?.metadata?.extra).toBe('metadata');
    });

    it('should merge with default context', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        defaultContext: {
          service: 'api-gateway',
          version: '1.0.0',
        },
        transports: [mockTransport],
      });

      logger.info('Test message', {
        requestId: 'req-123',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.service).toBe('api-gateway');
      expect(entry.context?.version).toBe('1.0.0');
      expect(entry.context?.requestId).toBe('req-123');
    });
  });

  describe('Sensitive Data Masking', () => {
    it('should mask sensitive fields by default', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        maskSensitiveData: true,
        transports: [mockTransport],
      });

      logger.info('User login', {
        username: 'testuser',
        password: 'secret123',
        token: 'abc123xyz',
        apiKey: 'key_12345',
        normalField: 'visible',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.metadata?.username).toBe('testuser');
      expect(entry.context?.metadata?.password).toBe('[MASKED]');
      expect(entry.context?.metadata?.token).toBe('[MASKED]');
      expect(entry.context?.metadata?.apiKey).toBe('[MASKED]');
      expect(entry.context?.metadata?.normalField).toBe('visible');
    });

    it('should use custom sensitive fields list', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        maskSensitiveData: true,
        sensitiveFields: ['customSecret', 'internalData'],
        transports: [mockTransport],
      });

      logger.info('Data processing', {
        customSecret: 'should-be-masked',
        internalData: 'also-masked',
        password: 'not-in-custom-list',
        publicInfo: 'visible',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.metadata?.customSecret).toBe('[MASKED]');
      expect(entry.context?.metadata?.internalData).toBe('[MASKED]');
      expect(entry.context?.metadata?.password).toBe('not-in-custom-list');
      expect(entry.context?.metadata?.publicInfo).toBe('visible');
    });

    it('should mask nested sensitive data', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        maskSensitiveData: true,
        transports: [mockTransport],
      });

      logger.info('Complex data', {
        user: {
          name: 'John',
          password: 'secret',
          preferences: {
            apiKey: 'key123',
            theme: 'dark',
          },
        },
      });

      const entry = mockTransport.entries[0];
      const userData = entry.context?.metadata?.user;
      expect(userData.name).toBe('John');
      expect(userData.password).toBe('[MASKED]');
      expect(userData.preferences.apiKey).toBe('[MASKED]');
      expect(userData.preferences.theme).toBe('dark');
    });

    it('should disable masking when configured', () => {
      const mockTransport = new MockTransport();
      const logger = new StructuredLogger({
        maskSensitiveData: false,
        transports: [mockTransport],
      });

      logger.info('Sensitive data', {
        password: 'secret123',
        token: 'abc123xyz',
      });

      const entry = mockTransport.entries[0];
      expect(entry.context?.metadata?.password).toBe('secret123');
      expect(entry.context?.metadata?.token).toBe('abc123xyz');
    });
  });

  describe('Child Loggers', () => {
    it('should create child logger with additional context', () => {
      const mockTransport = new MockTransport();
      const parentLogger = new StructuredLogger({
        defaultContext: {
          service: 'api-gateway',
        },
        transports: [mockTransport],
      });

      const childLogger = parentLogger.child({
        requestId: 'req-123',
        userId: 'user-456',
      });

      childLogger.info('Child log message');

      const entry = mockTransport.entries[0];
      expect(entry.context?.service).toBe('api-gateway');
      expect(entry.context?.requestId).toBe('req-123');
      expect(entry.context?.userId).toBe('user-456');
    });

    it('should not affect parent logger context', () => {
      const mockTransport = new MockTransport();
      const parentLogger = new StructuredLogger({
        defaultContext: {
          service: 'api-gateway',
        },
        transports: [mockTransport],
      });

      const childLogger = parentLogger.child({
        requestId: 'req-123',
      });

      parentLogger.info('Parent log');
      childLogger.info('Child log');

      expect(mockTransport.entries).toHaveLength(2);

      // Parent log should not have requestId
      expect(mockTransport.entries[0].context?.requestId).toBeUndefined();
      expect(mockTransport.entries[0].context?.service).toBe('api-gateway');

      // Child log should have both
      expect(mockTransport.entries[1].context?.requestId).toBe('req-123');
      expect(mockTransport.entries[1].context?.service).toBe('api-gateway');
    });
  });

  describe('Multiple Transports', () => {
    it('should write to multiple transports', () => {
      const transport1 = new MockTransport();
      const transport2 = new MockTransport();
      const logger = new StructuredLogger({
        transports: [transport1, transport2],
      });

      logger.info('Test message');

      expect(transport1.entries).toHaveLength(1);
      expect(transport2.entries).toHaveLength(1);
      expect(transport1.entries[0].message).toBe('Test message');
      expect(transport2.entries[0].message).toBe('Test message');
    });

    it('should respect transport-specific log levels', () => {
      const debugTransport = new MockTransport(LogLevel.DEBUG);
      const errorTransport = new MockTransport(LogLevel.ERROR);
      const logger = new StructuredLogger({
        level: LogLevel.DEBUG,
        transports: [debugTransport, errorTransport],
      });

      logger.debug('Debug message');
      logger.info('Info message');
      logger.error('Error message');

      expect(debugTransport.entries).toHaveLength(3); // All messages
      expect(errorTransport.entries).toHaveLength(1); // Only error
      expect(errorTransport.entries[0].level).toBe(LogLevel.ERROR);
    });

    it('should handle transport errors gracefully', () => {
      const faultyTransport: LogTransport = {
        name: 'faulty',
        level: LogLevel.INFO,
        write: jest.fn().mockImplementation(() => {
          throw new Error('Transport error');
        }),
      };

      const goodTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [faultyTransport, goodTransport],
      });

      // Should not throw, but log should still go to good transport
      expect(() => logger.info('Test message')).not.toThrow();
      expect(goodTransport.entries).toHaveLength(1);
    });
  });

  describe('Transport Management', () => {
    it('should add transports at runtime', () => {
      const initialTransport = new MockTransport();
      const logger = new StructuredLogger({
        transports: [initialTransport],
      });

      const newTransport = new MockTransport();
      logger.addTransport(newTransport);

      logger.info('Test message');

      expect(initialTransport.entries).toHaveLength(1);
      expect(newTransport.entries).toHaveLength(1);
    });

    it('should remove transports by name', () => {
      const transport1 = new MockTransport();
      transport1.name = 'transport1';
      const transport2 = new MockTransport();
      transport2.name = 'transport2';

      const logger = new StructuredLogger({
        transports: [transport1, transport2],
      });

      const removed = logger.removeTransport('transport1');
      expect(removed).toBe(true);

      logger.info('Test message');

      expect(transport1.entries).toHaveLength(0);
      expect(transport2.entries).toHaveLength(1);
    });

    it('should return false when removing non-existent transport', () => {
      const logger = new StructuredLogger();
      const removed = logger.removeTransport('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('Configuration Management', () => {
    it('should get current configuration', () => {
      const mockTransport = new MockTransport();
      const defaultContext = { service: 'test' };
      const logger = new StructuredLogger({
        level: LogLevel.WARN,
        transports: [mockTransport],
        defaultContext,
        enableStackTrace: false,
        maskSensitiveData: false,
      });

      const config = logger.getConfig();
      expect(config.level).toBe(LogLevel.WARN);
      expect(config.transports).toHaveLength(1);
      expect(config.defaultContext).toEqual(defaultContext);
      expect(config.enableStackTrace).toBe(false);
      expect(config.maskSensitiveData).toBe(false);
    });

    it('should get and set log level', () => {
      const logger = new StructuredLogger({
        level: LogLevel.INFO,
      });

      expect(logger.getLevel()).toBe(LogLevel.INFO);

      logger.setLevel(LogLevel.DEBUG);
      expect(logger.getLevel()).toBe(LogLevel.DEBUG);
    });

    it('should provide statistics', () => {
      const transport1 = new MockTransport(LogLevel.DEBUG);
      const transport2 = new MockTransport(LogLevel.ERROR);
      const logger = new StructuredLogger({
        level: LogLevel.INFO,
        transports: [transport1, transport2],
        defaultContext: { service: 'test' },
        maskSensitiveData: true,
      });

      const stats = logger.getStats();
      expect(stats.level).toBe(LogLevel.INFO);
      expect(stats.transportsCount).toBe(2);
      expect(stats.transports).toHaveLength(2);
      expect(stats.transports[0].name).toBe('mock');
      expect(stats.transports[0].level).toBe(LogLevel.DEBUG);
      expect(stats.hasSensitiveDataMasking).toBe(true);
      expect(stats.hasDefaultContext).toBe(true);
    });
  });
});

describe('ConsoleTransport', () => {
  let consoleSpies: jest.SpyInstance[];

  beforeEach(() => {
    consoleSpies = [
      jest.spyOn(console, 'error').mockImplementation(),
      jest.spyOn(console, 'warn').mockImplementation(),
      jest.spyOn(console, 'info').mockImplementation(),
      jest.spyOn(console, 'debug').mockImplementation(),
      jest.spyOn(console, 'log').mockImplementation(),
    ];
  });

  afterEach(() => {
    consoleSpies.forEach(spy => spy.mockRestore());
  });

  it('should format pretty output', () => {
    const transport = new ConsoleTransport(LogLevel.INFO, {
      prettyPrint: true,
      enableColors: false,
    });

    const entry: LogEntry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: LogLevel.INFO,
      message: 'Test message',
      context: {
        requestId: 'req-123',
        userId: 'user-456',
      },
    };

    transport.write(entry);

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('2023-01-01T00:00:00.000Z [INFO] Test message')
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('requestId="req-123"')
    );
  });

  it('should output JSON format when pretty print is disabled', () => {
    const transport = new ConsoleTransport(LogLevel.INFO, {
      prettyPrint: false,
    });

    const entry: LogEntry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: LogLevel.INFO,
      message: 'Test message',
    };

    transport.write(entry);

    expect(console.info).toHaveBeenCalledWith(JSON.stringify(entry));
  });

  it('should use appropriate console methods for different log levels', () => {
    const transport = new ConsoleTransport(LogLevel.DEBUG);

    const baseEntry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      message: 'Test message',
    };

    transport.write({ ...baseEntry, level: LogLevel.ERROR });
    transport.write({ ...baseEntry, level: LogLevel.WARN });
    transport.write({ ...baseEntry, level: LogLevel.INFO });
    transport.write({ ...baseEntry, level: LogLevel.DEBUG });

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.debug).toHaveBeenCalledTimes(1);
  });
});

describe('FileTransport', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logger-test-'));
    tempFile = path.join(tempDir, 'test.log');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should write log entries to file', async () => {
    const transport = new FileTransport(tempFile, LogLevel.INFO);

    const entry: LogEntry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: LogLevel.INFO,
      message: 'Test message',
      context: {
        requestId: 'req-123',
      },
    };

    await transport.write(entry);

    const fileContent = await fs.readFile(tempFile, 'utf8');
    const loggedEntry = JSON.parse(fileContent.trim());

    expect(loggedEntry).toEqual(entry);
  });

  it('should append multiple log entries', async () => {
    const transport = new FileTransport(tempFile, LogLevel.INFO);

    const entry1: LogEntry = {
      timestamp: '2023-01-01T00:00:00.000Z',
      level: LogLevel.INFO,
      message: 'First message',
    };

    const entry2: LogEntry = {
      timestamp: '2023-01-01T00:00:01.000Z',
      level: LogLevel.WARN,
      message: 'Second message',
    };

    await transport.write(entry1);
    await transport.write(entry2);

    const fileContent = await fs.readFile(tempFile, 'utf8');
    const lines = fileContent.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });
});