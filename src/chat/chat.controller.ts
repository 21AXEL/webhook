/**
 * chat.controller.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoint REST para el widget de chat web.
 *
 * Ruta: POST /api/chat/message
 *
 * Adapta el mensaje del widget al formato de webhook de WhatsApp y lo inyecta
 * en el mismo WebhookService que procesa los mensajes de WhatsApp real.
 * Las respuestas se capturan via ChatResponseCollector en lugar de enviarse a Meta.
 *
 * Body esperado:
 * {
 *   "message": "texto del usuario",
 *   "sessionId": "web_abc123",     ← identificador único de sesión del widget
 *   "channel": "web"               ← siempre "web" para el widget
 * }
 *
 * Respuesta:
 * {
 *   "text": "respuesta del bot",
 *   "quickReplies": ["opción 1", "opción 2"],
 *   "messages": [...]              ← todos los mensajes si el bot envió varios
 * }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Controller,
  Post,
  Body,
  HttpCode,
  Logger,
  BadRequestException,
} from "@nestjs/common";
import { WebhookService } from "@contact/webhook/webhook.service";
import { ChatResponseCollector } from "./chat-response-collector.service";

// Reemplazar la interfaz ChatMessageDto:
interface ChatMessageDto {
  message: string;
  sessionId: string;
  channel?: "web";
  userInfo?: {
    // ← nuevo (opcional)
    email?: string;
    nombre?: string;
    cedula?: string;
    token?: string;
  };
}

@Controller("chat")
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly collector: ChatResponseCollector,
  ) {}

  /**
   * POST /api/chat/message
   * Punto de entrada del widget web.
   */
  @Post("message")
  @HttpCode(200)
  async handleWebMessage(@Body() body: ChatMessageDto): Promise<object> {
    const { message, sessionId } = body;

    if (!message?.trim()) throw new BadRequestException("message requerido");
    if (!sessionId?.trim())
      throw new BadRequestException("sessionId requerido");

    this.logger.log(`[WEB] ${sessionId}: "${message}"`);

    // 1. Registrar el colector PRIMERO — antes de cualquier processWebhook
    //    Si se registra después, la primera llamada va directo a la API de WhatsApp
    this.collector.startSession(sessionId);

    // 2. Procesar el mensaje una sola vez, distinguiendo flow vs texto plano
    const FLOW_PREFIX = "__flow_complete__:";
    try {
      if (message.startsWith(FLOW_PREFIX)) {
        // "__flow_complete__:TICKET_TECNICO:{...json...}"
        const rest = message.slice(FLOW_PREFIX.length);
        const colon = rest.indexOf(":");
        const flowId = rest.slice(0, colon);
        const jsonPart = rest.slice(colon + 1);

        await this.webhookService.processWebhook(
          this._buildNfmReplyPayload(sessionId, flowId, jsonPart),
        );
      } else {
        await this.webhookService.processWebhook(
          this._buildWebhookPayload(sessionId, message, body.userInfo?.nombre),
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `Error procesando mensaje web: ${(err as Error).message}`,
      );
    }

    // 3. Leer los mensajes acumulados por el colector
    const messages = this.collector.flushSession(sessionId);

    if (messages.length === 0) {
      return {
        text: "No pude procesar tu mensaje. Por favor intenta de nuevo.",
        quickReplies: [],
        messages: [],
      };
    }

    // Combinar mensajes: si hay varios, concatenar texto; quickReplies del último que los tenga
    const combinedText = messages
      .map((m) => m.text ?? "")
      .filter(Boolean)
      .join("\n\n");
    const lastWithQRs = [...messages]
      .reverse()
      .find((m) => m.quickReplies?.length);

    const flowMsg = messages.find((m) => m.type === "flow");

    return {
      text: combinedText,
      quickReplies: lastWithQRs?.quickReplies ?? [],
      messages,
      flow: flowMsg
        ? { flowId: flowMsg.flowId, screenId: flowMsg.screenId }
        : null,
    };
  }

  // ─── Adapter ──────────────────────────────────────────────────────────────

  /**
   * Construye un payload que imita exactamente la estructura que Meta envía
   * al webhook. El sessionId se usa como "from" (senderId).
   * ConversationService lo usará como clave de conversación.
   */
  // En _buildWebhookPayload(), pasar el nombre del usuario si viene:
  private _buildWebhookPayload(
    sessionId: string,
    text: string,
    userName?: string,
  ): object {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WEB_CHAT_ACCOUNT",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "WEB",
                  phone_number_id: "WEB_CHAT",
                },
                contacts: [
                  {
                    profile: { name: userName ?? "Usuario Web" },
                    wa_id: sessionId,
                  },
                ],
                messages: [
                  {
                    from: sessionId,
                    id: `web_msg_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: text },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  /**
   * Construye un payload que imita el nfm_reply que Meta envía
   * cuando el usuario completa un WhatsApp Flow.
   * El widget lo envía como "__flow_complete__:SCREEN_ID:{json}"
   */
  private _buildNfmReplyPayload(
    sessionId: string,
    flowId: string,
    responseJson: string,
  ): object {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WEB_CHAT_ACCOUNT",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "WEB",
                  phone_number_id: "WEB_CHAT",
                },
                contacts: [
                  { profile: { name: "Usuario Web" }, wa_id: sessionId },
                ],
                messages: [
                  {
                    from: sessionId,
                    id: `web_flow_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "interactive",
                    interactive: {
                      type: "nfm_reply",
                      nfm_reply: {
                        name: "flow",
                        flow_token: `ticket_${sessionId}_${Date.now()}`,
                        response_json: responseJson, // ← JSON puro del form
                      },
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };
  }
}
