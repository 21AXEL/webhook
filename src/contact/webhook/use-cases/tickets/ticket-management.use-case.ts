// Caso de uso: panel de gestión de tickets para agentes TIS.
//
// Flujos que cubre:
//   A) Aceptar ticket OPEN → IN_PROGRESS + notificar "en camino" al funcionario
//   B) Marcar ticket como RESOLVED → generar ratingToken + notificar al funcionario
//   C) Marcar ticket como FALSE_TICKET
//
// Estados de conversación que maneja:
//   ticket_mgmt_listing_open    – lista de tickets OPEN de la línea del agente
//   ticket_mgmt_confirm_accept  – confirmación de aceptación
//   ticket_mgmt_resolve_search  – espera número de ticket a resolver
//   ticket_mgmt_resolve_confirm – confirmación de resolución / ticket falso

import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { ErpService } from "@shared/modules/erp/erp.service";
import { TicketService } from "@shared/modules/tickets/ticket.service";
import {
  TicketStatus,
  SupportLine,
} from "@shared/modules/tickets/ticket.constants";
import { _extractMessageText } from "@shared/utils/extractor-message";
import { MailService } from "@shared/modules/mail/mail.service";
import { AddEvidenceUseCase } from "./add-evidence.use-case";

// Etiquetas legibles del estado
const STATUS_LABEL: Record<TicketStatus, string> = {
  [TicketStatus.Open]: "🔵 Abierto",
  [TicketStatus.InProgress]: "🟡 En proceso",
  [TicketStatus.Resolved]: "🟢 Resuelto",
  [TicketStatus.Closed]: "⚫ Cerrado",
  [TicketStatus.FalseTicket]: "🔴 Ticket falso",
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Convierte número local ecuatoriano 09XXXXXXXX → 593XXXXXXXXX para WhatsApp */
function toWhatsAppPhone(localPhone: string | null): string | null {
  if (!localPhone) return null;
  const clean = localPhone.replace(/\D/g, "");
  if (clean.startsWith("0") && clean.length === 10) {
    return "593" + clean.slice(1);
  }
  return null;
}

// ─────────────────────────────────────────────
// Use-case
// ─────────────────────────────────────────────

@Injectable()
export class TicketManagementUseCase {
  private readonly logger = new Logger(TicketManagementUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly erpService: ErpService,
    private readonly ticketService: TicketService,
    private readonly mailService: MailService, // ← nuevo
    private readonly addEvidenceUseCase: AddEvidenceUseCase,
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
      // ── Entradas desde el menú de bienvenida TIS ─────────────────────────────
      if (buttonId === "mgmt_pending") {
        return this._showOpenTickets(conversation);
      }
      if (buttonId === "mgmt_resolve") {
        return this._startResolveSearch(conversation);
      }

      if (buttonId === "mgmt_resolve_now") {
        return this._resolveTicketFromCreation(conversation);
      }
      if (buttonId === "mgmt_resolve_later") {
        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          "Entendido. Puedes resolverlo más tarde desde *Panel TIS → Resolver ticket*.",
        );
        await this.conversationService.updateState(
          conversation._id,
          "initial",
          conversation.state,
        );
        return { success: true };
      }

      // ── Máquina de estados ───────────────────────────────────────────────────
      switch (state) {
        case "ticket_mgmt_listing_open":
          return this._processTicketSelection(conversation, buttonId);

        case "ticket_mgmt_confirm_accept":
          return this._processAcceptConfirm(conversation, buttonId);

        case "ticket_mgmt_resolve_search":
          return this._processResolveSearch(conversation, text);

        case "ticket_mgmt_resolve_confirm":
          return this._processResolveConfirm(conversation, buttonId);

        case "ticket_post_creation_tis":
          return this._handlePostCreationTis(conversation, buttonId);

        case "ticket_mgmt_resolve_evidence_prompt":
          return this._processEvidencePrompt(conversation, buttonId);

        case "ticket_mgmt_resolve_evidence_collect":
          // El texto "listo" llega aquí; el media lo maneja MediaProcessingUseCase
          return this._processEvidenceCollectText(conversation, text);
        default:
          return this._showPanel(conversation);
      }
    } catch (error) {
      this.logger.error("Error en TicketManagementUseCase:", error);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Ocurrió un error al gestionar el ticket. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversationId,
        "initial",
        state,
      );
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Panel principal ─────────────────────────────────────────────────────────

  /** Muestra las opciones del panel TIS como lista interactiva */
  async _showPanel(conversation: any): Promise<any> {
    const senderId = conversation.senderId;

    await this.whatsAppService.sendListMessage(senderId, {
      headerText: "Panel TIS",
      bodyText: "¿Qué deseas hacer?",
      buttonText: "Ver opciones",
      sections: [
        {
          title: "Gestión de tickets",
          rows: [
            {
              id: "mgmt_pending",
              title: "📋 Tickets pendientes",
              description: "Ver tickets OPEN sin asignar",
            },
            {
              id: "mgmt_resolve",
              title: "✅ Resolver ticket",
              description: "Marcar un ticket como resuelto o falso",
            },
          ],
        },
      ],
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_panel",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Flujo A: aceptar ticket ─────────────────────────────────────────────────

  /** Lista los tickets OPEN. Filtra por línea del agente si está registrado en el ERP. */
  private async _showOpenTickets(conversation: any): Promise<any> {
    const senderId = conversation.senderId;
    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    // Determinar línea del agente; si no se puede, mostrar todas las líneas una por una
    // (WhatsApp permite hasta 10 filas y 10 secciones por lista)
    const lines = Object.values(SupportLine);
    const sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }> = [];

    for (const line of lines) {
      const tickets = await this.ticketService.findOpenByLine(line, 5);
      if (tickets.length === 0) continue;

      sections.push({
        title: this._lineLabel(line),
        rows: tickets.map((t) => ({
          id: `mgmt_accept_${t._id.toString()}`,
          title: t.ticketNumber,
          description: `${t.reportedByName} · ${t.location}`.substring(0, 72),
        })),
      });
    }

    if (sections.length === 0) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "✅ No hay tickets OPEN pendientes de atención en este momento.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    await this.whatsAppService.sendListMessage(senderId, {
      headerText: "Tickets pendientes",
      bodyText: "Selecciona el ticket que vas a atender:",
      buttonText: "Ver tickets",
      sections,
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_listing_open",
      conversation.state,
    );
    return { success: true };
  }

  /** El agente seleccionó un ticket de la lista; muestra detalle y pide confirmación */
  private async _processTicketSelection(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (!buttonId?.startsWith("mgmt_accept_")) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Selecciona un ticket de la lista.",
      );
      return { success: true };
    }

    const ticketId = buttonId.replace("mgmt_accept_", "");
    let ticket: any;
    try {
      ticket = await this.ticketService.findById(ticketId);
    } catch {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No encontré ese ticket. Por favor vuelve a intentarlo.",
      );
      return this._showOpenTickets(conversation);
    }

    if (ticket.status !== TicketStatus.Open) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⚠️ El ticket *${ticket.ticketNumber}* ya no está disponible (estado: ${STATUS_LABEL[ticket.status as TicketStatus]}).`,
      );
      return this._showOpenTickets(conversation);
    }

    // Guardar id del ticket seleccionado en datos temporales
    await this.conversationService.updateTempData?.(conversation._id, {
      selectedTicketId: ticketId,
    });

    const detail =
      `*Ticket: ${ticket.ticketNumber}*\n\n` +
      `👤 *Funcionario:* ${ticket.reportedByName}\n` +
      `📍 *Ubicación:* ${ticket.location}\n` +
      `🔍 *Descripción:* ${ticket.description}\n` +
      `📋 *Línea:* ${this._lineLabel(ticket.line)}\n` +
      `🗓 *Creado:* ${new Date(ticket.createdAt).toLocaleDateString("es-EC")}`;

    await this.whatsAppService.sendButtonMessage(senderId, {
      bodyText: detail,
      footerText: "¿Confirmas que irás a atender este ticket?",
      buttons: [
        { id: "mgmt_accept_yes", text: "✅ Aceptar" },
        { id: "mgmt_accept_no", text: "❌ Cancelar" },
      ],
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_confirm_accept",
      conversation.state,
    );
    return { success: true };
  }

  /** El agente confirmó aceptar: asignar ticket + notificar al funcionario */
  private async _processAcceptConfirm(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (buttonId !== "mgmt_accept_yes") {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Operación cancelada.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    const ticketId = conversation.context?.ticketData?.selectedTicketId;
    if (!ticketId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No se encontró el ticket seleccionado. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    // Identificar al agente
    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    if (!agent) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude verificar tu identidad en el ERP. Contacta a un administrador.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    // Asignar ticket → OPEN → IN_PROGRESS
    const ticket = await this.ticketService.assignTicket(
      ticketId,
      agent.citizenId,
      agent.fullName,
    );

    // Confirmar al agente
    await this.whatsAppService.sendTextMessage(
      senderId,
      `✅ Ticket *${ticket.ticketNumber}* aceptado. El sistema notificará al funcionario que ya vas en camino.`,
    );

    // ── Notificar al funcionario ─────────────────────────────────────────────
    await this._notifyFuncionarioEnCamino(ticket, agent.fullName);

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Flujo B: resolver ticket ─────────────────────────────────────────────────

  /** Inicia el flujo de resolución: pide el número del ticket */
  private async _startResolveSearch(conversation: any): Promise<any> {
    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      "Ingresa el número del ticket a resolver (ej: *TKT-2025-00042*):",
    );
    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_resolve_search",
      conversation.state,
    );
    return { success: true };
  }

  /** Busca el ticket por número y muestra el detalle para confirmación */
  private async _processResolveSearch(
    conversation: any,
    text: string,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (!text) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Por favor ingresa el número del ticket:",
      );
      return { success: true };
    }

    let ticket: any;
    try {
      ticket = await this.ticketService.findByTicketNumber(
        text.toUpperCase().trim(),
      );
    } catch {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `No encontré el ticket *${text}*. Verifica el número e intenta nuevamente:`,
      );
      return { success: true };
    }

    // Después de encontrar el ticket y antes de guardarlo/mostrarlo
    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    if (agent && ticket.reportedBy === agent.citizenId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⚠️ El ticket *${ticket.ticketNumber}* está registrado a tu nombre. ` +
          `No puedes resolverlo tú mismo — solicita a otro miembro de TIS que lo atienda.`,
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    if (
      ticket.status === TicketStatus.Closed ||
      ticket.status === TicketStatus.FalseTicket
    ) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `El ticket *${ticket.ticketNumber}* ya está cerrado (${STATUS_LABEL[ticket.status as TicketStatus]}).`,
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    // Guardar id en datos temporales
    await this.conversationService.updateTempData?.(conversation._id, {
      selectedTicketId: ticket._id.toString(),
    });

    const detail =
      `*${ticket.ticketNumber}* · ${STATUS_LABEL[ticket.status as TicketStatus]}\n\n` +
      `👤 *Funcionario:* ${ticket.reportedByName}\n` +
      `📍 *Ubicación:* ${ticket.location}\n` +
      `🔍 *Problema:* ${ticket.description}\n` +
      `👷 *Asignado a:* ${ticket.assignedToName ?? "Sin asignar"}`;

    await this.whatsAppService.sendButtonMessage(senderId, {
      bodyText: detail,
      footerText: "¿Cuál es el resultado?",
      buttons: [
        { id: "mgmt_resolve_yes", text: "✅ Resuelto" },
        { id: "mgmt_resolve_false", text: "🔴 Ticket falso" },
        { id: "mgmt_resolve_cancel", text: "❌ Cancelar" },
      ],
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_resolve_confirm",
      conversation.state,
    );
    return { success: true };
  }

  /** Procesa la decisión de resolución y notifica al funcionario */
  private async _processResolveConfirm(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (buttonId === "mgmt_resolve_cancel" || !buttonId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Operación cancelada.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    const ticketId = conversation.context?.ticketData?.selectedTicketId;
    if (!ticketId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No se encontró el ticket. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    // Identifica al agente para registrar en el ticket si aún no está asignado
    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    let ticket = await this.ticketService.findById(ticketId);

    // Si el ticket estaba OPEN, asignarlo antes de resolver
    if (ticket.status === TicketStatus.Open && agent) {
      ticket = await this.ticketService.assignTicket(
        ticketId,
        agent.citizenId,
        agent.fullName,
      );
    }

    if (buttonId === "mgmt_resolve_yes") {
      if (ticket.status === TicketStatus.Open && agent) {
        ticket = await this.ticketService.assignTicket(
          ticketId,
          agent.citizenId,
          agent.fullName,
        );
      }

      await this.whatsAppService.sendButtonMessage(senderId, {
        bodyText:
          `¿Deseas adjuntar evidencias antes de resolver el ticket *${ticket.ticketNumber}*?\n` +
          `_(fotos, capturas de pantalla, documentos)_`,
        buttons: [
          { id: "mgmt_evidence_yes", text: "📎 Sí, adjuntar" },
          { id: "mgmt_evidence_no", text: "✅ No, resolver ya" },
        ],
      });

      await this.conversationService.updateState(
        conversation._id,
        "ticket_mgmt_resolve_evidence_prompt",
        conversation.state,
      );

      return { success: true };
      // ── Notificar al funcionario para calificación ───────────────────────────
      // await this._notifyFuncionarioResuelto(ticket);
    } else if (buttonId === "mgmt_resolve_false") {
      ticket = await this.ticketService.updateStatus(
        ticketId,
        TicketStatus.FalseTicket,
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        `🔴 Ticket *${ticket.ticketNumber}* marcado como *TICKET FALSO*.`,
      );

      await this._notifyFuncionarioTicketFalso(ticket);
    }

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }

  // Nuevo método en ticket-management.use-case.ts:
  private async _resolveTicketFromCreation(conversation: any): Promise<any> {
    const senderId = conversation.senderId;
    const ticketId = conversation.context?.ticketData?.selectedTicketId;

    if (!ticketId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No se encontró el ticket. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    const ticket = await this.ticketService.findById(ticketId);

    const detail =
      `*${ticket.ticketNumber}* · ${STATUS_LABEL[ticket.status as TicketStatus]}\n\n` +
      `👤 *Funcionario:* ${ticket.reportedByName}\n` +
      `📍 *Ubicación:* ${ticket.location}\n` +
      `🔍 *Problema:* ${ticket.description}\n` +
      `👷 *Asignado a:* ${ticket.assignedToName ?? "Sin asignar"}`;

    await this.whatsAppService.sendButtonMessage(senderId, {
      bodyText: detail,
      footerText: "¿Cuál es el resultado?",
      buttons: [
        { id: "mgmt_resolve_yes", text: "✅ Resuelto" },
        { id: "mgmt_resolve_false", text: "🔴 Ticket falso" },
        { id: "mgmt_resolve_cancel", text: "❌ Cancelar" },
      ],
    });

    // Reutiliza el estado de confirmación estándar
    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_resolve_confirm",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Implementación ──────────────────────────────────────────────────────────

  private async _handlePostCreationTis(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (buttonId === "mgmt_resolve_now") {
      return this._resolveTicketFromCreation(conversation);
    }

    // mgmt_resolve_later u otro
    await this.whatsAppService.sendTextMessage(
      senderId,
      "Entendido. Puedes resolverlo más tarde desde *Panel TIS → Resolver ticket*.",
    );
    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Notificaciones al funcionario ──────────────────────────────────────────

  private async _notifyFuncionarioEnCamino(
    ticket: any,
    agentName: string,
  ): Promise<void> {
    const waPhone = toWhatsAppPhone(ticket.reportedByPhone);

    // WhatsApp (existente)
    if (waPhone) {
      try {
        await this.whatsAppService.sendTextMessage(
          waPhone,
          `🔔 *Actualización de tu ticket ${ticket.ticketNumber}*\n\n` +
            `El técnico *${agentName}* ha aceptado tu solicitud y ya está en camino.\n\n` +
            `📍 *Ubicación registrada:* ${ticket.location}`,
        );
      } catch (e) {
        this.logger.warn(
          `No se pudo notificar WhatsApp "en camino": ${(e as Error).message}`,
        );
      }
    }

    // Correo (nuevo) — fire-and-forget
    this._sendMailInProgress(ticket, agentName);
  }

  private async _notifyFuncionarioResuelto(ticket: any): Promise<void> {
    const waPhone = toWhatsAppPhone(ticket.reportedByPhone);

    // WhatsApp (existente)
    if (waPhone) {
      try {
        await this.whatsAppService.sendTextMessage(
          waPhone,
          `✅ *Tu ticket ${ticket.ticketNumber} fue marcado como RESUELTO*\n\n` +
            `Por favor escríbenos cuando puedas para calificar el servicio recibido.\n\n` +
            `Tu calificación nos ayuda a mejorar la atención técnica.`,
        );
      } catch (e) {
        this.logger.warn(
          `No se pudo notificar WhatsApp "resuelto": ${(e as Error).message}`,
        );
      }
    }

    // Correo (nuevo) — fire-and-forget
    this._sendMailResolved(ticket);
  }

  private async _notifyFuncionarioTicketFalso(ticket: any): Promise<void> {
    const waPhone = toWhatsAppPhone(ticket.reportedByPhone);

    // WhatsApp (existente)
    if (waPhone) {
      try {
        await this.whatsAppService.sendTextMessage(
          waPhone,
          `⚠️ *Tu ticket ${ticket.ticketNumber} fue marcado como TICKET FALSO*\n\n` +
            `Si crees que esto es un error, por favor comunícate con el área de TIS.`,
        );
      } catch (e) {
        this.logger.warn(
          `No se pudo notificar WhatsApp "falso": ${(e as Error).message}`,
        );
      }
    }

    // Correo (nuevo) — fire-and-forget
    this._sendMailFalse(ticket);
  }

  // ─── Helpers de correo (todos fire-and-forget) ────────────────────────────────

  private _sendMailInProgress(ticket: any, agentName: string): void {
    this.erpService
      .getEmployeeByCitizenId(ticket.reportedBy)
      .then((emp) => {
        const email = emp?.institutionalEmail ?? emp?.personalEmail ?? null;
        if (!email) return;
        return this.mailService.sendTicketInProgress({
          to: email,
          recipientName: ticket.reportedByName,
          ticketNumber: ticket.ticketNumber,
          agentName,
          description: ticket.description,
          location: ticket.location,
        });
      })
      .catch((e) =>
        this.logger.warn(`Error correo "en atención": ${e.message}`),
      );
  }

  private _sendMailResolved(ticket: any): void {
    this.erpService
      .getEmployeeByCitizenId(ticket.reportedBy)
      .then((emp) => {
        const email = emp?.institutionalEmail ?? emp?.personalEmail ?? null;
        if (!email || !ticket.ratingToken) return;
        return this.mailService.sendTicketResolved({
          to: email,
          recipientName: ticket.reportedByName,
          ticketNumber: ticket.ticketNumber,
          description: ticket.description,
          agentName: ticket.assignedToName ?? null,
          ratingToken: ticket.ratingToken,
        });
      })
      .catch((e) => this.logger.warn(`Error correo "resuelto": ${e.message}`));
  }

  private _sendMailFalse(ticket: any): void {
    this.erpService
      .getEmployeeByCitizenId(ticket.reportedBy)
      .then((emp) => {
        const email = emp?.institutionalEmail ?? emp?.personalEmail ?? null;
        if (!email) return;
        return this.mailService.sendTicketFalse({
          to: email,
          recipientName: ticket.reportedByName,
          ticketNumber: ticket.ticketNumber,
        });
      })
      .catch((e) => this.logger.warn(`Error correo "falso": ${e.message}`));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private _normalizePhone(waPhone: string): string {
    if (waPhone.startsWith("593") && waPhone.length === 12) {
      return "0" + waPhone.slice(3);
    }
    return waPhone;
  }

  private _lineLabel(line: SupportLine): string {
    const labels: Record<SupportLine, string> = {
      [SupportLine.TechnicalSupport]: "Soporte Técnico",
      [SupportLine.Infrastructure]: "Infraestructura",
      [SupportLine.Systems]: "Sistemas",
    };
    return labels[line] ?? line;
  }

  private async _processEvidencePrompt(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const ticketId = conversation.context?.ticketData?.selectedTicketId;

    if (buttonId === "mgmt_evidence_no") {
      return this._finalizeResolve(conversation, ticketId);
    }

    // mgmt_evidence_yes
    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      "Envía las evidencias (fotos, videos o documentos) una a una.\n\n" +
        "Cuando termines escribe *listo*.",
    );
    await this.conversationService.updateState(
      conversation._id,
      "ticket_mgmt_resolve_evidence_collect",
      conversation.state,
    );
    return { success: true };
  }

  /** Maneja el texto "listo" durante la recolección; los medios los enruta MediaProcessingUseCase */
  private async _processEvidenceCollectText(
    conversation: any,
    text: string,
  ): Promise<any> {
    if (this._isDone(text)) {
      const ticketId = conversation.context?.ticketData?.selectedTicketId;
      return this._finalizeResolve(conversation, ticketId);
    }

    await this.whatsAppService.sendTextMessage(
      conversation.senderId,
      "Envía un archivo adjunto, o escribe *listo* cuando hayas terminado.",
    );
    return { success: true };
  }

  private _isDone(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // quita tildes
      .replace(/[^a-z0-9\s]/g, "") // quita puntuación
      .trim();

    const DONE_WORDS = new Set([
      "listo",
      "lista",
      "listos",
      "listas",
      "ya",
      "ya esta",
      "ya estuvo",
      "ok",
      "okay",
      "okey",
      "fin",
      "fine",
      "done",
      "terminar",
      "termine",
      "termino",
      "terminado",
      "terminada",
      "finalizar",
      "finalice",
      "finalizo",
      "finalizado",
      "eso es todo",
      "es todo",
      "eso es",
      "nada mas",
      "nada más",
      "nada más gracias",
      "suficiente",
      "con eso",
      "con eso basta",
    ]);

    return DONE_WORDS.has(normalized);
  }

  /** Llamado tanto desde el flujo de texto como desde MediaProcessingUseCase tras guardar evidencia */
  async handleEvidenceMedia(
    conversation: any,
    mediaResult: { filePath: string; fileName: string; fileType: string },
  ): Promise<any> {
    const senderId = conversation.senderId;
    const ticketId = conversation.context?.ticketData?.selectedTicketId;

    if (!ticketId) return { success: false };

    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);
    if (!agent) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude verificar tu identidad. La evidencia no fue guardada.",
      );
      return { success: false };
    }

    const fileBuffer = await this.whatsAppService.downloadMedia(
      mediaResult.filePath,
    );

    try {
      await this.addEvidenceUseCase.execute({
        ticketId,
        fileBuffer,
        originalName: mediaResult.fileName,
        mimetype: mediaResult.fileType,
        agentCitizenId: agent.citizenId,
        agentName: agent.fullName,
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        "✅ Evidencia guardada. Envía otra o escribe *listo* para resolver.",
      );
    } catch (err: any) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⚠️ No se pudo guardar la evidencia: ${err.message}`,
      );
    }

    return { success: true };
  }

  private async _finalizeResolve(
    conversation: any,
    ticketId: string,
  ): Promise<any> {
    const senderId = conversation.senderId;
    const localPhone = this._normalizePhone(senderId);
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    let ticket = await this.ticketService.findById(ticketId);

    // ── Un agente no puede resolver su propio ticket ─────────────────────────
    if (agent && ticket.reportedBy === agent.citizenId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⚠️ No puedes resolver el ticket *${ticket.ticketNumber}* porque fue abierto a tu nombre.\n\n` +
          `Debe ser atendido por otro miembro del equipo de TIS.`,
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    if (ticket.status === TicketStatus.Open && agent) {
      ticket = await this.ticketService.assignTicket(
        ticketId,
        agent.citizenId,
        agent.fullName,
      );
    }

    ticket = await this.ticketService.updateStatus(
      ticketId,
      TicketStatus.Resolved,
    );

    await this.whatsAppService.sendTextMessage(
      senderId,
      `✅ Ticket *${ticket.ticketNumber}* marcado como *RESUELTO*. ` +
        `Se notificará a ${ticket.reportedByName} para que califique el servicio.`,
    );

    await this._notifyFuncionarioResuelto(ticket);

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }
}
