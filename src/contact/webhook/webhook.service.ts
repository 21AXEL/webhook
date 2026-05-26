/**
 * webhook.service.ts
 * Orquestador principal del webhook de WhatsApp.
 * Migrado desde WebhookService.js — ServiceLocator reemplazado por DI de NestJS.
 */

import { Injectable, Logger } from "@nestjs/common";
import { WhatsAppService } from "./services/whatsapp.service";
import { ConversationService } from "../conversation.service";
import { IntentProcessorService } from "../intent-processor.service";
import { RedisService } from "@shared/modules/redis/redis.service";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly rateLimitMax: number;

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly conversationService: ConversationService,
    private readonly intentProcessor: IntentProcessorService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.rateLimitMax = this.configService.get<number>("RATE_LIMIT_MAX") ?? 10;
  }

  // ─── Punto de entrada del webhook ────────────────────────────────────────────

  /** Procesa el cuerpo completo de un webhook entrante de WhatsApp */
  async processWebhook(webhookBody: any): Promise<{
    success: boolean;
    processed?: number;
    results?: any[];
    message?: string;
    error?: string;
  }> {
    try {
      this.logger.log("Procesando webhook...");

      if (!this.isValidWhatsAppWebhook(webhookBody)) {
        return { success: false, error: "Webhook inválido" };
      }

      const messages =
        await this.whatsAppService.extractMessagesFromWebhook(webhookBody);

      if (!messages?.length) {
        return { success: true, message: "No hay mensajes para procesar" };
      }

      // Procesar cada mensaje de forma secuencial
      const results: any[] = [];
      for (const message of messages) {
        const result = await this.processMessage(message);
        results.push(result);
      }

      return { success: true, processed: results.length, results };
    } catch (error: any) {
      this.logger.error("Error procesando webhook:", error);
      return { success: false, error: error.message };
    }
  }

  /** Procesa un mensaje individual extraído del webhook */
  async processMessage(message: any): Promise<any> {
    const senderId = message.from;
    const messageId = message.id;

    // Detectar canal por el patrón del senderId
    const isWebSession = senderId?.startsWith("web_");

    try {
      // 1. Deduplicación — los mensajes web se saltan esto
      //    (no hay reintentos de Meta para el canal web)
      if (messageId && !isWebSession) {
        const isNew = await this.redisService.markMessageIfNew(messageId);
        if (!isNew) {
          this.logger.warn(`Mensaje duplicado ignorado: ${messageId}`);
          return null;
        }
      }

      // 2. Rate limiting — solo aplicar en canal Meta
      if (!isWebSession) {
        const withinLimit = await this.redisService.checkRateLimit(
          senderId,
          this.rateLimitMax,
        );
        if (!withinLimit) {
          this.logger.warn(`Rate limit alcanzado para: ${senderId}`);
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Estás enviando mensajes muy rápido. Por favor espera un momento.",
          );
          return null;
        }
      }

      const conversation = await this.getOrCreateConversation(
        senderId,
        isWebSession ? "web" : "meta",
      );

      this.logger.log(
        `[${isWebSession ? "WEB" : "META"}] Mensaje tipo: ${message.type} de: ${senderId}`,
      );

      return await this.intentProcessor.processMessage(message, conversation);
    } catch (error: any) {
      this.logger.error(`Error procesando mensaje: ${error.message}`);
      try {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, ocurrió un error al procesar tu mensaje. Por favor intenta de nuevo.",
        );
      } catch (sendError: any) {
        this.logger.error("Error enviando mensaje de error:", sendError);
      }
      return { success: false, error: error.message };
    }
  }

  // ─── Conversación ────────────────────────────────────────────────────────────

  /** Obtiene la conversación activa del remitente o crea una nueva */
  async getOrCreateConversation(
    senderId: string,
    channel: "meta" | "web" = "meta",
  ): Promise<any> {
    let conversation = await this.conversationService.getBySenderId(senderId);

    if (!conversation) {
      conversation = await this.conversationService.create(senderId);
      this.logger.log(
        `Nueva conversación [${channel}] creada para: ${senderId}`,
      );
    }

    // Actualizar el canal si cambió (o si es nuevo registro)
    if (conversation.context?.channel !== channel) {
      await this.conversationService.update(conversation._id, {
        "context.channel": channel,
      });
      conversation.context = { ...conversation.context, channel };
    }

    return conversation;
  }

  // ─── Envío de respuestas ─────────────────────────────────────────────────────

  /** Envía una respuesta a un número de WhatsApp */
  async sendResponse(
    to: string,
    response: string | Record<string, any>,
  ): Promise<any> {
    if (typeof response === "string") {
      return this.whatsAppService.sendTextMessage(to, response);
    }
    return this.whatsAppService.sendResponse(to, response);
  }

  // ─── Validación ──────────────────────────────────────────────────────────────

  /** Valida que el cuerpo del request sea un webhook legítimo de WhatsApp Business  */
  isValidWhatsAppWebhook(body: any): boolean {
    if (!body?.object) return false;
    if (body.object !== "whatsapp_business_account") return false;
    if (!Array.isArray(body.entry) || body.entry.length === 0) return false;
    return true;
  }
}
