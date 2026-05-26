/**
 * incident-flow.use-case.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Use case para el registro de incidentes ciudadanos via WhatsApp Flow.
 *
 * Responsabilidades:
 *   1. Enviar el Flow al ciudadano (entra por intención "create_incident").
 *   2. Procesar la respuesta nfm_reply cuando el ciudadano completa el formulario.
 *   3. Crear el incidente en MongoDB y confirmar por WhatsApp.
 *
 * Estado de conversación:
 *   initial / create_incident  →  envía el Flow  →  estado: "incident_awaiting_flow"
 *   incident_awaiting_flow     →  llega nfm_reply →  crea incidente  →  estado: "initial"
 *
 * Variable de entorno:
 *   INCIDENT_FLOW_ID  →  Flow ID generado por Meta Business Manager
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { ConversationService } from "@contact/conversation.service";
import { WhatsAppService } from "@contact/webhook/services/whatsapp.service";
import { IncidentService } from "@shared/modules/incident/incident.service";
import { USER_MODEL, UserDocument } from "@shared/modules/user/user.schema";

@Injectable()
export class IncidentFlowUseCase {
  private readonly logger = new Logger(IncidentFlowUseCase.name);

  constructor(
    @InjectModel(USER_MODEL)
    private readonly userModel: Model<UserDocument>,
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly incidentService: IncidentService,
    private readonly configService: ConfigService,
  ) {}

  // ─── IUseCase ────────────────────────────────────────────────────────────────

  async execute(conversation: any, message: any): Promise<any> {
    const isFlowResponse =
      message?.type === "interactive" &&
      message?.interactive?.type === "nfm_reply" &&
      (message?.interactive?.nfm_reply?.flow_token ?? "").startsWith(
        "incident_",
      );

    if (isFlowResponse) {
      return this._processFlowResponse(conversation, message);
    }

    // Si el estado ya es incident_awaiting_flow pero NO llegó nfm_reply
    // (ej: usuario mandó texto mientras el flow estaba abierto) → ignorar
    if (conversation.state === "incident_awaiting_flow" && !isFlowResponse) {
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Por favor completa el formulario que te enviamos para registrar tu reporte.",
      );
      return { success: true };
    }

    return this._sendFlow(conversation);
  }

  // ─── Envío del Flow ───────────────────────────────────────────────────────────

  private async _sendFlow(conversation: any): Promise<any> {
    const senderId = conversation.senderId;
    const flowId = this.configService.get<string>("INCIDENT_FLOW_ID") ?? "";

    if (!flowId) {
      this.logger.error("INCIDENT_FLOW_ID no configurado en .env");
      await this.whatsAppService.sendTextMessage(
        senderId,
        "El formulario de reportes no está disponible en este momento. Intenta más tarde.",
      );
      return { success: false, reason: "INCIDENT_FLOW_ID not set" };
    }

    await this.whatsAppService.sendMessage(senderId, {
      type: "interactive",
      interactive: {
        type: "flow",
        header: {
          type: "text",
          text: "📋 Registro de incidente",
        },
        body: {
          text: "Completa el formulario para registrar tu reporte ciudadano ante el Municipio de Esmeraldas.",
        },
        footer: {
          text: "Municipio de Esmeraldas — Esmeraldas La Bella",
        },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: flowId,
            flow_cta: "📝 Registrar reporte",
            flow_token: `incident_${senderId}_${Date.now()}`,
            flow_action: "navigate",
            flow_action_payload: {
              screen: "USER_LOOKUP",
            },
          },
        },
      },
    });

    await this.conversationService.updateState(
      conversation._id,
      "incident_awaiting_flow",
      conversation.state,
    );

    this.logger.log(`Flow de incidente enviado a: ${senderId}`);
    return { success: true };
  }

  // ─── Procesamiento de la respuesta del Flow ───────────────────────────────────

  private async _processFlowResponse(
    conversation: any,
    message: any,
  ): Promise<any> {
    const senderId = conversation.senderId;

    // Parsear el JSON de respuesta del Flow
    let flowData: Record<string, any>;
    try {
      const rawJson = message.interactive.nfm_reply.response_json;
      flowData = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    } catch (err: any) {
      this.logger.error(`Error parseando nfm_reply: ${err.message}`);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude leer los datos del formulario. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false, reason: "parse_error" };
    }

    this.logger.log(`Flow incidente recibido: ${JSON.stringify(flowData)}`);

    const { cedula, category_id, subcategory_id, descripcion } = flowData;

    // ── Validación básica ──────────────────────────────────────────────────────
    if (!category_id || !subcategory_id || !descripcion?.trim()) {
      this.logger.error(
        `Datos incompletos en nfm_reply: ${JSON.stringify(flowData)}`,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "El formulario estaba incompleto. Por favor intenta registrar el reporte nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false, reason: "incomplete_data" };
    }

    // ── Obtener userId del ciudadano ───────────────────────────────────────────
    let userId: any = conversation.userId ?? null;

    if (!userId && cedula) {
      const user = await this.userModel.findOne({ dni: cedula }).lean();
      userId = user?._id ?? null;
    }

    if (!userId) {
      // Último fallback: buscar por teléfono
      const localPhone = senderId.replace(/^593/, "0");
      const userByPhone = await this.userModel
        .findOne({ $or: [{ telf: senderId }, { telf: localPhone }] })
        .lean();
      userId = userByPhone?._id ?? null;
    }

    // ── Obtener estado "Pendiente" ────────────────────────────────────────────
    const estado = await this.incidentService.getEstadoByName("Pendiente");

    // ── Crear el incidente ────────────────────────────────────────────────────
    let incident: any;
    try {
      incident = await this.incidentService.create({
        ciudadano: userId,
        senderId,
        categoria: category_id,
        subcategoria: subcategory_id,
        descripcion: descripcion.trim(),
        estado: estado?._id ?? null,
        prioridad: "low",
        urgencia: false,
        direccion_geo: {
          nombre: "No especificada",
          latitud: 0,
          longitud: 0,
        },
      });
    } catch (err: any) {
      this.logger.error(`Error creando incidente: ${err.message}`);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Ocurrió un error al registrar tu reporte. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false, reason: "create_error" };
    }

    // ── Construir mensaje de confirmación ────────────────────────────────────
    const confirmMsg = await this._buildConfirmationMessage(incident);
    await this.whatsAppService.sendTextMessage(senderId, confirmMsg);

    // ── Limpiar estado de conversación ────────────────────────────────────────
    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );

    this.logger.log(
      `Incidente creado: ${incident._id} para senderId: ${senderId}`,
    );
    return { success: true, incidentId: incident._id };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private async _buildConfirmationMessage(incident: any): Promise<string> {
    // Poblar categoría, subcategoría y estado para el mensaje de confirmación
    const populated = await this.incidentService.getByIdAndPopulate(
      incident._id,
    );

    const categoriaName =
      populated?.categoria && typeof populated.categoria === "object"
        ? (populated.categoria as any).nombre
        : "No especificada";

    const subcategoriaName =
      populated?.subcategoria && typeof populated.subcategoria === "object"
        ? (populated.subcategoria as any).nombre
        : null;

    const estadoEmoji =
      populated?.estado && typeof populated.estado === "object"
        ? ((populated.estado as any).emoji ?? "⏳")
        : "⏳";

    const estadoNombre =
      populated?.estado && typeof populated.estado === "object"
        ? ((populated.estado as any).nombre ?? "Pendiente")
        : "Pendiente";

    let msg = `✅ *¡Reporte registrado exitosamente!*\n\n`;
    msg += `*N° de reporte:* ${incident._id}\n`;
    msg += `*Categoría:* ${categoriaName}\n`;
    if (subcategoriaName) msg += `*Subcategoría:* ${subcategoriaName}\n`;
    msg += `*Estado:* ${estadoEmoji} ${estadoNombre}\n\n`;
    msg += `Tu reporte ha sido recibido y será atendido por el equipo municipal. `;
    msg += `Recibirás actualizaciones sobre el estado directamente aquí.\n\n`;
    msg += `¡Gracias por contribuir a mejorar *Esmeraldas La Bella*! 🌊`;

    return msg;
  }
}
