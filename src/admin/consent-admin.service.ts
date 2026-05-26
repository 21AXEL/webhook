/**
 * consent-admin.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Servicio de administración para el flujo de consentimiento de agentes TIS.
 *
 * Responsabilidades:
 *  1. Listar todo el personal TIS del ERP con su estado de consentimiento actual.
 *  2. Enviar el template de solicitud de consentimiento (proactivo) a uno o varios
 *     agentes, registrándolos como PENDING en AgentConsent.
 *
 * Variable de entorno requerida:
 *   CONSENT_TEMPLATE_NAME   Nombre del template aprobado en Meta
 *                           (default: "solicitud_consentimiento_tic")
 *
 * El template debe tener:
 *   • BODY con {{1}} = nombre del agente
 *   • Dos botones QUICK_REPLY:
 *       index 0 → payload "consent_accept"
 *       index 1 → payload "consent_decline"
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ErpService } from "@shared/modules/erp/erp.service";
import { AgentConsentService } from "@shared/modules/agent-consent/agent-consent.service";
import { ConsentStatus } from "@shared/modules/agent-consent/agent-consent.schema";
import { WhatsAppService } from "@contact/webhook/services/whatsapp.service";
import { ConversationService } from "@contact/conversation.service";

// ─── Tipos de respuesta ───────────────────────────────────────────────────────

export interface AgentConsentRow {
  citizenId: string;
  fullName: string;
  department: string | null;
  waPhone: string | null; // Teléfono en formato WA (593XXXXXXXXX) o null
  rawPhone: string | null; // Teléfono crudo del ERP
  consentStatus: ConsentStatus | "NO_RECORD";
  consentedAt: Date | null;
  declinedAt: Date | null;
  lastAskedAt: Date | null;
}

export interface SendConsentResult {
  sent: number;
  skipped: number;
  details: Array<{
    citizenId: string;
    name: string;
    status: "sent" | "skipped";
    reason?: string;
  }>;
}

@Injectable()
export class ConsentAdminService {
  private readonly logger = new Logger(ConsentAdminService.name);
  private readonly templateName: string;

  constructor(
    private readonly erpService: ErpService,
    private readonly agentConsentService: AgentConsentService,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly conversationService: ConversationService, // ← NUEVO
  ) {
    this.templateName =
      this.configService.get<string>("CONSENT_TEMPLATE_NAME") ??
      "solicitud_consentimiento_tic_";
  }

  // ─── Listado ──────────────────────────────────────────────────────────────

  /**
   * Devuelve todos los agentes TIS del ERP cruzados con su registro de consentimiento.
   * @param filterStatus  Si se indica, filtra por ese estado de consentimiento.
   */
  async listTisAgents(
    filterStatus?: ConsentStatus | "NO_RECORD",
  ): Promise<AgentConsentRow[]> {
    // 1. Obtener agentes TIS del ERP
    const allEmployees = await this.erpService.searchEmployees();
    console.log("📋 Agentes TIS:", allEmployees[0]);
    const tisAgents = allEmployees.filter((e) => this.erpService.isTisAgent(e));
    console.log("📋 Agentes TIS filtrados:", tisAgents[0]);
    // 2. Obtener todos los registros de consentimiento de una vez
    const consentDocs = await this.agentConsentService.findAll();
    const consentMap = new Map(consentDocs.map((d) => [d.citizenId, d]));

    // 3. Fusionar
    const rows: AgentConsentRow[] = tisAgents.map((emp) => {
      const consent = consentMap.get(emp.citizenId) ?? null;
      const waPhone = this._toWaPhone(
        emp.mobile?.length === 10 ? emp.mobile : (emp.phone ?? null),
      );

      return {
        citizenId: emp.citizenId,
        fullName: emp.fullName,
        department: emp.department ?? null,
        waPhone,
        rawPhone: emp.mobile ?? emp.phone ?? null,
        consentStatus: consent ? consent.status : "NO_RECORD",
        consentedAt: consent?.consentedAt ?? null,
        declinedAt: consent?.declinedAt ?? null,
        lastAskedAt: consent?.lastAskedAt ?? null,
      };
    });

    if (!filterStatus) return rows;
    return rows.filter((r) => r.consentStatus === filterStatus);
  }

  // ─── Envío de template ────────────────────────────────────────────────────

  /**
   * Envía el template de solicitud de consentimiento.
   *
   * @param cedulas  Lista de cédulas. Si es null o [] → envía a TODO el personal TIS
   *                 que aún no ha aceptado (NO_RECORD o DECLINED).
   * @param force    Si true → envía también a los que ya ACEPTARON (re-solicitud).
   */
  async sendConsentTemplate(
    cedulas: string[] | null,
    force = false,
  ): Promise<SendConsentResult> {
    const agents = await this.listTisAgents();
    const result: SendConsentResult = { sent: 0, skipped: 0, details: [] };

    // Filtrar según parámetros
    let targets = agents;

    if (cedulas && cedulas.length > 0) {
      const set = new Set(cedulas.map((c) => c.trim()));
      targets = agents.filter((a) => set.has(a.citizenId));

      // Reportar cédulas no encontradas en TIS
      for (const c of set) {
        if (!agents.find((a) => a.citizenId === c)) {
          result.details.push({
            citizenId: c,
            name: "—",
            status: "skipped",
            reason: "No encontrado en personal TIS del ERP",
          });
          result.skipped++;
        }
      }
    } else {
      // Sin filtro → solo los que no han aceptado (a menos que force=true)
      if (!force) {
        targets = agents.filter(
          (a) => a.consentStatus !== ConsentStatus.Accepted,
        );
      }
    }

    for (const agent of targets) {
      // ── Validaciones ──────────────────────────────────────────────────────
      if (!agent.waPhone) {
        this.logger.warn(`${agent.fullName} sin teléfono válido — omitido`);
        result.details.push({
          citizenId: agent.citizenId,
          name: agent.fullName,
          status: "skipped",
          reason: "Sin teléfono WhatsApp válido",
        });
        result.skipped++;
        continue;
      }

      if (!force && agent.consentStatus === ConsentStatus.Accepted) {
        result.details.push({
          citizenId: agent.citizenId,
          name: agent.fullName,
          status: "skipped",
          reason: "Ya tiene consentimiento ACCEPTED",
        });
        result.skipped++;
        continue;
      }

      // ── Registrar como PENDING antes de enviar ────────────────────────────
      await this.agentConsentService.upsertPending({
        citizenId: agent.citizenId,
        waPhone: agent.waPhone,
        name: agent.fullName,
      });
      await this.agentConsentService.markAsked(agent.citizenId);

      // ── Enviar template ───────────────────────────────────────────────────
      try {
        await this.whatsAppService.sendTemplateMessage(
          agent.waPhone,
          this.templateName,
          [
            // BODY: {{1}} = primer nombre del agente
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: agent.fullName.split(" ")[0], // primer nombre
                },
              ],
            },
            // BOTÓN 0: "✅ Sí, autorizo" → payload consent_accept
            {
              type: "button",
              sub_type: "quick_reply",
              index: "0",
              parameters: [{ type: "payload", payload: "consent_accept" }],
            },
            // BOTÓN 1: "❌ No autorizo" → payload consent_decline
            {
              type: "button",
              sub_type: "quick_reply",
              index: "1",
              parameters: [{ type: "payload", payload: "consent_decline" }],
            },
          ],
          "es",
        );

        // ── NUEVO: Pre-sembrar conversación en estado agent_consent_pending ──────
        // Así cuando el agente responda (botón o texto) ya hay un estado activo
        // que evita que el IntentProcessor caiga a detección por IA.
        try {
          const existing = await this.conversationService.getBySenderId(
            agent.waPhone,
          );
          if (existing) {
            await this.conversationService.updateState(
              existing._id.toString(),
              "agent_consent_pending",
              existing.state,
            );
          } else {
            const conv = await this.conversationService.create(agent.waPhone);
            await this.conversationService.updateState(
              conv._id.toString(),
              "agent_consent_pending",
              "initial",
            );
          }
          this.logger.log(
            `✅ Conversación pre-sembrada para ${agent.waPhone} → agent_consent_pending`,
          );
        } catch (convErr: unknown) {
          this.logger.warn(
            `⚠️ No se pudo pre-sembrar conversación para ${agent.waPhone}: ${(convErr as Error).message}`,
          );
          // No bloquear el flujo si falla la conversación
        }
        // ─────────────────────────────────────────────────────────────────────────

        result.details.push({
          citizenId: agent.citizenId,
          name: agent.fullName,
          status: "sent",
        });
        result.sent++;
      } catch (err: unknown) {
        const msg = (err as Error).message;
        this.logger.error(`❌ Error enviando a ${agent.fullName}: ${msg}`);
        result.details.push({
          citizenId: agent.citizenId,
          name: agent.fullName,
          status: "skipped",
          reason: `Error API: ${msg}`,
        });
        result.skipped++;
      }
    }

    this.logger.log(
      `Consentimiento enviado — ✅ ${result.sent} enviados, ⚠️ ${result.skipped} omitidos`,
    );

    return result;
  }

  // ─── Helper ───────────────────────────────────────────────────────────────

  private _toWaPhone(phone: string | null | undefined): string | null {
    if (!phone) return null;

    // Buscar números separados por / , ; o espacios
    const phones = phone
      .split(/[\/,;]+/)
      .map((p) => p.replace(/\D/g, "").trim())
      .filter(Boolean);

    // Priorizar móvil ecuatoriano que empiece con 09
    const mobile = phones.find((p) => p.startsWith("09"));

    if (!mobile) return null;

    // Convertir 09XXXXXXXX a 5939XXXXXXXX
    return "593" + mobile.slice(1);
  }
}
