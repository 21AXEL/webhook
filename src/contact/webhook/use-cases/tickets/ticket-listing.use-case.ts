// Caso de uso: el funcionario consulta sus tickets y puede calificar los resueltos.
//
// Estados de conversación que maneja:
//   ticket_my_list     – lista de tickets del funcionario
//   ticket_my_detail   – detalle de un ticket seleccionado
//   ticket_rating      – flujo de calificación de un ticket RESOLVED

import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { ErpService } from "@shared/modules/erp/erp.service";
import { TicketService } from "@shared/modules/tickets/ticket.service";
import {
  TicketStatus,
  RatingValue,
} from "@shared/modules/tickets/ticket.constants";
import { _extractMessageText } from "@shared/utils/extractor-message";

// Etiquetas de estado para mostrar al usuario
const STATUS_LABEL: Record<TicketStatus, string> = {
  [TicketStatus.Open]: "🔵 Abierto",
  [TicketStatus.InProgress]: "🟡 En proceso",
  [TicketStatus.Resolved]: "🟢 Resuelto — pendiente de calificación",
  [TicketStatus.Closed]: "⚫ Cerrado",
  [TicketStatus.FalseTicket]: "🔴 Ticket falso",
};

// ─────────────────────────────────────────────
// Use-case
// ─────────────────────────────────────────────

