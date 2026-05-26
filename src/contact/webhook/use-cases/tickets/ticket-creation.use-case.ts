import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConversationService } from "../../../conversation.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { ErpService } from "@shared/modules/erp/erp.service";
import { TicketService } from "@shared/modules/tickets/ticket.service";
import {
  SupportLine,
  TicketCategory,
} from "@shared/modules/tickets/ticket.constants";
import { _extractMessageText } from "@shared/utils/extractor-message";
import { MailService } from "@shared/modules/mail/mail.service";

// ── Mapeo valores del Flow → enums internos ──────────────────────────────────

const FLOW_TO_LINE: Record<string, SupportLine> = {
  TECHNICAL_SUPPORT: SupportLine.TechnicalSupport,
  INFRASTRUCTURE: SupportLine.Infrastructure,
  SYSTEMS: SupportLine.Systems,
};

const FLOW_TO_CATEGORY: Record<string, TicketCategory> = {
  INTERNET: TicketCategory.Internet,
  COMPUTERS: TicketCategory.Computers,
  PRINTERS: TicketCategory.Printers,
  SERVERS: TicketCategory.Servers,
  WIFI: TicketCategory.Wifi,
  EMAIL: TicketCategory.Email,
  CABILDO: TicketCategory.Cabildo,
  SIGDAR: TicketCategory.Sigdar,
  SIGCAL: TicketCategory.Sigcal,
  ERP: TicketCategory.Erp,
  OTHER: TicketCategory.Other,
};

// Mapa inverso: categoría → línea correcta
const CATEGORY_TO_LINE: Record<TicketCategory, SupportLine> = {
  [TicketCategory.Internet]: SupportLine.TechnicalSupport,
  [TicketCategory.Computers]: SupportLine.TechnicalSupport,
  [TicketCategory.Printers]: SupportLine.TechnicalSupport,
  [TicketCategory.Servers]: SupportLine.Infrastructure,
  [TicketCategory.Wifi]: SupportLine.Infrastructure,
  [TicketCategory.Email]: SupportLine.Systems,
  [TicketCategory.Cabildo]: SupportLine.Systems,
  [TicketCategory.Sigdar]: SupportLine.Systems,
  [TicketCategory.Sigcal]: SupportLine.Systems,
  [TicketCategory.Erp]: SupportLine.Systems,
  [TicketCategory.Other]: SupportLine.TechnicalSupport, // fallback razonable
};

// ← NUEVO: unidad ERP del agente → línea de soporte
const DEPARTMENT_TO_LINE: Record<string, SupportLine> = {
  "UNIDAD DE SOPORTE TECNOLOGICO": SupportLine.TechnicalSupport,
  "UNIDAD DE APLICACIONES Y SISTEMAS": SupportLine.Systems,
  "UNIDAD DE INFRAESTRUCTURA": SupportLine.Infrastructure,
  "DIRECCION DE TECNOLOGIAS DE LA INFORMACION": SupportLine.TechnicalSupport,
};

@Injectable()
export class TicketCreationUseCase {
  private readonly logger = new Logger(TicketCreationUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly erpService: ErpService,
    private readonly ticketService: TicketService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    const conversationId = conversation._id;
    const senderId = conversation.senderId;
    const state = conversation.state ?? "initial";
    const buttonId =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      null;
    const text = _extractMessageText(message).trim();

    try {
      // ── Entrada desde botones de selección de destinatario ───────────────────
      if (buttonId === "tcuc_own")
        return this._startOwnTicket(conversation, true);
      if (buttonId === "tcuc_other")
        return this._startBeneficiarySearch(conversation);

      // ── Máquina de estados ───────────────────────────────────────────────────
      switch (state) {
        case "ticket_beneficiary_search":
          return this._processBeneficiarySearch(conversation, text);

        case "ticket_beneficiary_confirm":
          return this._processBeneficiaryConfirm(conversation, buttonId);

        case "ticket_awaiting_flow":
          return this._processFlowResponse(conversation, message);

        default:
          return this._startOwnTicket(conversation, false);
      }
    } catch (error) {
      this.logger.error("Error en TicketCreationUseCase:", error);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Ocurrió un error al procesar tu ticket. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversationId,
        "initial",
        state,
      );
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Flujo: ticket propio ────────────────────────────────────────────────────

  private async _startOwnTicket(
    conversation: any,
    forSelf: boolean = false,
  ): Promise<any> {
    const senderId = conversation.senderId;
    const localPhone = this._normalizePhone(senderId);
    const employee = await this.erpService.getEmployeeByPhone(localPhone);

    if (!employee) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No encontré tu número en el sistema. Para abrir un ticket necesito verificar tu identidad. Por favor ingresa tu número de cédula:",
      );
      await this._saveTempTicketData(conversation._id, {
        lookupType: "own_by_cedula",
      });
      await this.conversationService.updateState(
        conversation._id,
        "ticket_beneficiary_search",
        conversation.state,
      );
      return { success: true };
    }

