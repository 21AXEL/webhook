// Provider que expone el pool de PostgreSQL como dependencia inyectable
import { Pool } from "pg";
import { ConfigService } from "@nestjs/config";

// Token de inyección para el pool — usar en @Inject(PG_POOL)
export const PG_POOL = "PG_POOL";

export const postgresqlProvider = {
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: async (configService: ConfigService): Promise<Pool> => {
    const pool = new Pool({
      host: configService.get<string>("postgresql.host"),
      port: configService.get<number>("postgresql.port"),
      database: configService.get<string>("postgresql.database"),
      user: configService.get<string>("postgresql.user"),
      password: configService.get<string>("postgresql.password"),
      max: configService.get<number>("postgresql.maxConnections"),
      idleTimeoutMillis: configService.get<number>("postgresql.idleTimeoutMs"),
      connectionTimeoutMillis: configService.get<number>(
        "postgresql.connectionTimeoutMs",
      ),
    });

    // Propagación de errores de clientes inactivos del pool
    pool.on("error", (err: Error) => {
      console.error("❌ Error en cliente PostgreSQL del pool:", err.message);
    });

    // Verificación de conectividad al iniciar
    const result = await pool.query<{ server_time: Date }>(
      "SELECT NOW() AS server_time",
    );
    console.log(
      `✅ Conectado a PostgreSQL — Hora del servidor: ${result.rows[0].server_time}`,
    );

    return pool;
  },
};
