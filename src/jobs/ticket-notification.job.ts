// ticket-notification.job.ts
// Cron que se ejecuta cada 5 minutos de 08:00 a 16:55 hora Ecuador (UTC-5).
// Procesa la cola de tickets sin asignar y notifica a los agentes disponibles
// de la línea correspondiente.

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { WhatsAppService } from "src/contact/webhook/services/whatsapp.service";
import { AgentAvailabilityService } from "@shared/modules/agent-availability/agent-availability.service";
import { TicketQueueService } from "@shared/modules/ticket-queue/ticket-queue.service";
import { TicketQueueDocument } from "@shared/modules/ticket-queue/ticket-queue.schema";

@Injectable()
export class TicketNotificationJob {
  private readonly logger = new Logger(TicketNotificationJob.name);

  private readonly adminPhone: string;
  /** Minutos antes de renotificar si nadie acepta */
  private readonly retryMinutes = 15;

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly availabilityService: AgentAvailabilityService,
    private readonly ticketQueueService: TicketQueueService,
    private readonly configService: ConfigService,
  ) {
    this.adminPhone = configService.get<string>("ADMIN_WA_PHONE") ?? "";
  }

  /**
   * Cron: cada 5 minutos de 13:00 a 21:55 UTC (08:00 a 16:55 ECT), lunes a viernes.
   * La hora 21 cubre hasta las 16:55 ECT; a las 22:00 UTC ya serían las 17:00 ECT.
   */
  @Cron("0 */5 13-21 * * 1-5", { timeZone: "UTC" })
  async processQueue(): Promise<void> {
    if (!TicketQueueService.isWorkingHour()) {
      // Defensa extra: si el cron se dispara fuera de horario, salir limpio
      return;
    }

    const due = await this.ticketQueueService.findDue();

    if (due.length === 0) return;

    this.logger.log(`▶ Cola de tickets: ${due.length} entradas por procesar`);

    for (const entry of due) {
      await this._processEntry(entry);
    }
  }

  // ─── Privados ─────────────────────────────────────────────────────────────

  private async _processEntry(entry: TicketQueueDocument): Promise<void> {
    const {
      _id,
      ticketNumber,
      line,
      reportedByName,
      location,
      ticketCreatedAt,
      notifiedAgents,
    } = entry;

    // Agentes disponibles hoy en esta línea, que aún no hayan sido notificados
    const available = await this.availabilityService.findAvailableToday(line);
    const toNotify = available.filter(
      (a) => !notifiedAgents.includes(a.citizenId),
    );

    if (toNotify.length === 0) {
      // No hay agentes nuevos disponibles
      this.logger.warn(
        `Ticket ${ticketNumber} — sin agentes disponibles en línea ${line}` +
          (notifiedAgents.length > 0
            ? ` (${notifiedAgents.length} ya notificados)`
            : ""),
      );

      // Si ya se notificó a alguien, simplemente reintenta más tarde
      // Si nadie fue notificado nunca, avisar al admin
      if (notifiedAgents.length === 0) {
        await this._notifyAdminNoAgents(ticketNumber, line);
      }

      await this.ticketQueueService.rescheduleToNextDay(_id.toString());
      return;
    }

    const waitMinutes = Math.floor(
      (Date.now() - new Date(ticketCreatedAt).getTime()) / 60_000,
    );
    const waitText = this._formatWait(waitMinutes);

    const notifiedIds: string[] = [];

    for (const agent of toNotify) {
      try {
        await this.whatsAppService.sendTextMessage(
          agent.waPhone,
          `🔔 *Ticket pendiente de asignación*\n\n` +
            `📋 *${ticketNumber}*\n` +
            `🔧 Línea: ${this._lineLabel(line)}\n` +
            `👤 Solicitante: ${reportedByName}\n` +
            `📍 Ubicación: ${location}\n` +
            `⏱️ Tiempo sin atención: *${waitText}*\n\n` +
            `Escríbenos para gestionar este ticket.`,
        );
        notifiedIds.push(agent.citizenId);
        this.logger.log(`Notificado ${agent.name} → ticket ${ticketNumber}`);
      } catch (err: any) {
        this.logger.error(
          `Error notificando a ${agent.name} sobre ${ticketNumber}: ${err.message}`,
        );
      }
    }

    if (notifiedIds.length > 0) {
      await this.ticketQueueService.markNotified(
        _id.toString(),
        notifiedIds,
        this.retryMinutes,
      );
    }
  }

  private _formatWait(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }

  private _lineLabel(line: string): string {
    const labels: Record<string, string> = {
      TECHNICAL_SUPPORT: "Soporte Técnico",
      INFRASTRUCTURE: "Infraestructura",
      SYSTEMS: "Sistemas",
    };
    return labels[line] ?? line;
  }

  private async _notifyAdminNoAgents(
    ticketNumber: string,
    line: string,
  ): Promise<void> {
    if (!this.adminPhone) return;
    try {
      await this.whatsAppService.sendTextMessage(
        this.adminPhone,
        `⚠️ *Sin agentes disponibles*\n\n` +
          `El ticket *${ticketNumber}* (${this._lineLabel(line)}) no pudo ser ` +
          `notificado porque no hay agentes disponibles en esa línea hoy.\n\n` +
          `Se reintentará mañana a las 08:00.`,
      );
    } catch (err: any) {
      this.logger.error(`Error notificando al admin: ${err.message}`);
    }
  }
}
