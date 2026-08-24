import Redis from "ioredis";

type RedisClient = Pick<Redis, "get" | "set">;

const globalForRedis = globalThis as { authRedis?: RedisClient };

const createRedisClient = (): RedisClient => {
	const redisUrl = process.env.REDIS_URL;
	if (!redisUrl) {
		throw new Error("REDIS_URL is required");
	}

	return new Redis(redisUrl);
};

export class TokenDenylistService {
	private readonly redis: RedisClient;

	constructor(redis?: RedisClient) {
		if (redis) {
			this.redis = redis;
			return;
		}

		const cachedRedisClient = globalForRedis.authRedis;
		if (cachedRedisClient) {
			this.redis = cachedRedisClient;
			return;
		}

		const createdRedisClient = createRedisClient();
		if (process.env.NODE_ENV !== "production") {
			globalForRedis.authRedis = createdRedisClient;
		}

		this.redis = createdRedisClient;
	}

	async denylistTokenJti(jti: string, ttlSeconds: number): Promise<void> {
		await this.redis.set(`denylist:${jti}`, "1", "EX", ttlSeconds);
	}

	async isTokenJtiDenylisted(jti: string): Promise<boolean> {
		const value = await this.redis.get(`denylist:${jti}`);

		return value !== null;
	}
}
