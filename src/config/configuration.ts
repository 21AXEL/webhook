import { resolve } from "path";

// Fábrica de configuración centralizada para NestJS ConfigModule
export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? "3000", 10),
    env: process.env.NODE_ENV ?? "development",
    // Clave para firmar tokens de calificación enviados por correo
    ratingSecret: process.env.RATING_SECRET ?? "change_this_secret",
  },

  mongodb: {
    uri:
      process.env.MONGODB_URI ??
      "mongodb://localhost:27017/helpdesk_esmeraldas",
  },

  postgresql: {
    host: process.env.PG_HOST ?? "localhost",
    port: parseInt(process.env.PG_PORT ?? "5432", 10),
    database: process.env.PG_DATABASE ?? "erp",
    user: process.env.PG_USER ?? "postgres",
    password: process.env.PG_PASSWORD ?? "",
    maxConnections: parseInt(process.env.PG_MAX_CONN ?? "10", 10),
    idleTimeoutMs: parseInt(process.env.PG_IDLE_TIMEOUT ?? "30000", 10),
    connectionTimeoutMs: parseInt(process.env.PG_CONN_TIMEOUT ?? "5000", 10),
  },

  admin: {
    // Secret para el header Authorization: Bearer <secret>
    apiSecret: process.env.ADMIN_API_SECRET ?? "",
  },

  whatsapp: {
    // Número del bot en formato internacional sin + (ej: 593995767887)
    // Se usa para generar el wa.me link en notificaciones por correo.
    botPhone: process.env.BOT_WA_PHONE ?? "",
  },

  // Configuración SMTP para correos de calificación del servicio
  mail: {
    host: process.env.MAIL_HOST ?? "smtp.esmeraldas.gob.ec",
    port: parseInt(process.env.MAIL_PORT ?? "587", 10),
    secure: process.env.MAIL_SECURE === "true",
    user: process.env.MAIL_USER ?? "",
    password: process.env.MAIL_PASSWORD ?? "",
    from: process.env.MAIL_FROM ?? "helpdesk@esmeraldas.gob.ec",
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000/api",
  },

  // Unidades de TIS con permiso de crear tickets en nombre de otros funcionarios
  tis: {
    units: [
      "UNIDAD DE APLICACIONES Y SISTEMAS",
      "DIRECCION DE TECNOLOGIAS DE LA INFORMACION",
      "UNIDAD DE SOPORTE TECNOLOGICO",
    ] as string[],
  },

  files: {
    basePath: process.env.FILES_BASE_PATH ?? resolve(process.cwd(), "uploads"),
    publicUrl: process.env.FILES_PUBLIC_URL ?? "http://localhost:3000/uploads",
  },

  redis: {
    host: process.env.REDIS_HOST ?? "localhost",
    port: parseInt(process.env.REDIS_PORT ?? "6379", 10),
    password: process.env.REDIS_PASSWORD ?? "",
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? "10", 10),
  },

  flows: {
    TICKET_TECNICO:
      process.env.WHATSAPP_FLOW_TICKET_TECNICO ?? "1024894076866922",
    DISPONIBILIDAD:
      process.env.WHATSAPP_FLOW_ID_DISPONIBILIDAD ?? "2113617809198410",
  },
});
