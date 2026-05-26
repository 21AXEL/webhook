// availability-template.job.ts
// Cron que se ejecuta exactamente a las 08:00 AM hora Ecuador (UTC-5 = 13:00 UTC)
// de lunes a viernes. Envía el template de disponibilidad a todos los agentes TIS
// activos y notifica al admin el resumen de agentes contactados.

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { ErpService } from "@shared/modules/erp/erp.service";
import { WhatsAppService } from "src/contact/webhook/services/whatsapp.service";
import { AgentAvailabilityService } from "@shared/modules/agent-availability/agent-availability.service";
import { SupportLine } from "@shared/modules/tickets/ticket.constants";
import { AgentConsentService } from "@shared/modules/agent-consent/agent-consent.service";

// Mapeo de unidad ERP → SupportLine (ajustar a los nombres exactos del ERP)
const UNIT_TO_LINE: Record<string, SupportLine> = {
  "UNIDAD DE SOPORTE TECNOLOGICO": SupportLine.TechnicalSupport,
  "UNIDAD DE APLICACIONES Y SISTEMAS": SupportLine.Systems,
  "UNIDAD DE INFRAESTRUCTURA": SupportLine.Infrastructure,
  // Fallback: la dirección completa va a TechnicalSupport
  "DIRECCION DE TECNOLOGIAS DE LA INFORMACION": SupportLine.TechnicalSupport,
};

function resolveLineFromDepartment(
  department: string | null | undefined,
): SupportLine {
  if (!department) return SupportLine.TechnicalSupport;
  const upper = department.toUpperCase().trim();
  return UNIT_TO_LINE[upper] ?? SupportLine.TechnicalSupport;
}

/** Convierte teléfono local ecuatoriano a  formato WhatsApp (593XXXXXXXXX) */
function toWaPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-]/g, "").trim();
  if (clean.startsWith("593")) return clean;
  if (clean.startsWith("0")) return "593" + clean.slice(1);
  return null;
}

@Injectable()
export class AvailabilityTemplateJob {
  private readonly logger = new Logger(AvailabilityTemplateJob.name);

  /** Nombre del template aprobado en WhatsApp Business Manager */
  private readonly templateName: string;
  /** Número WA del admin que recibe el resumen (ej:  593XXXXXXXXX) */
  private readonly adminPhone: string;

  constructor(
    private readonly erpService: ErpService,
    private readonly whatsAppService: WhatsAppService,
    private readonly availabilityService: AgentAvailabilityService,
    private readonly configService: ConfigService,
    private readonly agentConsentService: AgentConsentService,
  ) {
    this.templateName =
      configService.get<string>("AVAILABILITY_TEMPLATE_NAME") ??
      "disponibilidad_diaria";
    this.adminPhone = configService.get<string>("ADMIN_WA_PHONE") ?? "";
  }

