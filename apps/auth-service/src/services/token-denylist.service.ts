import Redis from "ioredis";
import { env } from "../config/env";

type RedisClient = Pick<Redis, "set">;

const globalForRedis = globalThis as { authRedis?: RedisClient };

const createRedisClient = (): RedisClient => new Redis(env.REDIS_URL);

const redisClient = globalForRedis.authRedis ?? createRedisClient();

if (process.env.NODE_ENV !== "production") {
	globalForRedis.authRedis = redisClient;
}

export class TokenDenylistService {
	private readonly redis: RedisClient;

	constructor(redis: RedisClient = redisClient) {
		this.redis = redis;
	}

	async denylistTokenJti(jti: string, ttlSeconds: number): Promise<void> {
		await this.redis.set(`denylist:${jti}`, "1", "EX", ttlSeconds);
	}
}
