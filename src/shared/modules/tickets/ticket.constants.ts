// Constantes de dominio del sistema de helpdesk

// ─────────────────────────────────────────────
// Líneas de soporte
// ─────────────────────────────────────────────

export enum SupportLine {
  TechnicalSupport = "TECHNICAL_SUPPORT", // Soporte técnico
  Infrastructure = "INFRASTRUCTURE", // Infraestructura
  Systems = "SYSTEMS", // Sistemas
}

// ─────────────────────────────────────────────
// Categorías por línea
// ─────────────────────────────────────────────

export enum TicketCategory {
  // Soporte técnico
  Internet = "INTERNET",
  Computers = "COMPUTERS",
  Printers = "PRINTERS",

  // Infraestructura
  Servers = "SERVERS",
  Wifi = "WIFI",

  // Sistemas
  Email = "EMAIL", // Correo institucional
  Cabildo = "CABILDO",
  Sigdar = "SIGDAR",
  Sigcal = "SIGCAL",
  Erp = "ERP",

  // Compartida — requiere descripción en `otherDescription`
  Other = "OTHER",
}

// Validación: qué categorías son válidas por línea
export const CATEGORIES_BY_LINE: Record<SupportLine, TicketCategory[]> = {
  [SupportLine.TechnicalSupport]: [
    TicketCategory.Internet,
    TicketCategory.Computers,
    TicketCategory.Printers,
    TicketCategory.Other,
  ],
  [SupportLine.Infrastructure]: [
    TicketCategory.Servers,
    TicketCategory.Internet,
    TicketCategory.Wifi,
    TicketCategory.Other,
  ],
  [SupportLine.Systems]: [
    TicketCategory.Email,
    TicketCategory.Cabildo,
    TicketCategory.Sigdar,
    TicketCategory.Sigcal,
    TicketCategory.Erp,
    TicketCategory.Other,
  ],
};

// ─────────────────────────────────────────────
// Estado del ticket
// ─────────────────────────────────────────────

export enum TicketStatus {
  Open = "OPEN", // Abierto — esperando asignación
  InProgress = "IN_PROGRESS", // En proceso por el agente
  Resolved = "RESOLVED", // Resuelto — esperando calificación del funcionario
  Closed = "CLOSED", // Cerrado tras calificación
  FalseTicket = "FALSE_TICKET", // Marcado como ticket falso
}

// Estados que bloquean la apertura de un nuevo ticket para el mismo funcionario
export const BLOCKING_STATUSES = new Set<TicketStatus>([
  TicketStatus.Open,
  TicketStatus.InProgress,
  TicketStatus.Resolved,
]);

// ─────────────────────────────────────────────
// Calificación del servicio
// ─────────────────────────────────────────────

export enum RatingValue {
  Good = "GOOD", // Bueno
  Bad = "BAD", // Malo
  Comment = "COMMENT", // Inconveniente / comentario
  False = "FALSE", // Ticket falso declarado por el funcionario
}
