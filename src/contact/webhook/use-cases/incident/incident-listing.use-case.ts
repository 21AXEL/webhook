import { Injectable, Logger } from "@nestjs/common";
import { ConversationService } from "../../../conversation.service";
import { IncidentService } from "@shared/modules/incident/incident.service";
import { UserService } from "@shared/modules/user/user.service";
import { WhatsAppService } from "../../services/whatsapp.service";

@Injectable()
export class IncidentListingUseCase {
  private readonly logger = new Logger(IncidentListingUseCase.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly incidentService: IncidentService,
    private readonly userService: UserService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  async execute(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      const senderId = conversation.senderId;

      if (message.type === "interactive") {
        switch (conversation.state) {
          case "incident_listing_options":
            return await this.processListingOption(conversation, message);

          case "incident_listing_status_selection":
            return await this.processStatusSelection(conversation, message);

          case "incident_listing_results":
            if (message.interactive.type === "button_reply") {
              const buttonId = message.interactive.button_reply.id;

              if (buttonId === "iluc_recent") {
                return await this.listRecentIncidents(conversation, message);
              }

              if (buttonId === "iluc_status") {
                await this.conversationService.update(conversationId, {
                  state: "incident_listing_status_selection",
                  lastState: conversation.state,
                });

                const estados = await this.incidentService.getEstadosAll();
                const estadosList = estados.map((estado: any) => ({
                  id: `iluc_estado_${estado._id}`,
                  title: estado.nombre,
                  description: `Reportes en estado ${estado.nombre} ${estado.emoji}`,
                }));

                estadosList.push({
                  id: "iluc_estado_all",
                  title: "Todos",
                  description: "Ver todos mis reportes",
                });

                await this.whatsAppService.sendListMessage(senderId, {
                  bodyText:
                    "Selecciona el estado de los reportes que deseas consultar:",
                  headerText: "Estados de reportes",
                  buttonText: "Ver estados",
                  sections: [
                    {
                      title: "Estados",
                      rows: estadosList,
                    },
                  ],
                });

                return {
                  success: true,
                  intent: "incident_listing",
                  message: "Opciones de estado mostradas",
                  nextState: "incident_listing_status_selection",
                };
              }

              if (buttonId === "iluc_new") {
                await this.conversationService.update(conversationId, {
                  state: "initial",
                  lastState: conversation.state,
                });

                const incidentCreationUseCase = {} as any;
                return await incidentCreationUseCase.execute(
                  conversation,
                  message,
                );
              }
            }
            break;

          case "incident_detail_shown":
            if (message.interactive.type === "button_reply") {
              const buttonId = message.interactive.button_reply.id;

              if (buttonId === "iluc_status_update") {
                return await this.viewStatusUpdates(conversation, message);
              }

              if (buttonId === "iluc_recent") {
                return await this.listRecentIncidents(conversation, message);
              }
            }
            break;
        }
      }

      if (
        message.type === "text" &&
        message.text.body.toLowerCase().includes("ver reporte")
      ) {
        return await this.viewIncidentDetail(conversation, message);
      }

      if (!conversation.userId) {
        await this.conversationService.update(conversationId, {
          state: "user_registration",
          lastState: conversation.state,
        });

        await this.whatsAppService.sendTextMessage(
          senderId,
          "Para consultar tus reportes, primero necesitamos registrarte como ciudadano. Por favor, completa el siguiente formulario.",
        );

        const userRegistrationUseCase = {} as any;
        return await userRegistrationUseCase.execute(conversation, message);
      }

      await this.conversationService.update(conversationId, {
        state: "incident_listing_options",
        lastState: conversation.state,
      });

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Consulta de Reportes",
        bodyText: "¿Qué reportes deseas consultar?",
        footerText: "Selecciona una opción",
        buttons: [
          { id: "iluc_recent", text: "Mis reportes recientes" },
          { id: "iluc_status", text: "Buscar por estado" },
        ],
      });

