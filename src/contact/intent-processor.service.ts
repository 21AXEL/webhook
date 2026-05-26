/**
 * intent-processor.service.ts
 * Enrutador de intenciones y estados para mensajes de WhatsApp.
 * Migrado desde IntentProcessor.js — ServiceLocator reemplazado por DI de NestJS.
 * Los UseCases se inyectan mediante forwardRef para evitar dependencias circulares.
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "./conversation.service";
import { WhatsAppService } from "./webhook/services/whatsapp.service";
import { AiService } from "./webhook/services/ai.service";
import { _extractMessageText } from "@shared/utils/extractor-message";

/** Contrato mínimo que debe cumplir cualquier UseCase */
export interface IUseCase {
  execute(conversation: any, message: any): Promise<any>;
}

@Injectable()
export class IntentProcessorService {
  private readonly logger = new Logger(IntentProcessorService.name);

  /** Mapa estado → UseCase (para conversaciones en curso) */
  private readonly stateUseCases = new Map<string, IUseCase>();

  /** Mapa intención → UseCase (para mensajes nuevos) */
  private readonly intentMappings = new Map<string, IUseCase>();

  /** Palabras clave que fuerzan el retorno al menú principal */
  private readonly exitKeywords = [
    "salir",
    "cancelar",
    "terminar",
    "cambiar",
    "otro tema",
    "otra cosa",
    "volver",
    "inicio",
    "menu",
    "menu principal",
  ];

