/**
 * main.ts
 * Punto de entrada de la aplicación NestJS.
 */

import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import * as path from "path";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // CORS — permite fetch cross-origin desde el widget embebido en otros sitios
  app.enableCors();

  // Sirve src/chat/ como assets estáticos en /chat-ui/
  // Ej: GET /chat-ui/helpdesk_tis_chat_widget.html
  app.useStaticAssets(path.join(process.cwd(), "src", "chat"), {
    prefix: "/chat-ui",
  });

  // Prefijo global de la API
  app.setGlobalPrefix("api");

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  console.log(`🚀 Servidor WhatsApp webhook iniciado en el puerto ${port}`);
}

bootstrap();
