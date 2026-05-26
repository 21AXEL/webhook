/**
 * app.module.ts
 * Módulo raíz de la aplicación NestJS.
 * Configura: variables de entorno, conexión MongoDB y módulos de dominio.
 */

import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { ContactModule } from "./contact/contact.module";
import { UserModule } from "./shared/modules/user/user.module";
import { ScheduleModule } from "@nestjs/schedule";
import { JobsModule } from "./jobs/jobs.module";
import { AdminModule } from "./admin/admin.module";
import { ChatModule } from "./chat/chat.module";
import { ChatCollectorModule } from "./chat/chat-collector.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [
    // ─── Variables de entorno ─────────────────────────────────────────────────
    // Carga el archivo .env automáticamente y lo hace disponible globalmente
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),

    // ─── Scheduler (habilita @Cron, @Interval, @Timeout) ─────────────────────
    ScheduleModule.forRoot(),

    // ─── MongoDB (Mongoose) ───────────────────────────────────────────────────
    // Conexión asíncrona usando ConfigService para leer MONGODB_URI desde .env
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>("MONGODB_URI"),
      }),
    }),

    // ─── Módulos de dominio ───────────────────────────────────────────────────
    UserModule,
    ContactModule,
    JobsModule,
    AdminModule,
    ChatCollectorModule,
    ChatModule,
    HealthModule,
  ],
})
export class AppModule {}
