import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>("REDIS_HOST") ?? "localhost",
      port: this.configService.get<number>("REDIS_PORT") ?? 6379,
      password: this.configService.get<string>("REDIS_PASSWORD"),
      lazyConnect: false,
      enableOfflineQueue: false,
    });

    this.client.on("connect", () => this.logger.log("✅ Redis conectado"));
    this.client.on("error", (err) =>
      this.logger.error(`Redis error: ${err.message}`),
    );
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }

  /**
   * Marca un mensaje como visto. Retorna true si es la primera vez,
   * false si ya fue procesado (duplicado).
   * TTL de 5 minutos es suficiente para cubrir el periodo de reintentos de Meta.
   */
  async markMessageIfNew(
    messageId: string,
    ttlSeconds = 300,
  ): Promise<boolean> {
    const key = `whatsapp:msg:${messageId}`;
    // SET key 1 EX ttl NX → retorna "OK" si se creó, null si ya existía
    const result = await this.client.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  /**
   * Rate limiting por remitente usando ventana deslizante simple.
   * Retorna true si el remitente está dentro del límite, false si lo superó.
   */
  async checkRateLimit(
    senderId: string,
    maxPerMinute: number,
  ): Promise<boolean> {
    const key = `whatsapp:rate:${senderId}`;
    const count = await this.client.incr(key);
    if (count === 1) await this.client.expire(key, 60);
    return count <= maxPerMinute;
  }
}
