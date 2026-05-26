// src/contact/webhook/use-cases/welcome/welcome.use-case.ts
import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { WhatsAppService } from "../../services/whatsapp.service";
import { AiService } from "../../services/ai.service";
import { ErpService, Employee } from "@shared/modules/erp/erp.service";
import { TicketService } from "@shared/modules/tickets/ticket.service";
import { TicketDocument } from "@shared/modules/tickets/ticket.schema";
import { AgentConsentService } from "@shared/modules/agent-consent/agent-consent.service";
import { ConsentStatus } from "@shared/modules/agent-consent/agent-consent.schema";

@Injectable()
export class WelcomeUseCase {
  private readonly logger = new Logger(WelcomeUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
    private readonly erpService: ErpService,
    private readonly ticketService: TicketService,
    private readonly agentConsentService: AgentConsentService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    const conversationId = conversation._id;
    const senderId = conversation.senderId;

    try {
      if (!conversation || !message) {
        throw new Error("Conversación o mensaje no válidos");
      }

      await this.conversationService.updateState(
        conversationId,
        "welcome",
        conversation.state,
      );

      const localPhone = this._normalizePhone(senderId);
      const employee = await this.erpService.getEmployeeByPhone(localPhone);
      const isTisAgent = this.erpService.isTisAgent(employee);

      // ── Gap 5: Verificar calificación pendiente antes del menú ───────────────
      // En _sendWelcomeMessages, antes de enviar el menú TIS:
      if (isTisAgent && employee) {
        const consent = await this.agentConsentService.findByCitizenId(
          employee.citizenId,
        );

        // Si nunca ha respondido → pedir consentimiento y cortar el flujo
        if (!consent || consent.status === ConsentStatus.Pending) {
          await this.agentConsentService.upsertPending({
            citizenId: employee.citizenId,
            waPhone: senderId,
            name: employee.fullName,
          });
          await this.agentConsentService.markAsked(employee.citizenId);

          await this.whatsAppService.sendButtonMessage(senderId, {
            headerText: "Aviso de uso de datos personales",
            bodyText:
              `${employee.firstName}, antes de continuar necesitamos tu autorización.\n\n` +
              `Este sistema enviará mensajes a *este número personal* para:\n` +
              `• Consultar tu disponibilidad cada mañana laboral\n` +
              `• Notificarte de tickets asignados a tu área\n\n` +
              `Esta información será tratada exclusivamente para fines laborales ` +
              `dentro del Municipio de Esmeraldas, conforme a la *Ley Orgánica de ` +
              `Protección de Datos Personales* del Ecuador (LOPDP).\n\n` +
              `¿Autorizas el uso de este número para las notificaciones del sistema TIS?`,
            footerText: "Puedes revocar este consentimiento cuando lo desees.",
            buttons: [
              { id: "consent_accept", text: "✅ Sí, autorizo" },
              { id: "consent_decline", text: "❌ No autorizo" },
            ],
          });

          await this.conversationService.updateState(
            conversation._id,
            "agent_consent_pending",
            conversation.state,
          );
          return; // No mostrar el menú TIS hasta que responda
        }

        // Si declinó → informar limitación y mostrar menú sin disponibilidad
        if (consent.status === ConsentStatus.Declined) {
          await this.whatsAppService.sendTextMessage(
            senderId,
            `ℹ️ ${employee.firstName}, no recibirás notificaciones de disponibilidad ` +
              `ya que no autorizaste el uso de este número.\n\n` +
              `Si cambias de opinión puedes escribir *consentimiento* para revisarlo.`,
          );
        }
      }
      // ────────────────────────────────────────────────────────────────────────

      await this._sendWelcomeMessages(senderId, employee, isTisAgent);

      return { success: true };
    } catch (error) {
      this.logger.error("Error en WelcomeUseCase:", error);
      try {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Lo siento, ocurrió un error al mostrar el mensaje de bienvenida. Por favor, intenta nuevamente.",
        );
      } catch (e) {
        this.logger.error("Error enviando mensaje de error:", e);
      }
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Recordatorio de calificación pendiente ──────────────────────────────────

  /**
   * Muestra al funcionario el aviso de calificación pendiente.
   * Registra el ticketId en tempData y el estado "ticket_rating" para que
   * TicketListingUseCase procese la respuesta del botón.
   * Retorna true si el flujo fue interrumpido para la calificación.
   */
  private async _sendPendingRatingReminder(
    senderId: string,
    ticket: TicketDocument,
    conversation: any,
  ): Promise<boolean> {
    try {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `⭐ *Tienes una calificación pendiente*\n\n` +
          `Tu ticket *${ticket.ticketNumber}* fue resuelto y todavía no has calificado el servicio.\n` +
          `Por favor tómate un momento para hacerlo antes de continuar.`,
      );

      await this.whatsAppService.sendButtonMessage(senderId, {
        bodyText:
          `*${ticket.ticketNumber}*\n` +
          `🔍 ${ticket.description}\n` +
          `📍 ${ticket.location}`,
        footerText: "¿Cómo fue el servicio recibido?",
        buttons: [
          { id: "rate_good", text: "👍 Bueno" },
          { id: "rate_bad", text: "👎 Malo" },
          { id: "rate_false", text: "🚫 No fue real" },
        ],
      });

      // Guardar el ticket en datos temporales y pasar al estado de calificación
      await this.conversationService.updateTempData?.(conversation._id, {
        selectedTicketId: ticket._id.toString(),
      });
      await this.conversationService.updateState(
        conversation._id,
        "ticket_rating",
        conversation.state,
      );

      return true;
    } catch (e) {
      this.logger.warn("No se pudo enviar recordatorio de calificación:", e);
      return false;
    }
  }

