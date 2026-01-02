// lib/redis.js
import Redis from 'ioredis';

// Connect to your Redis instance using the connection string from environment variables
const redis = new Redis(process.env.REDIS_URL! as string);

// Handle connection errors
redis.on(
  'error',
  (err) =>
    console.error('Redis Client Error', err),
);

export default redis;
