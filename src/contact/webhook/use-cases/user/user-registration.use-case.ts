/**
 * user-registration.use-case.ts
 * Caso de uso para registro de ciudadanos via WhatsApp.
 * El método execute() despacha al sub-método correcto según conversation.state,
 * cumpliendo el contrato IUseCase(conversation, message).
 */

import { Injectable, Logger } from "@nestjs/common";
import { UserService } from "@shared/modules/user/user.service";
import { WhatsAppService } from "@contact/webhook/services/whatsapp.service";
import { ConversationService } from "@contact/conversation.service";

@Injectable()
export class UserRegistrationUseCase {
  private readonly logger = new Logger(UserRegistrationUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly userService: UserService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  // ─── Punto de entrada (contrato IUseCase) ────────────────────────────────────

  /**
   * Despacha al sub-método correcto según el estado actual de la conversación.
   * Cuando la intención 'register_user' se detecta por primera vez, el estado
   * es 'initial' → inicia el flujo.  En pasos posteriores, el estado coincide
   * con uno de los 'waiting_user_*' registrados en webhook.module.ts.
   */
  async execute(conversation: any, message: any): Promise<any> {
    const conversationId = conversation._id?.toString() ?? conversation;
    const state = conversation.state ?? "initial";
    const text = this._extractText(message);

    switch (state) {
      case "waiting_user_name":
        return this.processName(conversationId, text);
      case "waiting_user_last_name":
        return this.processLastName(conversationId, text);
      case "waiting_user_dni":
        return this.processDNI(conversationId, text);
      case "waiting_user_dni_expedition":
        return this.processExpeditionDate(conversationId, text);
      case "waiting_user_email":
        return this.processEmail(conversationId, text);
      case "waiting_user_phone":
        return this.processPhone(conversationId, text);
      case "waiting_user_confirmation":
        return this.processConfirmation(
          conversationId,
          this._extractButtonId(message),
        );
      default:
        // Estado 'initial' o cualquier otro → arrancar el flujo
        return this.startRegistration(conversationId);
    }
  }

  // ─── Inicio del flujo ─────────────────────────────────────────────────────────

  async startRegistration(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      await this.conversationService.clearTempUserData(conversationId);
      await this.conversationService.updateState(
        conversationId,
        "waiting_user_name",
        conversation.state,
      );

      await this.conversationService.updateTempUserData(conversationId, {
        name: { value: "", isValid: false },
        last_name: { value: "", isValid: false },
        dni: { value: "", isValid: false },
        telf: { value: senderId, isValid: true },
        email: { value: "", isValid: false },
        date_expedition: { value: "", isValid: false },
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        "Para registrarte como ciudadano, necesitamos algunos datos personales. Empecemos con tu nombre:",
      );

      return {
        success: true,
        message: "Proceso de registro iniciado",
        nextState: "waiting_user_name",
      };
    } catch (error) {
      this.logger.error("Error iniciando registro:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Pasos del flujo ──────────────────────────────────────────────────────────

  async processName(conversationId: string, name: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const isValid = name.trim().length >= 2;

      await this.conversationService.updateTempUserData(conversationId, {
        name: { value: name.trim(), isValid },
      });

      if (!isValid) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El nombre proporcionado es demasiado corto. Por favor, ingresa tu nombre completo:",
        );
        return {
          success: false,
          message: "Nombre inválido",
          nextState: "waiting_user_name",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "waiting_user_last_name",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        `Gracias ${name}. Ahora ingresa tu apellido:`,
      );
      return {
        success: true,
        message: "Nombre procesado",
        nextState: "waiting_user_last_name",
      };
    } catch (error) {
      this.logger.error("Error procesando nombre:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processLastName(
    conversationId: string,
    lastName: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const isValid = lastName.trim().length >= 2;

      await this.conversationService.updateTempUserData(conversationId, {
        last_name: { value: lastName.trim(), isValid },
      });

      if (!isValid) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El apellido es demasiado corto. Por favor, ingresa tu apellido completo:",
        );
        return {
          success: false,
          message: "Apellido inválido",
          nextState: "waiting_user_last_name",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "waiting_user_dni",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Gracias. Ingresa tu número de cédula (10 dígitos):",
      );
      return {
        success: true,
        message: "Apellido procesado",
        nextState: "waiting_user_dni",
      };
    } catch (error) {
      this.logger.error("Error procesando apellido:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processDNI(conversationId: string, dni: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const cleanDNI = dni.replace(/\D/g, "");
      const isValid = /^\d{10}$/.test(cleanDNI);

      await this.conversationService.updateTempUserData(conversationId, {
        dni: { value: cleanDNI, isValid },
      });

      if (!isValid) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "La cédula debe tener exactamente 10 dígitos. Por favor, ingresa nuevamente:",
        );
        return {
          success: false,
          message: "Cédula inválida",
          nextState: "waiting_user_dni",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "waiting_user_dni_expedition",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        "Gracias. Ingresa la fecha de expedición de tu cédula en formato DD/MM/AAAA (ej: 15/04/2010):",
      );
      return {
        success: true,
        message: "Cédula procesada",
        nextState: "waiting_user_dni_expedition",
      };
    } catch (error) {
      this.logger.error("Error procesando cédula:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processExpeditionDate(
    conversationId: string,
    expeditionDate: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const isValid = /^\d{2}\/\d{2}\/\d{4}$/.test(expeditionDate);

      await this.conversationService.updateTempUserData(conversationId, {
        date_expedition: { value: expeditionDate, isValid },
      });

      if (!isValid) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "El formato debe ser DD/MM/AAAA (ej: 15/04/2010). Por favor, ingresa nuevamente:",
        );
        return {
          success: false,
          message: "Fecha inválida",
          nextState: "waiting_user_dni_expedition",
        };
      }

      await this.conversationService.updateState(
        conversationId,
        "waiting_user_email",
        conversation.state,
      );
      await this.whatsAppService.sendTextMessage(
        senderId,
        'Gracias. Ingresa tu correo electrónico (opcional — responde "ninguno" para omitirlo):',
      );
      return {
        success: true,
        message: "Fecha procesada",
        nextState: "waiting_user_email",
      };
    } catch (error) {
      this.logger.error("Error procesando fecha de expedición:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processPhone(conversationId: string, phone: string): Promise<any> {
    // El teléfono ya se captura del senderId al iniciar, este paso es opcional/confirmación
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      await this.conversationService.updateState(
        conversationId,
        "waiting_user_confirmation",
        conversation.state,
      );
      return this.showRegistrationSummary(conversationId);
    } catch (error) {
      this.logger.error("Error procesando teléfono:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processEmail(conversationId: string, email: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      let emailValue = email.trim().toLowerCase();
      let isValid = false;

      if (["ninguno", "no", ""].includes(emailValue)) {
        emailValue = "";
        isValid = true;
      } else {
        isValid = /^[\w.-]+@[\w.-]+\.\w+$/.test(emailValue);
      }

      await this.conversationService.updateTempUserData(conversationId, {
        email: { value: emailValue, isValid },
      });

      if (!isValid) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          'El formato del correo no es válido. Ingresa un correo válido o responde "ninguno":',
        );
        return {
          success: false,
          message: "Email inválido",
          nextState: "waiting_user_email",
        };
      }

      return this.showRegistrationSummary(conversationId);
    } catch (error) {
      this.logger.error("Error procesando email:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async showRegistrationSummary(conversationId: string): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;
      const userData = conversation.tempUserData;

      await this.conversationService.updateState(
        conversationId,
        "waiting_user_confirmation",
        conversation.state,
      );

      let summaryMessage = "*Resumen de tus datos*\n\n";
      summaryMessage += `*Nombre:* ${userData.name?.value}\n`;
      summaryMessage += `*Apellido:* ${userData.last_name?.value}\n`;
      summaryMessage += `*Cédula:* ${userData.dni?.value}\n`;
      summaryMessage += `*Fecha expedición:* ${userData.date_expedition?.value}\n`;
      summaryMessage += `*Teléfono:* ${userData.telf?.value}\n`;
      if (userData.email?.value)
        summaryMessage += `*Email:* ${userData.email.value}\n`;
      summaryMessage += "\n¿Confirmas que todos tus datos son correctos?";

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Confirmación de Registro",
        bodyText: summaryMessage,
        footerText: "Tu información será verificada con Registro Civil",
        buttons: [
          { id: "usr_confirm_yes", text: "Sí, son correctos" },
          { id: "usr_confirm_no", text: "No, corregir datos" },
        ],
      });

      return {
        success: true,
        message: "Resumen mostrado",
        nextState: "waiting_user_confirmation",
      };
    } catch (error) {
      this.logger.error("Error mostrando resumen:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  async processConfirmation(
    conversationId: string,
    confirmation: string,
  ): Promise<any> {
    try {
      const conversation =
        await this.conversationService.getById(conversationId);
      const senderId = conversation.senderId;

      // El usuario rechazó los datos → reiniciar
      if (confirmation !== "usr_confirm_yes") {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Entendido, vamos a reiniciar el proceso. Por favor, ingresa tu nombre:",
        );
        await this.conversationService.updateState(
          conversationId,
          "waiting_user_name",
          conversation.state,
        );
        return {
          success: true,
          message: "Reiniciando registro",
          nextState: "waiting_user_name",
        };
      }

      // Formatear y crear usuario
      const formattedData = this.userService.formatUserData(
        conversation.tempUserData,
      );
      const result = await this.userService.createUser(formattedData);

      if (!result.success || !result.data) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se pudo completar el registro: ${result.message || "Error desconocido"}. Por favor, intenta más tarde.`,
        );
        await this.conversationService.updateState(
          conversationId,
          "initial",
          conversation.state,
        );
        return {
          success: false,
          message: result.message || "Error desconocido",
          nextState: "initial",
        };
      }

      // Vincular usuario a la conversación
      await this.conversationService.update(conversationId, {
        userId: result.data._id,
      });

      await this.whatsAppService.sendTextMessage(
        senderId,
        `¡Felicidades ${result.data.name}! Tu registro ha sido completado. Ahora puedes reportar incidentes y acceder a todos los servicios de "Esmeraldas La Bella".`,
      );

      await this.conversationService.updateState(
        conversationId,
        "initial",
        conversation.state,
      );
      return {
        success: true,
        message: "Usuario registrado",
        userId: result.data._id,
        nextState: "initial",
      };
    } catch (error) {
      this.logger.error("Error procesando confirmación:", error);
      try {
        const conv = await this.conversationService.getById(conversationId);
        await this.whatsAppService.sendTextMessage(
          conv.senderId,
          "Hubo un error al procesar tu registro. Por favor, intenta nuevamente más tarde.",
        );
      } catch (_) {
        /* silenciar error secundario */
      }
      return { success: false, error: (error as Error).message };
    }
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────────

  private _extractText(message: any): string {
    return (
      message?.text?.body ||
      message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title ||
      ""
    );
  }

  private _extractButtonId(message: any): string {
    return (
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.id ||
      ""
    );
  }
}