@Injectable()
export class TicketListingUseCase {
  private readonly logger = new Logger(TicketListingUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly erpService: ErpService,
    private readonly ticketService: TicketService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    const conversationId = conversation._id;
    const senderId = conversation.senderId;
    const state = conversation.state ?? "initial";
    const buttonId =
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      null;

    try {
      // ── Entrada desde welcome ────────────────────────────────────────────────
      if (buttonId === "ltuc_my_tickets") {
        return this._showMyTickets(conversation);
      }

      // ── Máquina de estados ───────────────────────────────────────────────────
      switch (state) {
        case "ticket_my_list":
          return this._processListSelection(conversation, buttonId);

        case "ticket_my_detail":
          return this._processDetailAction(conversation, buttonId);

        case "ticket_rating":
          return this._processRating(conversation, buttonId);

        default:
          return this._showMyTickets(conversation);
      }
    } catch (error) {
      this.logger.error("Error en TicketListingUseCase:", error);
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Ocurrió un error al consultar tus tickets. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversationId,
        "initial",
        state,
      );
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Mostrar lista de tickets ────────────────────────────────────────────────

  /** Lista los últimos tickets del funcionario (máx. 10, ordenados por fecha desc) */
  private async _showMyTickets(conversation: any): Promise<any> {
    const senderId = conversation.senderId;

    // Identificar al funcionario por teléfono
    const localPhone = this._normalizePhone(senderId);
    const employee = await this.erpService.getEmployeeByPhone(localPhone);

    if (!employee) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude verificar tu identidad. Por favor regístra tu número en el sistema.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    const { data: tickets } = await this.ticketService.findAll({
      reportedBy: employee.citizenId,
      limit: 10,
    });

    if (tickets.length === 0) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "📭 No tienes tickets registrados aún.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    // Separar en activos y cerrados para las secciones de la lista
    const active = tickets.filter((t) =>
      [
        TicketStatus.Open,
        TicketStatus.InProgress,
        TicketStatus.Resolved,
      ].includes(t.status as TicketStatus),
    );
    const closed = tickets.filter((t) =>
      [TicketStatus.Closed, TicketStatus.FalseTicket].includes(
        t.status as TicketStatus,
      ),
    );

    const sections: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }> = [];

    if (active.length > 0) {
      sections.push({
        title: "Tickets activos",
        rows: active.map((t) => ({
          id: `myticket_${t._id.toString()}`,
          title: t.ticketNumber,
          description:
            `${STATUS_LABEL[t.status as TicketStatus]} · ${t.location}`.substring(
              0,
              72,
            ),
        })),
      });
    }

    if (closed.length > 0) {
      sections.push({
        title: "Tickets cerrados",
        rows: closed.slice(0, 5).map((t) => ({
          id: `myticket_${t._id.toString()}`,
          title: t.ticketNumber,
          description:
            `${STATUS_LABEL[t.status as TicketStatus]} · ${t.location}`.substring(
              0,
              72,
            ),
        })),
      });
    }

    await this.whatsAppService.sendListMessage(senderId, {
      headerText: "Mis tickets",
      bodyText: `Tienes *${tickets.length}* ticket(s) registrado(s). Selecciona uno para ver el detalle:`,
      buttonText: "Ver mis tickets",
      sections,
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_my_list",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Detalle de un ticket ────────────────────────────────────────────────────

  /** El funcionario seleccionó un ticket de la lista */
  private async _processListSelection(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (!buttonId?.startsWith("myticket_")) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Selecciona un ticket de la lista.",
      );
      return { success: true };
    }

    const ticketId = buttonId.replace("myticket_", "");
    let ticket: any;
    try {
      ticket = await this.ticketService.findById(ticketId);
    } catch {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No encontré ese ticket. Por favor intenta nuevamente.",
      );
      return this._showMyTickets(conversation);
    }

    await this.conversationService.updateTempData?.(conversation._id, {
      selectedTicketId: ticketId,
    });

    // Construir mensaje de detalle
    const lines = [
      `*${ticket.ticketNumber}*`,
      ``,
      `📌 *Estado:* ${STATUS_LABEL[ticket.status as TicketStatus]}`,
      `📋 *Descripción:* ${ticket.description}`,
      `📍 *Ubicación:* ${ticket.location}`,
      `🗓 *Creado:* ${new Date(ticket.createdAt).toLocaleDateString("es-EC")}`,
    ];

    if (ticket.assignedToName) {
      lines.push(`👷 *Atendido por:* ${ticket.assignedToName}`);
    }

    if (ticket.rating?.value) {
      const ratingLabels: Record<RatingValue, string> = {
        [RatingValue.Good]: "👍 Bueno",
        [RatingValue.Bad]: "👎 Malo",
        [RatingValue.Comment]: "💬 Con comentario",
        [RatingValue.False]: "🚫 Declarado falso",
      };
      lines.push(
        `⭐ *Calificación:* ${ratingLabels[ticket.rating.value as RatingValue]}`,
      );
      if (ticket.rating.comment) {
        lines.push(`💬 *Comentario:* ${ticket.rating.comment}`);
      }
    }

    if (ticket.evidences?.length > 0) {
      lines.push(`📎 *Evidencias:* ${ticket.evidences.length} archivo(s)`);
    }

    const isRatable =
      ticket.status === TicketStatus.Resolved && !ticket.rating?.value;
    const buttons: Array<{ id: string; text: string }> = [
      { id: "myticket_back", text: "⬅️ Volver" },
    ];
    if (isRatable) {
      buttons.unshift({ id: "myticket_rate", text: "⭐ Calificar" });
    }

    await this.whatsAppService.sendButtonMessage(senderId, {
      bodyText: lines.join("\n"),
      buttons,
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_my_detail",
      conversation.state,
    );
    return { success: true };
  }

  /** Acciones desde el detalle del ticket */
  private async _processDetailAction(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    if (buttonId === "myticket_back") {
      return this._showMyTickets(conversation);
    }

    if (buttonId === "myticket_rate") {
      return this._showRatingOptions(conversation);
    }

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Calificación ────────────────────────────────────────────────────────────

  /**
   * Muestra las opciones de calificación del ticket.
   * También puede ser llamado directamente desde WelcomeUseCase cuando hay
   * una calificación pendiente (recordatorio en próxima interacción).
   */
  async _showRatingOptions(conversation: any): Promise<any> {
    const senderId = conversation.senderId;
    const ticketId = conversation.context?.ticketData?.selectedTicketId;

    if (!ticketId) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No se encontró el ticket a calificar. Por favor intenta nuevamente.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: true };
    }

    let ticket: any;
    try {
      ticket = await this.ticketService.findById(ticketId);
    } catch {
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    await this.whatsAppService.sendButtonMessage(senderId, {
      headerText: `Calificar ${ticket.ticketNumber}`,
      bodyText:
        `¿Cómo fue el servicio que recibiste para el problema:\n` +
        `_"${ticket.description}"_\n\n` +
        `Tu calificación es importante para mejorar la atención.`,
      buttons: [
        { id: "rate_good", text: "👍 Bueno" },
        { id: "rate_bad", text: "👎 Malo" },
        { id: "rate_false", text: "🚫 No fue real" },
      ],
    });

    await this.conversationService.updateState(
      conversation._id,
      "ticket_rating",
      conversation.state,
    );
    return { success: true };
  }

  /** Procesa la calificación seleccionada por el funcionario */
  private async _processRating(
    conversation: any,
    buttonId: string | null,
  ): Promise<any> {
    const senderId = conversation.senderId;

    const ratingMap: Record<string, RatingValue> = {
      rate_good: RatingValue.Good,
      rate_bad: RatingValue.Bad,
      rate_false: RatingValue.False,
    };

    const ratingValue = buttonId ? ratingMap[buttonId] : null;

    if (!ratingValue) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Selecciona una opción de calificación.",
      );
      return { success: true };
    }

    const ticketId = conversation.context?.ticketData?.selectedTicketId;
    if (!ticketId) {
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    // Identificar al funcionario
    const localPhone = this._normalizePhone(senderId);
    const employee = await this.erpService.getEmployeeByPhone(localPhone);

    if (!employee) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        "No pude verificar tu identidad para registrar la calificación.",
      );
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    await this.ticketService.rateDirectly(ticketId, employee.citizenId, {
      value: ratingValue,
    });

    const confirmMessages: Record<RatingValue, string> = {
      [RatingValue.Good]:
        "¡Gracias por tu calificación! 👍 Nos alegra que el problema fue resuelto.",
      [RatingValue.Bad]:
        "Gracias por tu calificación. 👎 Tomaremos nota para mejorar el servicio.",
      [RatingValue.False]:
        "Entendido, el ticket fue marcado como *no real*. 🚫",
      [RatingValue.Comment]: "¡Gracias por tu comentario!",
    };

    await this.whatsAppService.sendTextMessage(
      senderId,
      confirmMessages[ratingValue],
    );

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private _normalizePhone(waPhone: string): string {
    if (waPhone.startsWith("593") && waPhone.length === 12) {
      return "0" + waPhone.slice(3);
    }
    return waPhone;
  }
}