  /** Intenciones que siempre provocan cambio de contexto */
  private readonly forceSwitchIntents = [
    "create_emergency",
    "help",
    "system_info",
  ];

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
  ) {}

  // ─── Registro de casos de uso ────────────────────────────────────────────────

  /** Registra un UseCase para un estado específico de la conversación */
  registerUseCase(state: string, useCase: IUseCase): void {
    this.stateUseCases.set(state, useCase);
    this.logger.debug(`UseCase registrado para estado: "${state}"`);
  }

  /** Registra un UseCase para una intención detectada */
  registerIntentMapping(intent: string, useCase: IUseCase): void {
    this.intentMappings.set(intent, useCase);
    this.logger.debug(`UseCase registrado para intención: "${intent}"`);
  }

  // ─── Procesamiento principal ─────────────────────────────────────────────────

  /** Punto de entrada para procesar un mensaje de WhatsApp */
  async processMessage(message: any, conversation: any): Promise<any> {
    try {
      const senderId = message.from;
      const messageType = message.type;

      this.logger.log(
        `Procesando mensaje tipo: ${messageType} de: ${senderId}`,
      );

      // 1. Si el mensaje es multimedia, delegar al UseCase de media
      if (this._isMediaMessage(messageType)) {
        return this._handleMediaMessage(message, conversation);
      }

      // ── NUEVO: 1.5a — Template quick_reply (type: "button") → ruta directa sin IA ──
      /*if (messageType === "button") {
        const payload: string = message.button?.payload ?? "";
        if (payload.startsWith("consent_")) {
          this.logger.log(
            `Template button consent recibido: "${payload}" de ${senderId}`,
          );
          const useCase = this.intentMappings.get("agent_consent_pending");
          if (useCase) return useCase.execute(conversation, message);
        }
        // Otros prefijos de template (ej: availability_) se pueden agregar aquí
        this.logger.warn(
          `Template button sin handler: "${payload}" — ignorado`,
        );
        return { success: false, reason: "template_button_unhandled" };
      }*/
      // ────────────────────────────────────────────────────────────────────────────────

      // En processMessage, entre el bloque de multimedia (paso 1) y el de estado activo (paso 2):

      // 1.5 — Mensajes interactivos con prefijo conocido → ruta directa sin IA
      if (messageType === "interactive") {
        const directIntent = this._resolveIntentFromInteractive(message);
        if (directIntent) {
          const useCase =
            this.intentMappings.get(directIntent) ??
            this.intentMappings.get("free_text");
          if (useCase) return useCase.execute(conversation, message);
        }
      }

      // 2. Verificar si hay un UseCase activo para el estado actual
      const currentState = conversation.state;
      if (currentState && currentState !== "initial") {
        const stateUseCase = this.stateUseCases.get(currentState);
        if (stateUseCase) {
          // Verificar si el usuario quiere salir del flujo actual
          const text = _extractMessageText(message);
          if (this._isExitKeyword(text)) {
            return this._handleExit(senderId, conversation);
          }
          return stateUseCase.execute(conversation, message);
        }
      }

      // 3. Detectar intención con IA y enrutar al UseCase correspondiente
      const intent = await this._detectIntent(message, conversation);
      this.logger.log(`Intención detectada: ${intent} para ${senderId}`);

      // Forzar cambio de contexto si es una intención prioritaria
      if (this.forceSwitchIntents.includes(intent)) {
        await this.conversationService.updateState(
          conversation._id,
          intent,
          currentState,
        );
      }

      const intentUseCase =
        this.intentMappings.get(intent) ?? this.intentMappings.get("free_text");

      if (!intentUseCase) {
        this.logger.warn(`No hay UseCase registrado para intención: ${intent}`);
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No pude entender tu solicitud. ¿Puedo ayudarte con algo más?",
        );
        return {
          success: false,
          error: `Sin UseCase para intención: ${intent}`,
        };
      }

      return intentUseCase.execute(conversation, message);
    } catch (error: any) {
      this.logger.error(`Error procesando mensaje: ${error.message}`);
      throw error;
    }
  }

  // ─── Helpers privados ────────────────────────────────────────────────────────

  /** Resuelve la intención directamente desde el ID del botón/lista sin pasar por IA */
  private _resolveIntentFromInteractive(message: any): string | null {
    // ── nfm_reply (respuesta de WhatsApp Flow) ──────────────────────────────
    if (message.interactive?.type === "nfm_reply") {
      const flowToken: string =
        message.interactive?.nfm_reply?.flow_token ?? "";
      if (flowToken.startsWith("avail_")) return "availability_flow";
      if (flowToken.startsWith("ticket_")) return "create_ticket";
      if (flowToken.startsWith("incident_")) return "create_incident"; // ← NUEVO
    }

    const buttonId =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      "";

    if (!buttonId) return null;

    // El prefijo es todo lo que está antes del primer "_"
    // Ej: "tcuc_own" → "tcuc", "icuc_confirm_yes" → "icuc"
    const prefix = buttonId.split("_")[0];

    const prefixMap: Record<string, string> = {
      tcuc: "create_ticket",
      icuc: "create_incident",
      iluc: "list_incidents",
      ecuc: "create_emergency",
      kcuc: "create_knowledge",
      kauc: "approve_knowledge",
      kuuc: "update_knowledge",
      kquc: "knowledge_query",
      ksuc: "knowledge_search",
      mpuc: "process_media",
      siuc: "system_info",
      huc: "help",
      uruc: "register_user",
      mgmt: "manage_tickets",
      ltuc: "list_my_tickets",
    };

    return prefixMap[prefix] ?? null;
  }

  /** Determina si el mensaje contiene contenido multimedia */
  private _isMediaMessage(type: string): boolean {
    return ["image", "document", "audio", "video", "location"].includes(type);
  }

  /** Delega un mensaje multimedia al UseCase de procesamiento de media */
  private async _handleMediaMessage(
    message: any,
    conversation: any,
  ): Promise<any> {
    const mediaUseCase =
      this.intentMappings.get("process_media") ??
      this.stateUseCases.get("processing_media");

    if (!mediaUseCase) {
      this.logger.warn("No hay UseCase registrado para procesar multimedia");
      return { success: false, error: "Sin UseCase de media" };
    }

    return mediaUseCase.execute(conversation, message);
  }

  /** Detecta la intención del mensaje usando el servicio de IA */
  private async _detectIntent(
    message: any,
    conversation: any,
  ): Promise<string> {
    try {
      const text = _extractMessageText(message);
      const history = conversation.formatHistoryForAI?.() ?? [];
      return this.aiService.detectIntent(text, history, conversation.state);
    } catch (error: any) {
      this.logger.error(`Error detectando intención: ${error.message}`);
      return "free_text";
    }
  }

  /** Maneja el caso en que el usuario quiere salir del flujo actual */
  private async _handleExit(senderId: string, conversation: any): Promise<any> {
    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    await this.whatsAppService.sendTextMessage(
      senderId,
      "¿En qué más puedo ayudarte?",
    );
    return {
      success: true,
      message: "Flujo cancelado por el usuario",
      nextState: "initial",
    };
  }

  /** Verifica si el texto es una palabra clave de salida */
  private _isExitKeyword(text: string): boolean {
    return this.exitKeywords.includes(text?.toLowerCase()?.trim() ?? "");
  }
}
