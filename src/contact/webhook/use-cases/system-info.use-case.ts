import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../conversation.service";
import { AiService } from "../services/ai.service";
import { WhatsAppService } from "../services/whatsapp.service";

@Injectable()
export class SystemInfoUseCase {
  private readonly logger = new Logger(SystemInfoUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      if (
        message.type === "interactive" &&
        message.interactive.type === "button_reply"
      ) {
        const buttonId = message.interactive.button_reply.id;
        if (buttonId.startsWith("siuc_")) {
          return await this.processResponse(conversation, message);
        }
      }

      const systemInfo = await this.getSystemInfo();

      await this.conversationService.update(conversation._id, {
        state: "system_info_provided",
        lastState: conversation.state,
      });

      await this.conversationService.updateConversationHistory(
        conversation._id,
        "Información del sistema proporcionada",
      );

      await this.sendSystemInfoOptions(conversation.senderId, systemInfo);

      return {
        success: true,
        intent: "system_info",
        nextState: "system_info_provided",
      };
    } catch (error) {
      this.logger.error("Error en SystemInfoUseCase:", error);

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Lo siento, hubo un problema al obtener la información del sistema. Por favor, intenta nuevamente.",
      );

      await this.conversationService.update(conversation._id, {
        state: "initial",
      });

      throw error;
    }
  }

  async getSystemInfo(): Promise<any> {
    return {
      appName: "Esmeraldas La Bella",
      version: "1.0.0",
      description:
        "Asistente virtual municipal para reportes y consultas ciudadanas",
      municipality: "GAD Municipal de Esmeraldas",
      services: [
        { name: "Reportes de incidentes", available: true },
        { name: "Consultas informativas", available: true },
        { name: "Registro de usuario", available: true },
        { name: "Emergencias", available: true },
        { name: "Gestión de conocimiento", available: true },
      ],
      contacts: {
        support: "+593995767887",
        emergency: "911",
        email: "aplicaciones@esmeraldas.gob.ec",
      },
      webServices: [
        {
          name: "Consulta de predios",
          url: "https://consulta.esmeraldas.gob.ec/",
        },
        {
          name: "Trámites",
          url: "https://tramites.esmeraldas.gob.ec/login.jsp",
        },
        { name: "Esmeralda la Bella", url: "https://geoapi.esmeraldas.gob.ec" },
      ],
    };
  }

  async sendSystemInfoOptions(
    senderId: string,
    systemInfo: any,
  ): Promise<void> {
    await this.whatsAppService.sendTextMessage(
      senderId,
      `*${systemInfo.appName} v${systemInfo.version}*\n\n${systemInfo.description}\n\nEste servicio es proporcionado por ${systemInfo.municipality}.`,
    );

    await this.whatsAppService.sendButtonMessage(senderId, {
      headerText: "Información del Sistema",
      bodyText: "¿Qué información deseas consultar?",
      footerText: "Selecciona una opción",
      buttons: [
        { id: "siuc_services", text: "Servicios disponibles" },
        { id: "siuc_contact", text: "Información de contacto" },
        { id: "siuc_websites", text: "Sitios web" },
      ],
    });
  }

  async processResponse(conversation: any, message: any): Promise<any> {
    try {
      let response = "";
      let buttonId = "";

      if (
        message.type === "interactive" &&
        message.interactive.type === "button_reply"
      ) {
        buttonId = message.interactive.button_reply.id;
      }

      const systemInfo = await this.getSystemInfo();

      switch (buttonId) {
        case "siuc_services":
          response =
            "*Servicios disponibles:*\n\n" +
            systemInfo.services
              .map(
                (service: any) =>
                  `• ${service.name}: ${service.available ? "✅ Disponible" : "❌ No disponible"}`,
              )
              .join("\n");
          break;

        case "siuc_contact":
          response =
            "*Información de contacto:*\n\n" +
            `• Soporte: ${systemInfo.contacts.support}\n` +
            `• Emergencias: ${systemInfo.contacts.emergency}\n` +
            `• Correo: ${systemInfo.contacts.email}`;
          break;

        case "siuc_websites":
          response =
            "*Sitios web municipales:*\n\n" +
            systemInfo.webServices
              .map((site: any) => `• ${site.name}: ${site.url}`)
              .join("\n");
          break;

        case "siuc_more_yes":
          await this.sendSystemInfoOptions(conversation.senderId, systemInfo);
          return {
            success: true,
            intent: "system_info",
            responseType: buttonId,
            nextState: "system_info_provided",
          };

        case "siuc_more_no":
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            "¡Gracias por consultar la información del sistema! Si necesitas algo más, no dudes en preguntar.",
          );

          await this.conversationService.update(conversation._id, {
            state: "initial",
            lastState: "system_info_provided",
          });

          return {
            success: true,
            intent: "system_info",
            responseType: buttonId,
            nextState: "initial",
          };

        default:
          response = "Por favor, selecciona una de las opciones disponibles.";
          await this.sendSystemInfoOptions(conversation.senderId, systemInfo);
          break;
      }

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        response,
      );

      await this.whatsAppService.sendButtonMessage(conversation.senderId, {
        bodyText: "¿Deseas consultar más información del sistema?",
        buttons: [
          { id: "siuc_more_yes", text: "Sí, más información" },
          { id: "siuc_more_no", text: "No, gracias" },
        ],
      });

      return {
        success: true,
        intent: "system_info",
        responseType: buttonId,
        nextState: "system_info_provided",
      };
    } catch (error) {
      this.logger.error(
        "Error procesando respuesta en SystemInfoUseCase:",
        error,
      );
      throw error;
    }
  }
}
