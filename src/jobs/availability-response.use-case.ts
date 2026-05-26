// availability-response.use-case.ts
// Procesa la respuesta del agente al template de disponibilidad de las 8am.
// Se activa cuando llega un buttonId "availability_yes" o "availability_no"
// desde el IntentProcessor.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WhatsAppService } from "src/contact/webhook/services/whatsapp.service";
import { AgentAvailabilityService } from "@shared/modules/agent-availability/agent-availability.service";
import { AvailabilityStatus } from "@shared/modules/agent-availability/agent-availability.schema";
import { ErpService } from "@shared/modules/erp/erp.service";

/** IDs de botón que debe manejar este use-case */
export const AVAILABILITY_BUTTON_IDS = [
  "availability_yes",
  "availability_no",
] as const;
export type AvailabilityButtonId = (typeof AVAILABILITY_BUTTON_IDS)[number];

@Injectable()
export class AvailabilityResponseUseCase {
  private readonly logger = new Logger(AvailabilityResponseUseCase.name);
  private readonly adminPhone: string;

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly availabilityService: AgentAvailabilityService,
    private readonly erpService: ErpService,
    private readonly configService: ConfigService,
  ) {
    this.adminPhone = configService.get<string>("ADMIN_WA_PHONE") ?? "";
  }

  // ─── Punto de entrada ─────────────────────────────────────────────────────

  async handle(
    senderId: string,
    buttonId: AvailabilityButtonId,
  ): Promise<{ success: boolean }> {
    const isAvailable = buttonId === "availability_yes";
    const newStatus = isAvailable
      ? AvailabilityStatus.Available
      : AvailabilityStatus.Unavailable;

    // Identificar al agente por su waPhone
    const record = await this.availabilityService.findTodayByPhone(senderId);

    if (!record) {
      // El agente respondió pero no tiene registro de hoy
      // (puede ocurrir si respondió fuera del día laboral)
      this.logger.warn(
        `Respuesta de disponibilidad sin registro del día: ${senderId}`,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "⚠️ No encontramos tu registro de disponibilidad para hoy. " +
          "Por favor contacta al administrador de TIS.",
      );
      return { success: false };
    }

    // Actualizar estado solo si estaba PENDING (evita doble respuesta)
    const updated = await this.availabilityService.markResponse(
      record.citizenId,
      newStatus,
    );

    if (!updated) {
      // Ya había respondido antes
      await this.whatsAppService.sendTextMessage(
        senderId,
        `Ya registramos tu disponibilidad para hoy. ¡Gracias, ${record.name.split(" ")[0]}!`,
      );
      return { success: true };
    }

    // Confirmar al agente
    const confirmText = isAvailable
      ? `✅ ¡Perfecto, ${record.name.split(" ")[0]}! Tu disponibilidad para hoy quedó registrada.\n\nTe notificaremos cuando haya tickets pendientes en tu línea.`
      : `👍 Entendido, ${record.name.split(" ")[0]}. Quedaste registrado como NO disponible hoy.\n\nSi cambia tu situación, comunícate con el administrador de TIS.`;

    await this.whatsAppService.sendTextMessage(senderId, confirmText);

    // Notificar al admin
    await this._notifyAdmin(record.name, record.line, isAvailable);

    this.logger.log(
      `Disponibilidad registrada — ${record.name} → ${newStatus}`,
    );

    return { success: true };
  }

  // ─── Privados ─────────────────────────────────────────────────────────────

  private async _notifyAdmin(
    name: string,
    line: string,
    isAvailable: boolean,
  ): Promise<void> {
    if (!this.adminPhone) return;

    const emoji = isAvailable ? "✅" : "❌";
    const estado = isAvailable ? "DISPONIBLE" : "NO DISPONIBLE";
    const lineLabel = this._lineLabel(line);

    try {
      await this.whatsAppService.sendTextMessage(
        this.adminPhone,
        `${emoji} *${name}* — ${estado}\n` +
          `🔧 Línea: ${lineLabel}\n` +
          `🕐 ${new Date().toLocaleTimeString("es-EC", { timeZone: "America/Guayaquil", hour: "2-digit", minute: "2-digit" })}`,
      );
    } catch (err: any) {
      this.logger.error(`Error notificando al admin: ${err.message}`);
    }
  }

  private _lineLabel(line: string): string {
    const labels: Record<string, string> = {
      TECHNICAL_SUPPORT: "Soporte Técnico",
      INFRASTRUCTURE: "Infraestructura",
      SYSTEMS: "Sistemas",
    };
    return labels[line] ?? line;
  }
}
