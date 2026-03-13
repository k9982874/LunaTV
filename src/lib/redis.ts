// lib/redis.js
import Redis from "ioredis";

// Connect to your Redis instance using the connection string from environment variables
const redis = new Redis(process.env.REDIS_URL! as string);

// Handle connection errors
redis.on("error", (err) => console.error("Redis Client Error", err));

export default redis;

export const CACHE_KEY_PREFIX = process.env.CACHE_KEY_PREFIX || "lunatv";

export function getCacheKey(key: string, ...params: string[]): string {
  return [CACHE_KEY_PREFIX, key, ...params].join(":");
}
