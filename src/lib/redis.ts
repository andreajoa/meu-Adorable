import { Redis } from '@upstash/redis'

// Configuração Upstash (REST API - mais estável)
const upstashConfig = {
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
}

// Cliente principal
export const redis = process.env.UPSTASH_REDIS_REST_URL 
  ? new Redis(upstashConfig)
  : new MockRedis()

// Publisher (mesmo cliente para Upstash REST)
export const redisPublisher = process.env.UPSTASH_REDIS_REST_URL 
  ? new Redis(upstashConfig)  
  : new MockRedis()

// Mock para desenvolvimento local
class MockRedis {
  private data = new Map()
  
  async get(key: string) {
    return this.data.get(key) || null
  }
  
  async set(key: string, value: any, options?: any) {
    this.data.set(key, value)
    return 'OK'
  }
  
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0
  }
  
  async exists(key: string) {
    return this.data.has(key) ? 1 : 0
  }
  
  async publish(channel: string, message: string) {
    console.log(`Mock publish to ${channel}:`, message)
    return 1
  }
  
  async subscribe(channel: string) {
    console.log(`Mock subscribe to ${channel}`)
    return { unsubscribe: () => {} }
  }
}

export default redis
