import { Redis } from '@upstash/redis';

// Configuração Upstash (REST API - mais estável)
const upstashConfig = {
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
};

// Mock para desenvolvimento local
class MockRedis {
  private data = new Map();
  private subscribers = new Map<string, ((message: string) => void)[]>();
  
  async get(key: string) {
    return this.data.get(key) || null;
  }
  
  async set(key: string, value: any, options?: any) {
    this.data.set(key, value);
    if (options?.EX) {
      // Simula TTL removendo depois do tempo especificado
      setTimeout(() => this.data.delete(key), options.EX * 1000);
    }
    return 'OK';
  }
  
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
  
  async exists(key: string) {
    return this.data.has(key) ? 1 : 0;
  }
  
  async publish(channel: string, message: string) {
    console.log(`Mock publish to ${channel}:`, message);
    const callbacks = this.subscribers.get(channel) || [];
    callbacks.forEach(callback => {
      try {
        callback(message);
      } catch (error) {
        console.error('Mock subscriber error:', error);
      }
    });
    return callbacks.length;
  }
  
  subscribe(channel: string, callback: (message: string) => void) {
    console.log(`Mock subscribe to ${channel}`);
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, []);
    }
    this.subscribers.get(channel)!.push(callback);
    
    return () => {
      const callbacks = this.subscribers.get(channel) || [];
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    };
  }
}

// Enhanced RedisPublisher para compatibilidade com streams
class RedisPublisher {
  private client: Redis | MockRedis;
  
  constructor(client: Redis | MockRedis) {
    this.client = client;
  }

  async publish(channel: string, message: string) {
    try {
      if (this.client instanceof MockRedis) {
        return await this.client.publish(channel, message);
      }
      
      // Para Upstash REST, usamos padrão de mensagem + timestamp
      await this.client.set(`channel:${channel}:latest`, message, { EX: 60 });
      await this.client.set(`channel:${channel}:timestamp`, Date.now().toString(), { EX: 60 });
      return 1;
    } catch (error) {
      console.error('Error publishing message:', error);
      return 0;
    }
  }

  subscribe(channel: string, callback: (message: string) => void) {
    if (this.client instanceof MockRedis) {
      return this.client.subscribe(channel, callback);
    }
    
    // Para Upstash REST, implementamos polling
    let lastTimestamp = 0;
    const pollInterval = setInterval(async () => {
      try {
        const timestampStr = await this.client.get(`channel:${channel}:timestamp`);
        const timestamp = timestampStr ? parseInt(timestampStr as string) : 0;
        
        if (timestamp > lastTimestamp) {
          const message = await this.client.get(`channel:${channel}:latest`);
          if (message) {
            callback(message as string);
            lastTimestamp = timestamp;
          }
        }
      } catch (error) {
        console.error('Error polling Redis:', error);
      }
    }, 500); // Poll a cada 500ms para melhor responsividade

    // Retorna função para cancelar o polling
    return () => clearInterval(pollInterval);
  }

  async set(key: string, value: string, options?: { EX?: number }) {
    try {
      return await this.client.set(key, value, options);
    } catch (error) {
      console.error('Error setting key:', error);
      return null;
    }
  }

  async get(key: string) {
    try {
      return await this.client.get(key);
    } catch (error) {
      console.error('Error getting key:', error);
      return null;
    }
  }

  async del(key: string) {
    try {
      return await this.client.del(key);
    } catch (error) {
      console.error('Error deleting key:', error);
      return 0;
    }
  }
}

// Cliente principal
export const redis = process.env.UPSTASH_REDIS_REST_URL 
  ? new Redis(upstashConfig)
  : new MockRedis();

// Publisher (versão enhanced)
export const redisPublisher = new RedisPublisher(redis);

export default redis;
