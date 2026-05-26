/**
 * admin.controller.ts  ← VERSIÓN EXTENDIDA
 * ─────────────────────────────────────────────────────────────────────────────
 * Agrega los endpoints de gestión de consentimiento al controller existente.
 *
 * Rutas nuevas:
 *   GET  /admin/consent               → Listar personal TIS con estado de consentimiento
 *   POST /admin/consent/send          → Enviar aviso de consentimiento (batch o individual)
 *   POST /admin/consent/send/:cedula  → Enviar a un agente específico
 *
 * Rutas existentes (sin cambios):
 *   POST /admin/availability/send     → Enviar template de disponibilidad
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AvailabilityTemplateJob } from "@jobs/availability-template.job";
import { ConsentAdminService } from "./consent-admin.service";
import { ConsentStatus } from "@shared/modules/agent-consent/agent-consent.schema";

const GEOAPI = "https://geoapi.esmeraldas.gob.ec/new/login";

// Cédulas de prueba hardcodeadas como default
const TEST_CEDULAS = ["0803768530", "0802305581"];

@Controller("admin")
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly availabilityJob: AvailabilityTemplateJob,
    private readonly consentAdminService: ConsentAdminService,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: { email: string; password: string }): Promise<any> {
    if (!body?.email || !body?.password)
      throw new BadRequestException("email y password son requeridos");

    try {
      const resp = await fetch(GEOAPI, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: body.email,
          password: body.password,
          time: 8,
          tipo: "h",
        }),
      });

      const data = (await resp.json()) as any;

      if (!resp.ok) {
        this.logger.warn(
          `Login fallido para ${body.email}: ${JSON.stringify(data)}`,
        );
        throw new BadRequestException(
          data?.message ?? data?.error ?? "Credenciales inválidas",
        );
      }

      this.logger.log(`Login exitoso: ${body.email}`);
      return data; // transparente: lo que devuelva geoapi llega al cliente
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Error contactando geoapi: ${err.message}`);
      throw new InternalServerErrorException(
        "No se pudo contactar el servidor de autenticación",
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISPONIBILIDAD (existente — sin cambios)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /admin/availability/send
   * Sin body / {} → cédulas de prueba
   * { "cedulas": [] } → job completo (todos los TIS)
   * { "cedulas": ["XXXXXXXXXX"] } → cédulas específicas
   */
  @Post("availability/send")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async sendAvailability(
    @Body() body?: { cedulas?: string[] },
  ): Promise<object> {
    const cedulas = body?.cedulas;

    if (cedulas === undefined || cedulas === null) {
      this.logger.log("Trigger manual con cédulas de prueba por defecto");
      return this.availabilityJob.triggerForCedulas(TEST_CEDULAS);
    }

    if (cedulas.length === 0) {
      this.logger.log("Trigger manual → job completo (todos los agentes TIS)");
      await this.availabilityJob.sendAvailabilityTemplates();
      return { triggered: "full", message: "Job completo ejecutado" };
    }

    this.logger.log(`Trigger manual para cédulas: ${cedulas.join(", ")}`);
    return this.availabilityJob.triggerForCedulas(cedulas);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSENTIMIENTO (nuevo)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * GET /admin/consent
   * Lista todo el personal TIS del ERP con su estado de consentimiento.
   *
   * Query params opcionales:
   *   ?status=PENDING|ACCEPTED|DECLINED|NO_RECORD  → filtra por estado
   *
   * Respuesta:
   * {
   *   total: number,
   *   summary: { ACCEPTED: n, DECLINED: n, PENDING: n, NO_RECORD: n },
   *   agents: AgentConsentRow[]
   * }
   */
  @Get("consent")
  @UseGuards(AdminGuard)
  async listConsent(@Query("status") status?: string): Promise<object> {
    const validStatuses = [
      ConsentStatus.Accepted,
      ConsentStatus.Declined,
      ConsentStatus.Pending,
      "NO_RECORD",
    ];

    const filterStatus =
      status && validStatuses.includes(status as ConsentStatus)
        ? (status as ConsentStatus | "NO_RECORD")
        : undefined;

    const agents = await this.consentAdminService.listTisAgents(filterStatus);

    // Resumen de estados
    const summary = agents.reduce(
      (acc, a) => {
        const key = a.consentStatus;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      total: agents.length,
      summary,
      agents,
    };
  }

  /**
   * POST /admin/consent/send
   * Envía el template de solicitud de consentimiento.
   *
   * Body:
   *   {}                        → envía a TODO el personal TIS sin consentimiento aún
   *   { "cedulas": [] }         → igual que arriba (batch completo pendientes)
   *   { "cedulas": ["XXXXXX"] } → solo a esas cédulas
   *   { "force": true }         → envía incluso a quienes ya aceptaron
   *
   * Casos de uso:
   *   • Primera vez: no pasar nada → llega a todo el personal sin respuesta
   *   • Nuevo empleado: pasar su cédula
   *   • Re-solicitud: pasar cédula + force:true
   */
  @Post("consent/send")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async sendConsentBatch(
    @Body() body?: { cedulas?: string[]; force?: boolean },
  ): Promise<object> {
    const cedulas = body?.cedulas ?? null;
    const force = body?.force ?? false;

    this.logger.log(
      cedulas?.length
        ? `Consentimiento → cédulas específicas: ${cedulas.join(", ")}`
        : `Consentimiento → batch completo (force=${force})`,
    );

    const result = await this.consentAdminService.sendConsentTemplate(
      cedulas && cedulas.length > 0 ? cedulas : null,
      force,
    );

    return result;
  }

  /**
   * POST /admin/consent/send/:cedula
   * Shortcut para enviar el aviso a un único agente por cédula.
   * Equivale a POST /admin/consent/send { "cedulas": ["<cedula>"] }
   */
  @Post("consent/send/:cedula")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async sendConsentOne(@Param("cedula") cedula: string): Promise<object> {
    this.logger.log(`Consentimiento → agente individual: ${cedula}`);
    return this.consentAdminService.sendConsentTemplate([cedula]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH REQUERIDO: intent-processor.service.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// Cuando un agente responde a un TEMPLATE con quick_reply, WhatsApp envía:
//   { "type": "button", "button": { "payload": "consent_accept", "text": "..." } }
//
// Esto es DISTINTO de interactive.button_reply (que viene de sendButtonMessage).
// El intent processor actual NO maneja message.type === "button".
//
// Agregar en _resolveIntentFromInteractive() o en processMessage() de
// src/contact/intent-processor.service.ts, ANTES del bloque de multimedia:
//
// ─────────────────────────────────────────────────────────────────────────────
// // 0.5 — Template quick_reply (type: "button")
// if (messageType === "button") {
//   const payload: string = message.button?.payload ?? "";
//   if (payload.startsWith("consent_")) return "agent_consent_pending";
//   if (payload.startsWith("availability_")) {
//     // ya manejado por el estado activo de la conversación
//     return null;
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
//
// Y en AgentConsentUseCase.execute(), el segundo parámetro es `message` (no buttonId).
// Extraer el payload así:
//
//   const buttonId =
//     message?.interactive?.button_reply?.id ??  // de sendButtonMessage
//     message?.button?.payload ??                 // de template quick_reply
//     null;
// ─────────────────────────────────────────────────────────────────────────────
