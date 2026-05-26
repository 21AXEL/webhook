/**
 * whatsapp.service.ts
 * Servicio de infraestructura para comunicación con la API de WhatsApp Business.
 * Migrado desde WhatsAppService.js — ServiceLocator reemplazado por DI de NestJS.
 */

import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ChatResponseCollector } from "@chat/chat-response-collector.service";
import fetch from "node-fetch";

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  /** URL base de la Graph API de WhatsApp */
  private readonly apiUrl: string | undefined;
  /** Token de acceso a la API */
  private readonly accessToken: string | undefined;
  /** ID del número de teléfono de la empresa */
  private readonly phoneNumberId: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    // @Optional() porque WebhookModule puede arrancar sin ChatCollectorModule en tests
    @Optional() private readonly chatCollector?: ChatResponseCollector,
  ) {
    this.accessToken = this.configService.get<string>("WHATSAPP_ACCESS_TOKEN");
    this.phoneNumberId = this.configService.get<string>(
      "WHATSAPP_PHONE_NUMBER_ID",
    );
    this.apiUrl = `https://graph.facebook.com/v23.0/${this.phoneNumberId}/messages`;
  }

  // ─── Envío base ──────────────────────────────────────────────────────────────

  /** Envía cualquier tipo de mensaje a través de la API de WhatsApp */
  async sendMessage(
    senderId: string,
    messagePayload: Record<string, any>,
  ): Promise<any> {
    // ── Intercepción de Flow para sesiones web ──────────────────────────────
    if (
      this.chatCollector?.isWebSession(senderId) &&
      messagePayload.type === "interactive" &&
      messagePayload.interactive?.type === "flow"
    ) {
      const params = messagePayload.interactive.action?.parameters ?? {};
      const bodyText = messagePayload.interactive.body?.text ?? "";
      this.chatCollector.pushFlow(senderId, {
        flowId: params.flow_id ?? "",
        screenId: params.flow_action_payload?.screen ?? "TICKET_TECNICO",
        bodyText,
      });
      return { captured: true, channel: "web" };
    }

    try {
      const response = await fetch(this.apiUrl ?? "", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: senderId,
          ...messagePayload,
        }),
      });

      const result = (await response.json()) as any;
      if (result.error) {
        this.logger.error(
          `Error de API WhatsApp: ${JSON.stringify(result.error)}`,
        );
        throw new Error(result.error.message);
      }
      return result;
    } catch (error: any) {
      this.logger.error(
        `Error enviando mensaje a ${senderId}: ${error.message}`,
      );
      throw error;
    }
  }

  // ─── Mensajes de texto ───────────────────────────────────────────────────────

  /** Envía un mensaje de texto simple */
  async sendTextMessage(senderId: string, text: string): Promise<any> {
    this.logger.log(`Respuesta: "${text}" → conversación: ${senderId}`);
    if (!senderId) {
      this.logger.warn("senderId no existe, abortando envío");
      return;
    }

    // ── Intercepción para sesiones web ──────────────────────────────────────
    if (this.chatCollector?.isWebSession(senderId)) {
      this.chatCollector.pushText(senderId, text);
      return { captured: true, channel: "web" };
    }

    return this.sendMessage(senderId, { type: "text", text: { body: text } });
  }

  // ─── Mensajes interactivos ───────────────────────────────────────────────────

  /** Envía un mensaje con botones de respuesta rápida */
  async sendButtonMessage(
    senderId: string,
    content: {
      headerText?: string;
      bodyText: string;
      footerText?: string;
      buttons: Array<{ id?: string; text: string }>;
    },
  ): Promise<any> {
    // ── Intercepción para sesiones web ──────────────────────────────────────
    if (this.chatCollector?.isWebSession(senderId)) {
      this.chatCollector.pushButtons(
        senderId,
        content.bodyText,
        content.buttons.map((b, i) => ({
          id: b.id ?? `btn_${i}`,
          text: b.text,
        })),
      );
      return { captured: true, channel: "web" };
    }

    // Limitar a 3 botones (límite de Meta)
    const buttons = content.buttons.slice(0, 3).map((btn, i) => ({
      type: "reply",
      reply: { id: btn.id ?? `btn_${i}`, title: btn.text.substring(0, 20) },
    }));

    const interactive: Record<string, any> = {
      type: "button",
      body: { text: content.bodyText },
      action: { buttons },
    };
    if (content.headerText)
      interactive.header = { type: "text", text: content.headerText };
    if (content.footerText) interactive.footer = { text: content.footerText };

    return this.sendMessage(senderId, { type: "interactive", interactive });
  }

  /** Envía una lista interactiva de opciones */
  async sendListMessage(
    senderId: string,
    content: {
      headerText?: string;
      bodyText: string;
      footerText?: string;
      buttonText: string;
      sections: Array<{
        title: string;
        rows: Array<{ id: string; title: string; description?: string }>;
      }>;
    },
  ): Promise<any> {
    // ── Intercepción para sesiones web ──────────────────────────────────────
    if (this.chatCollector?.isWebSession(senderId)) {
      this.chatCollector.pushList(senderId, content.bodyText, content.sections);
      return { captured: true, channel: "web" };
    }

    const interactive: Record<string, any> = {
      type: "list",
      body: { text: content.bodyText },
      action: { button: content.buttonText, sections: content.sections },
    };
    if (content.headerText)
      interactive.header = { type: "text", text: content.headerText };
    if (content.footerText) interactive.footer = { text: content.footerText };

    return this.sendMessage(senderId, { type: "interactive", interactive });
  }

  /** Envía un botón de solicitud de ubicación */
  async sendLocationButton(senderId: string): Promise<any> {
    const text =
      "Para continuar, necesitamos tu ubicación.\nPor favor, comparte tu ubicación actual.\nEsto nos ayudará a atender tu reporte con mayor precisión.";
    return this.sendMessage(senderId, {
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: { text },
        action: { name: "send_location" },
      },
    });
  }

  // ─── Mensajes multimedia ─────────────────────────────────────────────────────

  /** Envía una imagen */
  async sendImageMessage(
    senderId: string,
    imageUrl: string,
    caption = "",
  ): Promise<any> {
    return this.sendMessage(senderId, {
      type: "image",
      image: { link: imageUrl, caption },
    });
  }

  /** Envía un archivo (documento, video o audio según extensión) */
  async sendFileMessage(
    senderId: string,
    fileUrl: string,
    caption = "",
  ): Promise<any> {
    const ext = fileUrl.split(".").pop()?.toLowerCase() ?? "";
    let fileType = "document";
    if (["mp4", "mov", "avi", "webm"].includes(ext)) fileType = "video";
    else if (["mp3", "ogg", "wav", "opus"].includes(ext)) fileType = "audio";

    return this.sendMessage(senderId, {
      type: fileType,
      [fileType]: { link: fileUrl, caption },
    });
  }

  // ─── Plantillas ──────────────────────────────────────────────────────────────

  /** Envía un mensaje de plantilla aprobada */
  async sendTemplateMessage(
    senderId: string,
    templateName: string,
    components: any[] = [],
    language = "es",
  ): Promise<any> {
    if (!senderId) {
      this.logger.error("senderId no existe:", senderId);
      return;
    }
    this.logger.log(`Enviando plantilla ${templateName} a ${senderId}`);

    const payload = {
      messaging_product: "whatsapp",
      to: senderId,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: components,
      },
    };

    this.logger.debug(`Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(this.apiUrl ?? "", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = (await response.json()) as any;

    if (result.error) {
      this.logger.error(
        `Error de API WhatsApp: ${JSON.stringify(result.error)}`,
      );
      throw new Error(result.error.message);
    }

    return result;
  }

  // ─── Despacho de adjuntos ────────────────────────────────────────────────────

  /** Envía un adjunto según su tipo declarado */
  async sendAttachment(
    senderId: string,
    attachment: { type: string; content: any },
  ): Promise<any> {
    switch (attachment.type) {
      case "text":
        return this.sendTextMessage(senderId, attachment.content.body);
      case "image":
        return this.sendImageMessage(
          senderId,
          attachment.content.url,
          attachment.content.caption,
        );
      case "button":
        return this.sendButtonMessage(senderId, attachment.content);
      case "quick_reply":
        return this.sendButtonMessage(senderId, attachment.content);
      case "location":
        return this.sendLocationButton(senderId);
      case "file":
        return this.sendFileMessage(
          senderId,
          attachment.content.url,
          attachment.content.caption,
        );
      default:
        this.logger.warn(`Tipo de adjunto no soportado: ${attachment.type}`);
        return null;
    }
  }

  /** Despacha una respuesta genérica (texto o adjunto) */
  async sendResponse(
    to: string,
    response: string | Record<string, any>,
  ): Promise<any> {
    if (typeof response === "string") return this.sendTextMessage(to, response);

    if (response.attachments?.length) {
      for (const attachment of response.attachments) {
        await this.sendAttachment(to, attachment);
      }
      return;
    }

    if (response.text) return this.sendTextMessage(to, response.text);
    return this.sendTextMessage(to, JSON.stringify(response));
  }

  // ─── Descarga de medios ──────────────────────────────────────────────────────

  /** Obtiene la URL de descarga de un archivo de media */
  async getMediaUrl(mediaId: string): Promise<string> {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      },
    );
    const data = (await response.json()) as any;
    return data.url;
  }

  /** Descarga el contenido binario de un archivo de media */
  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    return Buffer.from(await response.arrayBuffer());
  }

  // ─── Extracción de webhook ───────────────────────────────────────────────────

  /** Extrae los mensajes individuales de un payload de webhook entrante */
  async extractMessagesFromWebhook(body: any): Promise<any[]> {
    const messages: any[] = [];

    try {
      if (!body?.entry || !Array.isArray(body.entry)) {
        this.logger.warn("Webhook sin estructura entry válida");
        return messages;
      }

      for (const entry of body.entry) {
        if (!Array.isArray(entry.changes)) continue;
        for (const change of entry.changes) {
          if (!Array.isArray(change.value?.messages)) continue;
          for (const message of change.value.messages) {
            if (message?.from) messages.push(message);
          }
        }
      }

      this.logger.log(`Extraídos ${messages.length} mensajes del webhook`);
    } catch (error: any) {
      this.logger.error(
        `Error extrayendo mensajes del webhook: ${error.message}`,
      );
    }

    return messages;
  }
}
