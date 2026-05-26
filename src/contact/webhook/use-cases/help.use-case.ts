import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../conversation.service";
import { AiService } from "../services/ai.service";
import { WhatsAppService } from "../services/whatsapp.service";

@Injectable()
export class HelpUseCase {
  private readonly logger = new Logger(HelpUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly whatsAppService: WhatsAppService,
    private readonly aiService: AiService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      let messageText = "";
      let buttonId = "";

      if (message.type === "text") {
        messageText = message.text.body;
      } else if (message.type === "interactive") {
        if (message.interactive.type === "button_reply") {
          messageText = message.interactive.button_reply.title;
          buttonId = message.interactive.button_reply.id;
        } else if (message.interactive.type === "list_reply") {
          messageText = message.interactive.list_reply.title;
        }
      }

      if (
        (conversation.state === "help_menu_shown" ||
          conversation.state === "specific_help_provided") &&
        buttonId
      ) {
        return this.processHelpMenuResponse(conversation, message);
      }

      const isSpecificQuestion = this.isSpecificHelpQuestion(messageText);

      if (isSpecificQuestion) {
        return this.handleSpecificHelp(conversation, messageText);
      } else {
        return this.showHelpMenu(conversation);
      }
    } catch (error) {
      this.logger.error("Error en HelpUseCase:", error);

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Lo siento, tuve un problema al procesar tu solicitud de ayuda. Por favor, intenta nuevamente.",
      );

