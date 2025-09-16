import { RoundRobinLoadBalancer } from '../../src/load-balancer/round-robin.js';
import { ServerConfig } from '../../src/types/index.js';

// Mock fetch for health checks
global.fetch = jest.fn();

describe('RoundRobinLoadBalancer', () => {
  let loadBalancer: RoundRobinLoadBalancer;
  let servers: ServerConfig[];

  beforeEach(() => {
    servers = [
      { host: 'server1.example.com', port: 8080, protocol: 'http' },
      { host: 'server2.example.com', port: 8080, protocol: 'http' },
      { host: 'server3.example.com', port: 8080, protocol: 'https' },
    ];

    // Mock fetch to return successful health checks
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });
  });

  afterEach(() => {
    if (loadBalancer) {
      loadBalancer.destroy();
    }
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with servers', () => {
      loadBalancer = new RoundRobinLoadBalancer(servers, { enabled: false });
      expect(loadBalancer.getHealthyServers()).toHaveLength(3);
    });

    it('should throw error with empty server list', () => {
      expect(() => {
        new RoundRobinLoadBalancer([]);
      }).toThrow('At least one server must be configured');
    });

    it('should start health checks when enabled', () => {
      loadBalancer = new RoundRobinLoadBalancer(servers, {
        enabled: true,
        interval: 1000,
      });

      // Wait a bit for initial health checks
      return new Promise(resolve => setTimeout(resolve, 100)).then(() => {
        expect(fetch).toHaveBeenCalled();
      });
    });
  });

  describe('round robin selection', () => {
    beforeEach(() => {
      loadBalancer = new RoundRobinLoadBalancer(servers, { enabled: false });
    });

    it('should select servers in round robin fashion', () => {
      const selections = [];
      for (let i = 0; i < 6; i++) {
        const server = loadBalancer.getNextServer();
        selections.push(`${server?.host}:${server?.port}`);
      }

      expect(selections).toEqual([
        'server1.example.com:8080',
        'server2.example.com:8080',
        'server3.example.com:8080',
        'server1.example.com:8080',
        'server2.example.com:8080',
        'server3.example.com:8080',
      ]);
    });

    it('should return null when no healthy servers available', () => {
      // Mark all servers as unhealthy
      servers.forEach(server => {
        const health = loadBalancer.getServerHealth(server);
        if (health) {
          health.healthy = false;
        }
      });

      const server = loadBalancer.getNextServer();
      expect(server).toBeNull();
    });
  });

  describe('server health tracking', () => {
    beforeEach(() => {
      loadBalancer = new RoundRobinLoadBalancer(servers, { enabled: false });
    });

    it('should initialize all servers as healthy', () => {
      servers.forEach(server => {
        const health = loadBalancer.getServerHealth(server);
        expect(health?.healthy).toBe(true);
      });
    });

    it('should only return healthy servers', () => {
      // Mark one server as unhealthy
      const health = loadBalancer.getServerHealth(servers[1]);
      if (health) {
        health.healthy = false;
      }

      const healthyServers = loadBalancer.getHealthyServers();
      expect(healthyServers).toHaveLength(2);
      expect(healthyServers.map(s => s.host)).toEqual([
        'server1.example.com',
        'server3.example.com',
      ]);
    });
  });

  describe('health checks', () => {
    beforeEach(() => {
      loadBalancer = new RoundRobinLoadBalancer(servers, {
        enabled: true,
        endpoint: '/health',
        timeout: 5000,
      });
    });

    it('should perform health checks', async () => {
      await loadBalancer.checkServerHealth(servers[0]);

      expect(fetch).toHaveBeenCalledWith(
        'http://server1.example.com:8080/health',
        expect.objectContaining({
          method: 'GET',
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should mark servers unhealthy on failed health checks', async () => {
      (fetch as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      const result = await loadBalancer.checkServerHealth(servers[0]);
      const health = loadBalancer.getServerHealth(servers[0]);

      expect(result).toBe(false);
      expect(health?.healthy).toBe(false);
      expect(health?.consecutiveFailures).toBe(1);
    });

    it('should mark servers healthy on successful health checks', async () => {
      // Get initial health state
      const initialHealth = loadBalancer.getServerHealth(servers[0]);
      const initialSuccesses = initialHealth?.consecutiveSuccesses || 0;

      const result = await loadBalancer.checkServerHealth(servers[0]);
      const health = loadBalancer.getServerHealth(servers[0]);

      expect(result).toBe(true);
      expect(health?.healthy).toBe(true);
      expect(health?.consecutiveSuccesses).toBe(initialSuccesses + 1);
    });
  });

  describe('statistics tracking', () => {
    beforeEach(() => {
      loadBalancer = new RoundRobinLoadBalancer(servers, { enabled: false });
    });

    it('should track request statistics', () => {
      const server = servers[0];

      loadBalancer.recordRequest(server, true, 150);
      loadBalancer.recordRequest(server, false, 300);
      loadBalancer.recordRequest(server, true, 100);

      const stats = loadBalancer.getStats();
      expect(stats.totalRequests).toBe(3);
      expect(stats.totalErrors).toBe(1);

      const protocol = server.protocol || 'http';
      const serverKey = `${protocol}://${server.host}:${server.port}`;
      const serverStats = stats.serverStats.get(serverKey);
      expect(serverStats?.requests).toBe(3);
      expect(serverStats?.errors).toBe(1);
      expect(serverStats?.averageResponseTime).toBe((150 + 300 + 100) / 3);
    });

    it('should initialize server stats correctly', () => {
      const stats = loadBalancer.getStats();
      expect(stats.serverStats.size).toBe(3);

      servers.forEach(server => {
        const protocol = server.protocol || 'http';
        const serverKey = `${protocol}://${server.host}:${server.port}`;
        const serverStats = stats.serverStats.get(serverKey);
        expect(serverStats?.requests).toBe(0);
        expect(serverStats?.errors).toBe(0);
      });
    });
  });

  describe('destroy', () => {
    it('should clean up health check intervals', () => {
      loadBalancer = new RoundRobinLoadBalancer(servers, {
        enabled: true,
        interval: 1000,
      });

      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      loadBalancer.destroy();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
    });
  });
});