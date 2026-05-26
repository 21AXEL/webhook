// availability-reset.job.ts
// Cron que se ejecuta a medianoche hora Ecuador (UTC-5 = 05:00 UTC).
// Marca como EXPIRED todos los registros del día anterior que quedaron en PENDING
// (agentes que nunca respondieron el template).

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { AgentAvailabilityService } from "@shared/modules/agent-availability/agent-availability.service";

@Injectable()
export class AvailabilityResetJob {
  private readonly logger = new Logger(AvailabilityResetJob.name);

  constructor(private readonly availabilityService: AgentAvailabilityService) {}

  /**
   * Cron: 00:00 AM Ecuador (UTC-5) → 05:00 UTC, todos los días.
   */
  @Cron("0 0 5 * * *", { timeZone: "UTC" })
  async expirePendingRecords(): Promise<void> {
    this.logger.log("▶ Expirando registros de disponibilidad sin respuesta");

    const expired = await this.availabilityService.expirePreviousDay();

    if (expired > 0) {
      this.logger.log(
        `✅ ${expired} registro(s) de disponibilidad marcados como EXPIRED`,
      );
    } else {
      this.logger.log("Sin registros pendientes del día anterior");
    }
  }
}
