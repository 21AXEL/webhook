import { ConversationService } from "@contact/conversation.service";
import { WhatsAppService } from "@contact/webhook/services/whatsapp.service";
import { Injectable, Logger } from "@nestjs/common";
import { AgentConsentService } from "@shared/modules/agent-consent/agent-consent.service";
import { ErpService } from "@shared/modules/erp/erp.service";

@Injectable()
export class AgentConsentUseCase {
  private readonly logger = new Logger(AgentConsentUseCase.name);
  constructor(
    private readonly agentConsentService: AgentConsentService,
    private readonly whatsAppService: WhatsAppService,
    private readonly erpService: ErpService,
    private readonly conversationService: ConversationService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    this.logger.log(
      `AgentConsent ejecutando para ${conversation.senderId}, buttonId=${message?.button?.payload ?? message?.interactive?.button_reply?.id ?? "null"}`,
    );
    // ── CAMBIO: leer payload desde template quick_reply O interactive button ──
    const buttonId: string | null =
      message?.interactive?.button_reply?.id ?? // sendButtonMessage
      message?.button?.payload ?? // template quick_reply
      null;
    const senderId = conversation.senderId;
    const localPhone = senderId.replace(/^\+?593/, "0").replace(/\D/g, "");
    const agent = await this.erpService.getEmployeeByPhone(localPhone);

    if (!agent) {
      await this.conversationService.updateState(
        conversation._id,
        "initial",
        conversation.state,
      );
      return { success: false };
    }

    if (buttonId === "consent_accept") {
      await this.agentConsentService.markAccepted(agent.citizenId);
      await this.whatsAppService.sendTextMessage(
        senderId,
        `✅ Gracias, *${agent.firstName}*. Tu consentimiento ha sido registrado.\n\n` +
          `A partir de ahora recibirás los avisos de disponibilidad cada mañana laboral. ` +
          `Puedes revocar esta autorización en cualquier momento escribiendo *consentimiento*.`,
      );
    } else {
      await this.agentConsentService.markDeclined(agent.citizenId);
      await this.whatsAppService.sendTextMessage(
        senderId,
        `Entendido, *${agent.firstName}*. No usaremos este número para notificaciones automáticas.\n\n` +
          `⚠️ Ten en cuenta que no recibirás los avisos de disponibilidad diaria. ` +
          `Si cambias de opinión escribe *consentimiento*.`,
      );
    }

    await this.conversationService.updateState(
      conversation._id,
      "initial",
      conversation.state,
    );
    return { success: true };
  }
}
