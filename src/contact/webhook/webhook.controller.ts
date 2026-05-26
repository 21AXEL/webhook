/**
 * webhook.controller.ts
 * Controlador para los endpoints del webhook de WhatsApp.
 * Migrado desde WebhookController.js — instanciación manual reemplazada por DI de NestJS.
 *
 * Rutas expuestas:
 *   GET  /whatsapp/webhook  → Verificación del webhook con Meta
 *   POST /whatsapp/webhook  → Recepción y procesamiento de mensajes
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpCode,
  Logger,
} from "@nestjs/common";
import type { Response } from "express"; // ← Cambiado a "import type"
import { ConfigService } from "@nestjs/config";
import { WebhookService } from "./webhook.service";

@Controller("whatsapp")
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Verificación del webhook — Meta llama a este endpoint al registrar el webhook.
   * Valida el token y responde con el challenge.
   */
  @Get("webhook")
  verifyWebhook(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ): void {
    const verifyToken = this.configService.get<string>(
      "WHATSAPP_TOKEN_WEBHOOBS",
    );

    if (mode && token === verifyToken) {
      this.logger.log("Webhook verificado correctamente");
      res.status(200).send(challenge);
    } else {
      this.logger.warn(
        `Verificación de webhook fallida — token recibido: ${token}`,
      );
      res.sendStatus(403);
    }
  }

  /**
   * Procesamiento del webhook — Meta envía los mensajes a este endpoint.
   * Siempre responde 200 para que Meta no reintente el envío.
   */
  @Post("webhook")
  @HttpCode(200)
  async processWebhook(@Body() body: any): Promise<any> {
    try {
      return await this.webhookService.processWebhook(body);
    } catch (error) {
      // Registrar el error pero responder 200 para evitar reintentos de Meta
      this.logger.error("Error en webhook:", error);
      // Manejar error de tipo unknown correctamente
      const errorMessage =
        error instanceof Error ? error.message : "Error desconocido";
      return { success: false, error: errorMessage };
    }
  }
}