      await this.finishHelpFlow(conversation);
      throw error;
    }
  }

  isSpecificHelpQuestion(messageText: string): boolean {
    const specificQuestionIndicators = [
      "cómo",
      "como",
      "qué",
      "que",
      "cuál",
      "cual",
      "dónde",
      "donde",
      "por qué",
      "porque",
      "cuándo",
      "cuando",
      "puedo",
      "debo",
      "necesito",
      "?",
      "ayuda con",
      "problema",
      "dificultad",
      "no puedo",
      "no sé",
    ];

    const generalHelpTerms = [
      "ayuda",
      "ayúdame",
      "help",
      "necesito ayuda",
      "asistencia",
    ];

    const normalizedText = messageText.toLowerCase();

    if (generalHelpTerms.some((term) => normalizedText.trim() === term)) {
      return false;
    }

    return specificQuestionIndicators.some((indicator) =>
      normalizedText.includes(indicator),
    );
  }

  async showHelpMenu(conversation: any): Promise<any> {
    try {
      await this.conversationService.update(conversation._id, {
        state: "help_menu_shown",
        lastState: conversation.state,
      });

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "👋 *¡Bienvenido al Centro de Ayuda de Esmeraldas La Bella!*\n\nEstoy aquí para asistirte con cualquier duda que tengas sobre los servicios municipales y cómo utilizar este asistente.",
      );

      await this.whatsAppService.sendButtonMessage(conversation.senderId, {
        headerText: "Centro de Ayuda",
        bodyText: "¿En qué puedo ayudarte hoy?",
        footerText: "Selecciona una opción",
        buttons: [
          { id: "huc_use", text: "Cómo usar" },
          { id: "huc_serv", text: "Servicios" },
          { id: "huc_report", text: "Reportar" },
        ],
      });

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "También puedes escribir tu pregunta específica y te ayudaré a resolverla. 💬",
      );

      return {
        success: true,
        intent: "help",
        nextState: "help_menu_shown",
      };
    } catch (error) {
      this.logger.error("Error mostrando menú de ayuda:", error);
      await this.finishHelpFlow(conversation);
      throw error;
    }
  }

  async handleSpecificHelp(
    conversation: any,
    questionText: string,
  ): Promise<any> {
    try {
      await this.conversationService.update(conversation._id, {
        state: "specific_help_provided",
        lastState: conversation.state,
      });

      if (!this.aiService) {
        const genericResponse =
          "Lo siento, no puedo responder a preguntas específicas en este momento. Por favor, contacta directamente con el soporte municipal al correo soporte@esmeraldas.gob.ec o llama al +593XXXXXXXXX para recibir ayuda personalizada.";

        await this.whatsAppService.sendTextMessage(
          conversation.senderId,
          genericResponse,
        );

        await this.whatsAppService.sendButtonMessage(conversation.senderId, {
          bodyText: "¿Esta información resolvió tu duda?",
          buttons: [
            { id: "huc_yes", text: "Sí, gracias" },
            { id: "huc_no", text: "No, necesito más ayuda" },
          ],
        });

        return {
          success: true,
          intent: "help",
          nextState: "specific_help_provided",
          aiUsed: false,
        };
      }

      const messages = [
        {
          role: "system",
          content: `Eres el asistente virtual de Esmeraldas para el aplicativo "Esmeraldas La Bella".
          Proporciona información municipal clara y concisa sobre el tema solicitado. Limita la respuesta a información oficial del municipio de Esmeraldas. Si no conoces la respuesta específica, proporciona información general sobre el tema y ofrece contactar a la oficina correspondiente.

          Enlaces importantes:
          - Página oficial: https://esmeraldas.gob.ec/
          - Trámites ciudadanos: https://tramites.esmeraldas.gob.ec/login.jsp
          - Consulta de infracciones de transito: https://servicios.axiscloud.ec/AutoServicio/inicio.jsp?ps_empresa=10&ps_accion=P55
          - Consulta de impuestos prediales pendientes: https://consulta.esmeraldas.gob.ec/
          - Registro para consulta de impuestos prediales pagados: https://geoapi.esmeraldas.gob.ec/auth/signup
          - Reportar incidentes y problemas de servicio público: https://geoapi.esmeraldas.gob.ec

          Para consultar impuestos prediales pagados, los ciudadanos deben registrarse en "Esmeraldas la Bella" con su número de cédula, y luego acceder desde la página principal dando clic en "Impuesto Predial".

          Ubicaciones:
          - Evaluos y Rentas, predios catastrales: Esmeraldas, Plaza Civica, Juan Montalvo y Avenida Pedro Vicente Maldonado
          - Departamento de Higiene y Tic's: Av. 9 de Octubre y Eloy Alfaro
          
          Esta es una consulta de ayuda del usuario. Proporciona información útil, orientada al servicio, breve y específica. Responde como si fueras un asistente municipal oficial.
          Tus respuestas deben ser breves, profesionales y en español.`,
        },
        {
          role: "user",
          content: `El usuario está pidiendo ayuda con la siguiente consulta: "${questionText}"`,
        },
      ];

      const response = await this.aiService.query(messages, {
        temperature: 0.3,
      });

      const aiResponse = response.content.trim();

      await this.conversationService.updateConversationHistory(
        conversation._id,
        aiResponse,
      );

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        aiResponse,
      );

      await this.whatsAppService.sendButtonMessage(conversation.senderId, {
        bodyText: "¿Esta información resolvió tu duda?",
        buttons: [
          { id: "huc_yes", text: "Sí, gracias" },
          { id: "huc_no", text: "No, necesito más ayuda" },
        ],
      });

      return {
        success: true,
        intent: "help",
        nextState: "specific_help_provided",
        aiUsed: true,
      };
    } catch (error) {
      this.logger.error("Error procesando ayuda específica:", error);

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        "Lo siento, tuve un problema al procesar tu consulta. Por favor, intenta formularla de otra manera o selecciona una opción del menú de ayuda.",
      );

      await this.finishHelpFlow(conversation);
      return this.showHelpMenu(conversation);
    }
  }

  async processHelpMenuResponse(conversation: any, message: any): Promise<any> {
    try {
      let response = "";
      let buttonId = "";

      if (
        message.type === "interactive" &&
        message.interactive.type === "button_reply"
      ) {
        buttonId = message.interactive.button_reply.id;
      }

      switch (buttonId) {
        case "huc_use":
          response = `*Cómo usar el Asistente Virtual de Esmeraldas La Bella*

Este asistente te permite:

1️⃣ *Reportar incidentes* en la ciudad como baches, alumbrado dañado, etc.
2️⃣ *Consultar información municipal* sobre trámites y servicios
3️⃣ *Registrarte como usuario* para acceder a más funcionalidades
4️⃣ *Reportar emergencias* que requieran atención inmediata

Para interactuar:
• Simplemente escribe tu consulta o selecciona las opciones que te presentamos
• Puedes enviar tu ubicación para reportes georreferenciados
• Sube fotos o documentos cuando te lo solicitemos`;
          break;

        case "huc_serv":
          response = `*Servicios disponibles en Esmeraldas La Bella*

🔹 *Reportes ciudadanos*
   • Problemas en vías públicas
   • Alumbrado defectuoso
   • Acumulación de basura
   • Problemas con agua potable

🔹 *Consultas municipales*
   • Información sobre trámites
   • Requisitos para permisos
   • Horarios de atención
   • Pago de impuestos prediales

🔹 *Gestión de emergencias*
   • Reportes de situaciones críticas
   • Notificación a entidades competentes

🔹 *Base de conocimiento*
   • Información municipal actualizada
   • Preguntas frecuentes`;
          break;

        case "huc_report":
          response = `*Cómo reportar un incidente*

Para reportar un problema en la ciudad:

1️⃣ Escribe "Reportar incidente" o un mensaje describiendo el problema
2️⃣ Selecciona la categoría del incidente (vías, alumbrado, etc.)
3️⃣ Comparte tu ubicación cuando te lo solicitemos
4️⃣ Envía fotos del incidente si es posible
5️⃣ Confirma los detalles del reporte

Tu reporte será enviado a las autoridades competentes para su atención. Recibirás un código de seguimiento para consultar el estado de tu reporte.`;
          break;

        case "huc_yes":
          response =
            "¡Me alegra haber podido ayudarte! Si tienes más preguntas en el futuro, no dudes en contactarme nuevamente. ¡Que tengas un excelente día!";
          await this.finishHelpFlow(conversation);
          break;

        case "huc_no":
          response =
            "Lamento que no haya podido resolver tu duda. Permíteme ofrecerte más opciones de ayuda:";
          await this.whatsAppService.sendTextMessage(
            conversation.senderId,
            response,
          );
          return this.showHelpMenu(conversation);

        case "huc_more_yes":
          return this.showHelpMenu(conversation);

        case "huc_more_no":
          response =
            "Entendido. ¡Gracias por utilizar nuestro servicio de ayuda! Si necesitas asistencia en el futuro, no dudes en contactarnos.";
          await this.finishHelpFlow(conversation);
          break;

        default:
          return this.handleSpecificHelp(
            conversation,
            message.text?.body || "ayuda",
          );
      }

      await this.whatsAppService.sendTextMessage(
        conversation.senderId,
        response,
      );

      if (buttonId !== "huc_yes" && buttonId !== "huc_more_no") {
        await this.whatsAppService.sendButtonMessage(conversation.senderId, {
          bodyText: "¿Hay algo más en lo que pueda ayudarte?",
          buttons: [
            { id: "huc_more_yes", text: "Sí, tengo más preguntas" },
            { id: "huc_more_no", text: "No, gracias" },
          ],
        });
      }

      return {
        success: true,
        intent: "help",
        responseType: buttonId,
      };
    } catch (error) {
      this.logger.error("Error procesando respuesta del menú de ayuda:", error);
      await this.finishHelpFlow(conversation);
      throw error;
    }
  }

  async finishHelpFlow(conversation: any): Promise<any> {
    try {
      await this.conversationService.update(conversation._id, {
        state: "initial",
        lastState: conversation.state,
      });

      this.logger.log(
        `Flujo de ayuda finalizado para conversación ${conversation._id}, retornando a estado initial`,
      );

      return {
        success: true,
        intent: "help_finished",
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error finalizando flujo de ayuda:", error);
      await this.conversationService.update(conversation._id, {
        state: "initial",
      });
    }
  }
}