      return {
        success: true,
        intent: "incident_listing",
        message: "Proceso de listado de incidentes iniciado",
        nextState: "incident_listing_options",
      };
    } catch (error) {
      this.logger.error("Error iniciando listado de incidentes:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async viewStatusUpdates(conversation: any, message: any): Promise<any> {
    try {
      const senderId = conversation.senderId;
      const incidentId = conversation.context?.incidentId;

      if (!incidentId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se pudo determinar qué reporte estás consultando. Por favor, selecciona un reporte primero.",
        );
        return {
          success: false,
          intent: "incident_detail",
          message: "ID de incidente no disponible",
          nextState: conversation.state,
        };
      }

      const incident =
        await this.incidentService.getByIdAndPopulate(incidentId);

      if (!incident) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se pudo encontrar el reporte solicitado. Es posible que haya sido eliminado.",
        );
        return {
          success: false,
          intent: "incident_detail",
          message: "Incidente no encontrado",
          nextState: conversation.state,
        };
      }

      if (!incident.comments || incident.comments.length === 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "Este reporte aún no tiene actualizaciones de estado.",
        );
      } else {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `*Actualizaciones del reporte #${incidentId}*\n\nA continuación se muestran las actualizaciones más recientes:`,
        );

        for (const comment of incident.comments) {
          const commentDate = new Date(comment.date);
          const formattedDate = `${commentDate.getDate()}/${commentDate.getMonth() + 1}/${commentDate.getFullYear()} ${commentDate.getHours()}:${String(commentDate.getMinutes()).padStart(2, "0")}`;

          await this.whatsAppService.sendTextMessage(
            senderId,
            `📝 *Actualización (${formattedDate})*\n${comment.text}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "¿Qué deseas hacer ahora?",
        bodyText: "Selecciona una opción:",
        footerText: "Opciones",
        buttons: [
          { id: "iluc_recent", text: "Ver otros reportes" },
          { id: "iluc_new", text: "Crear nuevo reporte" },
        ],
      });

      return {
        success: true,
        intent: "incident_updates",
        message: "Actualizaciones de incidente mostradas",
        nextState: "incident_listing_results",
      };
    } catch (error) {
      this.logger.error("Error mostrando actualizaciones de incidente:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processListingOption(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      const senderId = conversation.senderId;
      const userId = conversation.userId;

      let option = "";
      if (
        message.type === "interactive" &&
        message.interactive.type === "button_reply"
      ) {
        option = message.interactive.button_reply.id;
      } else if (
        message.type === "interactive" &&
        message.interactive.type === "list_reply"
      ) {
        option = message.interactive.list_reply.id;
      }

      if (option.startsWith("iluc_")) {
        option = option.substring(5);
      }

      if (!userId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se encontró un usuario registrado para esta conversación. Por favor, regístrate primero.",
        );
        return {
          success: false,
          intent: "incident_listing",
          message: "Usuario no registrado",
          nextState: "initial",
        };
      }

      switch (option) {
        case "recent":
          return await this.listRecentIncidents(conversation, message);

        case "status":
          await this.conversationService.update(conversationId, {
            state: "incident_listing_status_selection",
            lastState: conversation.state,
          });

          const estados = await this.incidentService.getEstadosAll();
          const estadosList = estados.map((estado: any) => ({
            id: `iluc_estado_${estado._id}`,
            title: estado.nombre,
            description: `Reportes en estado ${estado.nombre} ${estado.emoji}`,
          }));

          estadosList.push({
            id: "iluc_estado_all",
            title: "Todos",
            description: "Ver todos mis reportes",
          });

          await this.whatsAppService.sendListMessage(senderId, {
            bodyText:
              "Selecciona el estado de los reportes que deseas consultar:",
            footerText: "Estados de reportes",
            buttonText: "Ver estados",
            sections: [
              {
                title: "Todos",
                rows: estadosList,
              },
            ],
          });

          return {
            success: true,
            intent: "incident_listing",
            message: "Opciones de estado mostradas",
            nextState: "incident_listing_status_selection",
          };

        default:
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Opción no reconocida. Por favor, selecciona una de las opciones proporcionadas.",
          );
          return {
            success: false,
            intent: "incident_listing",
            message: "Opción no válida",
            nextState: "incident_listing_options",
          };
      }
    } catch (error) {
      this.logger.error("Error procesando opción de listado:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async listRecentIncidents(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      const senderId = conversation.senderId;
      const userId = conversation.userId;

      await this.conversationService.update(conversationId, {
        state: "incident_listing_results",
        lastState: conversation.state,
      });

      const result = await this.incidentService.search(
        { ciudadano: userId },
        { page: 1, limit: 5, sort: { createdAt: -1 } },
      );

      if (!result.data || result.data.length === 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se encontraron reportes recientes. Si deseas crear un nuevo reporte, puedes hacerlo en cualquier momento.",
        );
        await this.conversationService.update(conversationId, {
          state: "initial",
          lastState: conversation.state,
        });
        return {
          success: true,
          intent: "incident_listing",
          message: "No hay reportes recientes",
          count: 0,
          nextState: "initial",
        };
      }

      await this.whatsAppService.sendTextMessage(
        senderId,
        `📊 *Reportes recientes (${result.data.length})*\n\nA continuación te muestro tus reportes más recientes:`,
      );

      for (const incident of result.data) {
        await this._sendIncidentSummary(senderId, incident);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (result.pagination.total > result.pagination.limit) {
        const remaining = result.pagination.total - result.pagination.limit;
        await this.whatsAppService.sendTextMessage(
          senderId,
          `Tienes ${remaining} reportes adicionales. Para ver más reportes, especifica qué tipo de reportes deseas consultar.`,
        );
      }

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Opciones adicionales",
        bodyText: "¿Qué deseas hacer ahora?",
        footerText: "Selecciona una opción",
        buttons: [
          { id: "iluc_status", text: "Filtrar por estado" },
          { id: "iluc_new", text: "Crear nuevo reporte" },
        ],
      });

      return {
        success: true,
        intent: "incident_listing",
        message: "Reportes recientes mostrados",
        count: result.data.length,
        total: result.pagination.total,
        nextState: "incident_listing_results",
      };
    } catch (error) {
      this.logger.error("Error listando incidentes recientes:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async processStatusSelection(conversation: any, message: any): Promise<any> {
    try {
      const conversationId = conversation._id;
      const senderId = conversation.senderId;
      const userId = conversation.userId;

      let estadoOption = "";
      if (
        message.type === "interactive" &&
        message.interactive.type === "list_reply"
      ) {
        estadoOption = message.interactive.list_reply.id;
        if (estadoOption.startsWith("iluc_estado_")) {
          estadoOption = estadoOption.substring(11);
        }
      }

      let estadoFilter = {};
      let estadoName = "Todos";
      let estadoObj: any = null;

      if (estadoOption !== "all") {
        try {
          estadoObj = await this.incidentService.getEstadoById(estadoOption);
          if (estadoObj) {
            estadoFilter = { estado: estadoOption };
            estadoName = estadoObj.nombre;
          } else {
            await this.whatsAppService.sendTextMessage(
              senderId,
              "Estado no reconocido. Mostrando todos los reportes.",
            );
          }
        } catch (error) {
          this.logger.error("Error al obtener estado:", error);
          await this.whatsAppService.sendTextMessage(
            senderId,
            "Hubo un problema al procesar el estado seleccionado. Mostrando todos los reportes.",
          );
        }
      }

      await this.conversationService.update(conversationId, {
        state: "incident_listing_results",
        lastState: conversation.state,
      });

      const searchCriteria = { ciudadano: userId, ...estadoFilter };
      const result = await this.incidentService.search(searchCriteria, {
        page: 1,
        limit: 5,
        sort: { createdAt: -1 },
      });

      if (!result.data || result.data.length === 0) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se encontraron reportes con estado: ${estadoName}. Si deseas consultar otros reportes, puedes especificar otro estado.`,
        );
        await this.whatsAppService.sendButtonMessage(senderId, {
          headerText: "Opciones adicionales",
          bodyText: "¿Qué deseas hacer ahora?",
          footerText: "Selecciona una opción",
          buttons: [
            { id: "iluc_recent", text: "Ver reportes recientes" },
            { id: "iluc_new", text: "Crear nuevo reporte" },
          ],
        });
        return {
          success: true,
          intent: "incident_listing",
          message: "No hay reportes con ese estado",
          count: 0,
          nextState: "incident_listing_results",
        };
      }

      await this.whatsAppService.sendTextMessage(
        senderId,
        `📊 *Reportes ${estadoName} (${result.data.length})*\n\nA continuación te muestro tus reportes con estado: ${estadoName}`,
      );

      for (const incident of result.data) {
        await this._sendIncidentSummary(senderId, incident);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (result.pagination.total > result.pagination.limit) {
        const remaining = result.pagination.total - result.pagination.limit;
        await this.whatsAppService.sendTextMessage(
          senderId,
          `Tienes ${remaining} reportes adicionales con este estado. Para una consulta más detallada, puedes usar la aplicación móvil.`,
        );
      }

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Opciones adicionales",
        bodyText: "¿Qué deseas hacer ahora?",
        footerText: "Selecciona una opción",
        buttons: [
          { id: "iluc_status", text: "Cambiar filtro de estado" },
          { id: "iluc_new", text: "Crear nuevo reporte" },
        ],
      });

      return {
        success: true,
        intent: "incident_listing",
        message: "Reportes filtrados mostrados",
        count: result.data.length,
        total: result.pagination.total,
        estadoName: estadoName,
        nextState: "incident_listing_results",
      };
    } catch (error) {
      this.logger.error("Error procesando selección de estado:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async viewIncidentDetail(conversation: any, message: any): Promise<any> {
    try {
      const senderId = conversation.senderId;
      let incidentId = "";

      if (message.type === "text") {
        const text = message.text.body.toLowerCase();
        const match = text.match(/reporte\s+(\w+)/);
        if (match && match[1]) {
          incidentId = match[1];
        }
      }

      if (!incidentId) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          "No se pudo identificar el reporte que deseas consultar. Por favor, especifica el número de reporte.",
        );
        return {
          success: false,
          intent: "incident_detail",
          message: "ID de incidente no proporcionado",
          nextState: conversation.state,
        };
      }

      const incident =
        await this.incidentService.getByIdAndPopulate(incidentId);

      if (!incident) {
        await this.whatsAppService.sendTextMessage(
          senderId,
          `No se encontró ningún reporte con el identificador ${incidentId}. Por favor, verifica el número e intenta nuevamente.`,
        );
        return {
          success: false,
          intent: "incident_detail",
          message: "Incidente no encontrado",
          nextState: conversation.state,
        };
      }

      await this._sendIncidentDetail(senderId, incident);

      await this.whatsAppService.sendButtonMessage(senderId, {
        headerText: "Opciones para este reporte",
        bodyText: "¿Qué deseas hacer con este reporte?",
        footerText: "Selecciona una opción",
        buttons: [
          { id: "iluc_status_update", text: "Ver actualizaciones" },
          { id: "iluc_recent", text: "Ver otros reportes" },
        ],
      });

      return {
        success: true,
        intent: "incident_detail",
        message: "Detalle de incidente mostrado",
        nextState: "incident_detail_shown",
      };
    } catch (error) {
      this.logger.error("Error mostrando detalle de incidente:", error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  private async _sendIncidentSummary(
    senderId: string,
    incident: any,
  ): Promise<any> {
    try {
      const createdDate = new Date(incident.createdAt);
      const formattedDate = `${createdDate.getDate()}/${createdDate.getMonth() + 1}/${createdDate.getFullYear()}`;

      const categoria = incident.categoria
        ? typeof incident.categoria === "object"
          ? incident.categoria.nombre
          : "No especificada"
        : "No especificada";

      const subcategoria = incident.subcategoria
        ? typeof incident.subcategoria === "object"
          ? incident.subcategoria.nombre
          : incident.subcategoria
        : null;

      let estadoEmoji = "⏳";
      let estadoNombre = "Pendiente";

      if (incident.estado) {
        if (typeof incident.estado === "object") {
          estadoEmoji = incident.estado.emoji || estadoEmoji;
          estadoNombre = incident.estado.nombre || estadoNombre;
        }
      }

      let summaryMessage = `📝 *Reporte #${incident._id}*\n`;
      summaryMessage += `*Fecha:* ${formattedDate}\n`;
      summaryMessage += `*Categoría:* ${categoria}\n`;
      if (subcategoria) {
        summaryMessage += `*Subcategoría:* ${subcategoria}\n`;
      }
      summaryMessage += `*Estado:* ${estadoEmoji} ${estadoNombre}\n`;

      const description = incident.descripcion || "Sin descripción";
      const shortDescription =
        description.length > 100
          ? description.substring(0, 97) + "..."
          : description;
      summaryMessage += `*Descripción:* ${shortDescription}\n`;
      summaryMessage += `\nPara ver el detalle completo, responde con "ver reporte ${incident._id}"`;

      await this.whatsAppService.sendTextMessage(senderId, summaryMessage);
      return { success: true, message: "Resumen de incidente enviado" };
    } catch (error) {
      this.logger.error("Error enviando resumen de incidente:", error);
      return { success: false, error: (error as Error).message };
    }
  }

  private async _sendIncidentDetail(
    senderId: string,
    incident: any,
  ): Promise<any> {
    try {
      const createdDate = new Date(incident.createdAt);
      const formattedCreatedDate = `${createdDate.getDate()}/${createdDate.getMonth() + 1}/${createdDate.getFullYear()} ${createdDate.getHours()}:${String(createdDate.getMinutes()).padStart(2, "0")}`;

      let updatedDate = "No actualizado";
      if (incident.updatedAt && incident.updatedAt !== incident.createdAt) {
        const updated = new Date(incident.updatedAt);
        updatedDate = `${updated.getDate()}/${updated.getMonth() + 1}/${updated.getFullYear()} ${updated.getHours()}:${String(updated.getMinutes()).padStart(2, "0")}`;
      }

      const categoria = incident.categoria
        ? typeof incident.categoria === "object"
          ? incident.categoria.nombre
          : "No especificada"
        : "No especificada";

      const subcategoria = incident.subcategoria
        ? typeof incident.subcategoria === "object"
          ? incident.subcategoria.nombre
          : incident.subcategoria
        : null;

      let estadoEmoji = "⏳";
      let estadoNombre = "Pendiente";
      let estadoDesc = "Tu reporte está en espera de asignación.";

      if (incident.estado) {
        if (typeof incident.estado === "object") {
          estadoEmoji = incident.estado.emoji || estadoEmoji;
          estadoNombre = incident.estado.nombre || estadoNombre;
          if (estadoNombre.toLowerCase().includes("progreso")) {
            estadoDesc =
              "Tu reporte está siendo atendido por el personal municipal.";
          } else if (estadoNombre.toLowerCase().includes("resuelto")) {
            estadoDesc = "Tu reporte ha sido resuelto satisfactoriamente.";
          } else if (estadoNombre.toLowerCase().includes("cancelado")) {
            estadoDesc = "Tu reporte ha sido cancelado.";
          } else if (estadoNombre.toLowerCase().includes("urgente")) {
            estadoDesc =
              "Tu reporte ha sido marcado como urgente y está recibiendo atención prioritaria.";
          }
        }
      }

      let detailMessage = `📋 *DETALLE COMPLETO DEL REPORTE*\n\n`;
      detailMessage += `*ID:* ${incident._id}\n`;
      detailMessage += `*Creado:* ${formattedCreatedDate}\n`;
      detailMessage += `*Última actualización:* ${updatedDate}\n\n`;
      detailMessage += `*Categoría:* ${categoria}\n`;
      if (subcategoria) {
        detailMessage += `*Subcategoría:* ${subcategoria}\n`;
      }
      detailMessage += `\n*ESTADO ACTUAL:* ${estadoEmoji} ${estadoNombre}\n`;
      detailMessage += `${estadoDesc}\n\n`;
      detailMessage += `*Descripción completa:*\n${incident.descripcion || "Sin descripción"}\n\n`;

      if (incident.direccion_geo) {
        detailMessage += `*Ubicación:* ${incident.direccion_geo.nombre || "No disponible"}\n\n`;
      }

      if (incident.priority) {
        let prioridadTexto = "Baja";
        let prioridadEmoji = "🟢";
        if (incident.priority === "medium") {
          prioridadTexto = "Media";
          prioridadEmoji = "🟡";
        } else if (incident.priority === "high") {
          prioridadTexto = "Alta";
          prioridadEmoji = "🔴";
        }
        detailMessage += `*Prioridad:* ${prioridadEmoji} ${prioridadTexto}\n`;
      }

      if (incident.urgencia) {
        detailMessage += `*Urgencia:* 🚨 Este reporte ha sido marcado como URGENTE\n`;
      }

      if (incident.respuesta) {
        detailMessage += `\n*Respuesta del municipio:*\n${incident.respuesta}\n\n`;
      }

      if (incident.encargado) {
        const encargadoNombre =
          typeof incident.encargado === "object"
            ? incident.encargado.nombres || "Funcionario municipal"
            : "Funcionario municipal";
        detailMessage += `*Asignado a:* ${encargadoNombre}\n`;
      }

      await this.whatsAppService.sendTextMessage(senderId, detailMessage);
      return { success: true, message: "Detalle de incidente enviado" };
    } catch (error) {
      this.logger.error("Error enviando detalle de incidente:", error);
      return { success: false, error: (error as Error).message };
    }
  }
}