  /**
   * Cron: 08:00 AM Ecuador (UTC-5) → 13:00 UTC, lunes a viernes.
   * Formato NestJS Schedule (6 campos): segundos minutos horas día mes díaSemana
   */
  @Cron("0 0 13 * * 1-5", { timeZone: "UTC" })
  async sendAvailabilityTemplates(): Promise<void> {
    this.logger.log("▶ Iniciando envío de templates de disponibilidad");

    // Solo agentes que aceptaron explícitamente
    const consentedAgents = await this.agentConsentService.findAllAccepted();

    if (consentedAgents.length === 0) {
      this.logger.warn("No hay agentes TIS con consentimiento activo");
      return;
    }

    // 1. Obtener todos los agentes TIS activos con teléfono
    const agents = await this.erpService.searchEmployees(); // retorna todos
    const tisAgents = agents.filter(
      (a) => a.department && this._isTisUnit(a.department),
    );

    if (tisAgents.length === 0) {
      this.logger.warn("No se encontraron agentes TIS activos en el ERP");
      return;
    }

    const date = AgentAvailabilityService.todayEcuador();
    let sent = 0;
    let skipped = 0;

    for (const agent of consentedAgents) {
      const waPhone = agent.waPhone;
      const line = resolveLineFromDepartment(
        (await this.erpService.getEmployeeByCitizenId(agent.citizenId))
          ?.department,
      );

      // Crear registro de disponibilidad (PENDING)
      await this.availabilityService.upsertForToday({
        citizenId: agent.citizenId,
        waPhone,
        name: agent.name,
        line,
        date,
      });

      // Enviar template de WhatsApp (vacío)..
      try {
        const result = await this.whatsAppService.sendTemplateMessage(
          waPhone,
          this.templateName,
          [
            {
              type: "button",
              sub_type: "flow",
              index: "0",
              parameters: [
                {
                  type: "action",
                  action: {
                    flow_token: `avail_${agent.citizenId}_${date}`, // token único por envío
                  },
                },
              ],
            },
          ],
          "es",
        );

        // Guardar el message ID del template para auditoría
        const messageId = result?.messages?.[0]?.id ?? null;
        if (messageId) {
          await this.availabilityService.upsertForToday({
            citizenId: agent.citizenId,
            waPhone,
            name: agent.name,
            line,
            date,
            templateMessageId: messageId,
          });
        }

        sent++;
        this.logger.log(`✅ Template enviado a ${agent.name} (${waPhone})`);
      } catch (err: any) {
        this.logger.error(
          `❌ Error enviando template a ${agent.name}: ${err.message}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `▶ Templates enviados: ${sent} exitosos, ${skipped} omitidos`,
    );

    // 2. Notificar al admin el inicio del día
    await this._notifyAdminStart(sent, skipped, date);
  }

  // ─── Privados ─────────────────────────────────────────────────────────────

  private _isTisUnit(department: string): boolean {
    const upper = department.toUpperCase().trim();
    return Object.keys(UNIT_TO_LINE).some((u) => upper === u);
  }

  private async _notifyAdminStart(
    sent: number,
    skipped: number,
    date: string,
  ): Promise<void> {
    if (!this.adminPhone) return;
    try {
      await this.whatsAppService.sendTextMessage(
        this.adminPhone,
        `📋 *Inicio de jornada ${date}*\n\n` +
          `Se enviaron templates de disponibilidad:\n` +
          `✅ Enviados: *${sent}*\n` +
          `⚠️ Sin teléfono/error: *${skipped}*\n\n` +
          `Las respuestas llegarán conforme los agentes confirmen.`,
      );
    } catch (err: any) {
      this.logger.error(`Error notificando al admin: ${err.message}`);
    }
  }

  /**
   * Dispara el envío del template solo a las cédulas indicadas.
   * Usado por el endpoint de admin para pruebas manuales.
   * No requiere que los agentes sean de TIS — útil para testing.
   */
  async triggerForCedulas(
    cedulas: string[],
  ): Promise<{ sent: number; skipped: number; details: string[] }> {
    this.logger.log(
      `▶ Trigger manual para ${cedulas.length} cédula(s): ${cedulas.join(", ")}`,
    );

    const date = AgentAvailabilityService.todayEcuador();
    let sent = 0;
    let skipped = 0;
    const details: string[] = [];

    for (const cedula of cedulas) {
      const agent = await this.erpService.getEmployeeByCitizenId(cedula.trim());

      if (!agent) {
        const msg = `⚠️ Cédula ${cedula} no encontrada en ERP`;
        this.logger.warn(msg);
        details.push(msg);
        skipped++;
        continue;
      }

      const waPhone = toWaPhone(agent.mobile ?? agent.phone ?? null);

      if (!waPhone) {
        const msg = `⚠️ ${agent.fullName} no tiene teléfono válido`;
        this.logger.warn(msg);
        details.push(msg);
        skipped++;
        continue;
      }

      const line = resolveLineFromDepartment(agent.department);

      // Registrar disponibilidad como PENDING
      await this.availabilityService.upsertForToday({
        citizenId: agent.citizenId,
        waPhone,
        name: agent.fullName,
        line,
        date,
      });

      // Enviar template
      try {
        const result = await this.whatsAppService.sendTemplateMessage(
          waPhone,
          this.templateName,
          [
            {
              type: "button",
              sub_type: "flow",
              index: "0",
              parameters: [
                {
                  type: "action",
                  action: {
                    flow_token: `avail_${agent.citizenId}_${date}`, // token único por envío
                  },
                },
              ],
            },
          ],
          "es",
        );

        const messageId = result?.messages?.[0]?.id ?? null;
        if (messageId) {
          await this.availabilityService.upsertForToday({
            citizenId: agent.citizenId,
            waPhone,
            name: agent.fullName,
            line,
            date,
            templateMessageId: messageId,
          });
        }

        const msg = `✅ Template enviado a ${agent.fullName} (${waPhone})`;
        this.logger.log(msg);
        details.push(msg);
        sent++;
      } catch (err: any) {
        const msg = `❌ Error enviando a ${agent.fullName}: ${err.message}`;
        this.logger.error(msg);
        details.push(msg);
        skipped++;
      }
    }

    // Notificar al admin del resultado
    if (this.adminPhone) {
      const resumen =
        `🧪 *Trigger manual de disponibilidad*\n\n` +
        `✅ Enviados: ${sent}\n` +
        `⚠️ Omitidos: ${skipped}\n\n` +
        details.map((d) => `• ${d}`).join("\n");

      this.whatsAppService
        .sendTextMessage(this.adminPhone, resumen)
        .catch((e) =>
          this.logger.warn(`No se pudo notificar al admin: ${e.message}`),
        );
    }

    return { sent, skipped, details };
  }
}