  // ─── Mensajes de bienvenida ──────────────────────────────────────────────────

  /**
   * Envía los mensajes de bienvenida según el perfil detectado:
   *
   * - Agente TIS   → bienvenida + opciones: [Crear mi ticket] [Ticket para otro] [Panel TIS]
   * - Funcionario  → bienvenida + opciones: [Abrir ticket] [Mis tickets]
   * - Ciudadano    → bienvenida genérica sin opciones de ticket
   */
  private async _sendWelcomeMessages(
    senderId: string,
    employee: Employee | null,
    isTisAgent: boolean,
  ): Promise<void> {
    if (employee) {
      await this.whatsAppService.sendTextMessage(
        senderId,
        `¡Bienvenido/a, ${employee.firstName}!`,
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        `👋 Soy el asistente virtual del Municipio de Esmeraldas.`,
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        `Puedo ayudarte a consultar información municipal, reportar incidentes y gestionar tickets de soporte técnico de la Dirección de Tecnologías de la Información.`,
      );

      if (isTisAgent) {
        // Personal de TIS: ticket propio, para otro y panel de gestión
        await this.whatsAppService.sendButtonMessage(senderId, {
          bodyText: "Como parte del equipo de TIS, ¿qué deseas hacer?",
          buttons: [
            { id: "tcuc_own", text: "Crear mi ticket" },
            { id: "tcuc_other", text: "Ticket para otro" },
            { id: "mgmt_panel", text: "Panel TIS" },
          ],
        });
      } else {
        // Funcionario regular: abrir ticket o consultar los suyos
        await this.whatsAppService.sendButtonMessage(senderId, {
          bodyText: "¿En qué puedo ayudarte hoy?",
          footerText: "También puedes preguntarme lo que necesites",
          buttons: [
            { id: "tcuc_own", text: "Abrir ticket" },
            { id: "ltuc_my_tickets", text: "Mis tickets" },
          ],
        });
      }
    } else {
      // Ciudadano no identificado en el ERP
      await this.whatsAppService.sendTextMessage(
        senderId,
        "¡Bienvenido a Esmeraldas La Bella! 👋 Estamos aquí para ayudarte a mejorar tu experiencia en el municipio.",
      );

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Aquí encontrarás información sobre los servicios y herramientas que ofrecemos. ¡No dudes en preguntar si necesitas ayuda en algo específico!",
      );
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private _normalizePhone(waPhone: string): string {
    if (waPhone.startsWith("593") && waPhone.length === 12) {
      return "0" + waPhone.slice(3);
    }
    return waPhone;
  }
}
