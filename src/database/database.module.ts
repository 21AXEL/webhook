// Módulo que unifica las conexiones a MongoDB y PostgreSQL
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { postgresqlProvider, PG_POOL } from "./postgresql.provider";

@Module({
  imports: [
    // Conexión a MongoDB — usa la URI del ConfigService
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>("mongodb.uri"),
        // Reconexión automática ante caídas
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
      }),
    }),
  ],
  providers: [postgresqlProvider],
  // Exporta el pool para que otros módulos lo inyecten con @Inject(PG_POOL)
  exports: [PG_POOL],
})
export class DatabaseModule {}
