// ─── Utilidades (antes en ExtractorMessage.js) ───────────────────────────────────

/**
 * Extrae el texto plano de un mensaje de WhatsApp según su tipo
 * @param message - Objeto de mensaje de WhatsApp
 * @returns Texto extraído o string vacío
 */
export function _extractMessageText(message: any): string {
  if (!message) return "";
  switch (message.type) {
    case "text":
      return message.text?.body ?? "";
    case "button":
      return message.button?.text ?? "";
    case "interactive":
      return (
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        ""
      );
    case "location":
      return message.location?.address ?? "";
    default:
      return "";
  }
}

/**
 * Extrae los datos de ubicación de un mensaje tipo location de WhatsApp
 * @param message - Objeto de mensaje de tipo location
 * @returns Objeto con datos de ubicación
 */
export function _extractLocationFromMessage(message: any): any {
  if (!message || message.type !== "location") return {};

  const { latitude, longitude, address, name } = message.location || {};

  return {
    nombre: address || name || "Ubicación compartida",
    latitude,
    longitude,
    address: address || "",
    coordinates: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
  };
}

/**
 * Verifica si la conversación tiene una ubicación válida
 * @private
 * @param {Object} conversation - Conversación
 * @returns {Boolean} True si tiene ubicación válida
 */
export const _hasValidLocation = function (conversation) {
  return (
    conversation.tempIncidentData &&
    conversation.tempIncidentData.location &&
    conversation.tempIncidentData.location.latitude &&
    conversation.tempIncidentData.location.longitude
  );
};

/**
 * Extrae datos de usuario de una conversación
 * @param {Object} conversation - Conversación a procesar
 * @returns {Object} - Datos de usuario
 */
export const _extractUserData = function (conversation) {
  return {
    name: conversation.userId
      ? `${conversation.userId.name || ""} ${
          conversation.userId.last_name || ""
        }`.trim()
      : "Usuario no identificado",
    phone: conversation.senderId,
  };
};

/**
 * Extrae datos de ubicación de una conversación
 * @param {Object} conversation - Conversación a procesar
 * @returns {Object} - Datos de ubicación
 */
export const _extractLocationData = function (conversation) {
  const location = conversation.tempIncidentData?.location || {};

  return {
    address: location.address || "Dirección no especificada",
    coordinates:
      location.latitude && location.longitude
        ? `${location.latitude}, ${location.longitude}`
        : "Coordenadas no disponibles",
    mapLink:
      location.latitude && location.longitude
        ? `https://maps.google.com/?q=${location.latitude},${location.longitude}`
        : "#",
  };
};
