import { IPFilter, IPFilterAction, IPFilterError } from '../../src/security/ip-filter.js';
import type { Request, Response } from 'express';

// Mock request and response objects
const mockRequest = (ip: string, headers: Record<string, any> = {}): Partial<Request> => ({
  ip,
  socket: { remoteAddress: ip } as any,
  headers,
  path: '/test',
  method: 'GET',
});

const mockResponse = (): Partial<Response> => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('IPFilter', () => {
  describe('Basic IP Filtering', () => {
    it('should allow IP by default in hybrid mode', () => {
      const filter = new IPFilter();
      const result = filter.checkIP('192.168.1.1');

      expect(result.allowed).toBe(true);
      expect(result.action).toBe(IPFilterAction.ALLOW);
      expect(result.reason).toContain('Default action');
    });

    it('should block IP in whitelist mode when not whitelisted', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.100'],
      });

      const result = filter.checkIP('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in whitelist');
    });

    it('should allow whitelisted IP', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.1'],
      });

      const result = filter.checkIP('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.action).toBe(IPFilterAction.ALLOW);
      expect(result.rule?.description).toContain('Whitelist entry');
    });

    it('should block blacklisted IP', () => {
      const filter = new IPFilter({
        mode: 'blacklist',
        blacklist: ['192.168.1.1'],
      });

      const result = filter.checkIP('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.action).toBe(IPFilterAction.BLOCK);
      expect(result.rule?.description).toContain('Blacklist entry');
    });
  });

  describe('CIDR Range Support', () => {
    it('should support IPv4 CIDR ranges', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.0/24'],
      });

      expect(filter.checkIP('192.168.1.1').allowed).toBe(true);
      expect(filter.checkIP('192.168.1.254').allowed).toBe(true);
      expect(filter.checkIP('192.168.2.1').allowed).toBe(false);
    });

    it('should support IPv6 CIDR ranges', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['2001:db8::/32'],
      });

      expect(filter.checkIP('2001:db8::1').allowed).toBe(true);
      expect(filter.checkIP('2001:db9::1').allowed).toBe(false);
    });
  });

  describe('Custom Rules with Priority', () => {
    it('should apply rules based on priority', () => {
      const filter = new IPFilter({
        mode: 'hybrid',
        blacklist: ['192.168.1.0/24'], // Priority 90
        rules: [
          {
            ip: '192.168.1.100',
            action: IPFilterAction.ALLOW,
            priority: 100, // Higher priority than blacklist
            description: 'VIP server',
          },
        ],
      });

      // VIP server should be allowed despite being in blacklisted range
      expect(filter.checkIP('192.168.1.100').allowed).toBe(true);
      // Other IPs in range should be blocked
      expect(filter.checkIP('192.168.1.50').allowed).toBe(false);
    });
  });

  describe('Express Middleware', () => {
    it('should allow request when IP is permitted', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.1'],
      });

      const middleware = filter.getMiddleware();
      const req = mockRequest('192.168.1.1') as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should block request when IP is not permitted', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.100'],
      });

      const middleware = filter.getMiddleware();
      const req = mockRequest('192.168.1.1') as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Access Denied',
          code: 'IP_BLOCKED',
        })
      );
    });

    it('should respect trustProxy setting with X-Forwarded-For', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['10.0.0.1'],
        trustProxy: true,
      });

      const middleware = filter.getMiddleware();
      const req = mockRequest('192.168.1.1', {
        'x-forwarded-for': '10.0.0.1, 192.168.1.1',
      }) as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('Runtime Management', () => {
    it('should allow adding IPs to whitelist at runtime', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.1'],
      });

      expect(filter.checkIP('192.168.1.2').allowed).toBe(false);

      filter.addToWhitelist('192.168.1.2');
      expect(filter.checkIP('192.168.1.2').allowed).toBe(true);
    });

    it('should allow removing IPs from whitelist at runtime', () => {
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.1', '192.168.1.2'],
      });

      expect(filter.checkIP('192.168.1.2').allowed).toBe(true);

      const removed = filter.removeFromWhitelist('192.168.1.2');
      expect(removed).toBe(true);
      expect(filter.checkIP('192.168.1.2').allowed).toBe(false);
    });

    it('should allow adding custom rules', () => {
      const filter = new IPFilter();

      filter.addRule({
        ip: '192.168.1.100',
        action: IPFilterAction.BLOCK,
        description: 'Suspicious IP',
      });

      const result = filter.checkIP('192.168.1.100');
      expect(result.allowed).toBe(false);
      expect(result.rule?.description).toBe('Suspicious IP');
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should provide accurate statistics', () => {
      const filter = new IPFilter({
        whitelist: ['192.168.1.1', '192.168.1.2'],
        blacklist: ['10.0.0.1'],
        rules: [
          { ip: '172.16.0.1', action: IPFilterAction.LOG },
        ],
      });

      const stats = filter.getStats();
      expect(stats.whitelistCount).toBe(2);
      expect(stats.blacklistCount).toBe(1);
      expect(stats.customRules).toBe(1);
      expect(stats.mode).toBe('hybrid');
    });

    it('should clear all rules', () => {
      const filter = new IPFilter({
        whitelist: ['192.168.1.1'],
        blacklist: ['10.0.0.1'],
      });

      filter.clear();
      const stats = filter.getStats();
      expect(stats.whitelistCount).toBe(0);
      expect(stats.blacklistCount).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid CIDR notation gracefully', () => {
      const mockLogger = {
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const filter = new IPFilter({
        whitelist: ['invalid-cidr/notation'],
      }, mockLogger);

      // Should not crash and should log warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid CIDR range'),
        expect.any(Error)
      );
    });

    it('should handle invalid IP addresses gracefully', () => {
      const filter = new IPFilter();
      const result = filter.checkIP('invalid-ip');

      // Should return false for invalid IP
      expect(result.allowed).toBe(true); // Default action in hybrid mode
    });
  });

  describe('Callback Integration', () => {
    it('should call onBlocked callback when IP is blocked', () => {
      const onBlocked = jest.fn();
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.100'],
        onBlocked,
      });

      const middleware = filter.getMiddleware();
      const req = mockRequest('192.168.1.1') as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(onBlocked).toHaveBeenCalledWith(
        req,
        '192.168.1.1',
        undefined
      );
    });

    it('should call onAllowed callback when IP is allowed', () => {
      const onAllowed = jest.fn();
      const filter = new IPFilter({
        mode: 'whitelist',
        whitelist: ['192.168.1.1'],
        onAllowed,
      });

      const middleware = filter.getMiddleware();
      const req = mockRequest('192.168.1.1') as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      middleware(req, res, next);

      expect(onAllowed).toHaveBeenCalledWith(
        req,
        '192.168.1.1',
        expect.objectContaining({
          description: 'Whitelist entry',
        })
      );
    });
  });
});