    // ── Agente TIS vía texto → preguntar destinatario ──────────────────────────
    if (!forSelf && this.erpService.isTisAgent(employee)) {
      await this.whatsAppService.sendButtonMessage(senderId, {
        bodyText: `${employee.firstName}, ¿este ticket es para ti o para otro funcionario?`,
        buttons: [
          { id: "tcuc_own", text: "Para mí" },
          { id: "tcuc_other", text: "Para otro funcionario" },
        ],
      });
      await this.conversationService.updateState(
        conversation._id,
        "ticket_selecting_for",
        conversation.state,
      );
      return { success: true };
    }

    // ── Guardar datos del funcionario y lanzar el Flow ─────────────────────────
    await this._saveTempTicketData(conversation._id, {
      reportedBy: employee.citizenId,
      reportedByName: employee.fullName,
      reportedByPhone: localPhone,
      isDelegate: false,
    });

    return this._sendTicketFlow(conversation, employee.firstName);
  }

  // ─── Flujo: ticket para otro (TIS) ──────────────────────────────────────────

  private async _startBeneficiarySearch(conversation: any): Promise<any> {
    const agentPhone = this._normalizePhone(conversation.senderId);
    const agent = await this.erpService.getEmployeeByPhone(agentPhone);

    // ← NUEVO: calcular la línea del agente para usarla después
    const agentLine = agent?.department
      ? (DEPARTMENT_TO_LINE[agent.department.toUpperCase().trim()] ?? null)
      : null;

    await this._saveTempTicketData(conversation._id, {
      createdByAgent: agent?.citizenId ?? null,
      createdByAgentName: agent?.fullName ?? null,
      agentLine, // ← NUEVO
      isDelegate: true,
    });

    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      "Ingresa el *número de cédula* del funcionario para quien abres el ticket:",
    );
    await this.conversationService.updateState(
      conversation._id,
      "ticket_beneficiary_search",
      conversation.state,
    );
    return { success: true };
  }

  private async _processBeneficiarySearch(
    conversation: any,
    text: string,
  ): Promise<any> {
    const senderId = conversation.senderId;
    const tempData = conversation.context?.ticketData ?? {};

    const employee = await this.erpService.getEmployeeByCitizenId(text.trim());

    if (!employee) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No encontré ningún funcionario activo con esa cédula. Verifica el número e intenta nuevamente:",
      );
      return { success: true };
    }

    await this._saveTempTicketData(conversation._id, {
      ...tempData,
      reportedBy: employee.citizenId,
      reportedByName: employee.fullName,
      reportedByPhone: employee.mobile ?? employee.phone ?? null,
      reportedByEmail:
        employee.institutionalEmail ?? employee.personalEmail ?? null,
    });

    await this.whatsAppService.sendButtonMessage(senderId, {
      bodyText:
        `*Funcionario encontrado:*\n\n` +
        `👤 ${employee.fullName}\n` +
        `🏢 ${employee.department ?? "Sin unidad"}\n` +
        `💼 ${employee.jobTitle ?? "Sin cargo"}\n` +
        `📧 ${employee.institutionalEmail ?? "Sin correo"}`,
      footerText: "¿Es este el funcionario correcto?",
      buttons: [
        { id: "tcuc_beneficiary_confirm_yes", text: "Sí, continuar" },
        { id: "tcuc_beneficiary_confirm_no", text: "No, buscar otro" },
      ],
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_beneficiary_confirm",
      conversation.state,
    );
    return { success: true };
  }

  private async _processBeneficiaryConfirm(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    if (buttonId === "tcuc_beneficiary_confirm_no") {
      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Ingresa nuevamente la cédula del funcionario:",
      );
      await this.conversationService.updateState(
        conversation._id,
        "ticket_beneficiary_search",
        conversation.state,
      );
      return { success: true };
    }

    // Confirmado → lanzar el Flow con el nombre del funcionario
    const d = conversation.context?.ticketData ?? {};
    //const firstName = d.reportedByName?.split(" ")[0] ?? "funcionario";
    const agentPhone = this._normalizePhone(conversation.senderId);
    const agent = await this.erpService.getEmployeeByPhone(agentPhone);
    const agentFirstName = agent?.firstName ?? "funcionario";
    return this._sendTicketFlow(conversation, agentFirstName);
  }

  // ─── Envío del WhatsApp Flow ─────────────────────────────────────────────────

  private async _sendTicketFlow(
    conversation: any,
    firstName: string,
  ): Promise<any> {
    const senderId = conversation.senderId;
    const flowId =
      this.configService.get<string>("flows.TICKET_TECNICO") ??
      "1024894076866922";

    await this.whatsAppService.sendMessage(senderId, {
      type: "interactive",
      interactive: {
        type: "flow",
        header: {
          type: "text",
          text: "📋 Nueva solicitud de soporte",
        },
        body: {
          text: `Hola ${firstName} 👋, completa el formulario para registrar tu solicitud.`,
        },
        footer: {
          text: "Municipio de Esmeraldas",
        },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: flowId,
            flow_cta: "📝 Abrir formulario", // ← esto faltaba
            flow_token: `ticket_${senderId}_${Date.now()}`,
            flow_action: "navigate",
            flow_action_payload: {
              screen: "TICKET_TECNICO",
            },
          },
        },
      },
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_awaiting_flow",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Recepción y procesamiento de la respuesta del Flow ─────────────────────

  private async _processFlowResponse(
    conversation: any,
    message: any,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (message.interactive?.type !== "nfm_reply") {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Por favor completa el formulario para continuar.",
      );
      return { success: true };
    }

    let flowData: any;
    try {
      const rawJson = message.interactive.nfm_reply.response_json;
      flowData = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    } catch {
      this.logger.error("Error parseando respuesta del Flow");
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude leer los datos del formulario. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    const category = FLOW_TO_CATEGORY[flowData.categoria];
    const line = category
      ? CATEGORY_TO_LINE[category]
      : SupportLine.TechnicalSupport;
    const location = flowData.ubicacion?.trim();
    const description = flowData.descripcion?.trim();

    if (!category || !location || !description) {
      this.logger.error(
        `Datos incompletos del Flow: ${JSON.stringify(flowData)}`,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "El formulario estaba incompleto. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    const d = conversation.context?.ticketData ?? {};

    try {
      const ticket = await this.ticketService.create({
        reportedBy: d.reportedBy,
        reportedByName: d.reportedByName,
        reportedByPhone: d.reportedByPhone ?? null,
        createdByAgent: d.createdByAgent ?? null,
        createdByAgentName: d.createdByAgentName ?? null,
        line,
        category,
        otherDescription:
          category === TicketCategory.Other ? description : null,
        location,
        description,
      });

      // ── Notificación por correo al beneficiario ──────────────────────────────
      const recipientEmail = d.reportedByEmail ?? null;
      if (recipientEmail) {
        // No await intencional: el correo no debe bloquear el flujo de WhatsApp
        this.mailService
          .sendTicketCreated({
            to: recipientEmail,
            recipientName: d.reportedByName ?? "Funcionario",
            ticketNumber: ticket.ticketNumber,
            category: flowData.categoria ?? category,
            description,
            location,
            createdByAgentName: d.createdByAgent
              ? (d.createdByAgentName ?? null)
              : null,
          })
          .catch((e) =>
            this.logger.warn(`Error fire-and-forget correo: ${e.message}`),
          );
      }

      // ── Agente TIS de la misma línea → ofrecer resolución inmediata ─────────
      if (d.createdByAgent && d.agentLine && d.agentLine === line) {
        await this._clearTempTicketData(conversation._id);
        await this._saveTempTicketData(conversation._id, {
          selectedTicketId: ticket._id.toString(),
        });
        await this.conversationService.updateState(
          conversation._id,
          "ticket_post_creation_tis",
          conversation.state,
        );
        await this.whatsAppService.sendButtonMessage(senderId, {
          bodyText:
            `✅ Ticket *${ticket.ticketNumber}* creado para ` +
            `*${d.reportedByName ?? "el funcionario"}*.\n\n` +
            `Es de tu área — ¿deseas resolverlo ahora mismo?`,
          buttons: [
            { id: "mgmt_resolve_now", text: "✅ Resolver ahora" },
            { id: "mgmt_resolve_later", text: "⏱ Resolver después" },
          ],
        });
        return { success: true };
      }
      // ── Confirmación estándar ────────────────────────────────────────────────

      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      await this._clearTempTicketData(conversation._id);

      await this.whatsAppService.sendTextMessage(
        senderId,
        `✅ *Ticket creado exitosamente*\n\n🎫 Número: *${ticket.ticketNumber}*\n\nEl equipo de soporte atenderá tu solicitud a la brevedad.`,
      );
    } catch (error: any) {
      this.logger.warn(`Error al crear ticket: ${error.message}`);
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      await this._clearTempTicketData(conversation._id);
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⚠️ No se pudo crear el ticket.\n\n${error.message}`,
      );
    }

    return { success: true };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private _normalizePhone(phone: string): string {
    return phone.replace(/^\+?593/, "0").replace(/\D/g, "");
  }

  private async _saveTempTicketData(
    conversationId: string,
    data: Record<string, any>,
  ): Promise<void> {
    await this.conversationService.updateTempData(conversationId, data);
  }

  private async _clearTempTicketData(conversationId: string): Promise<void> {
    await this.conversationService.clearTempData(conversationId);
  }
}
