# Helpdesk TIS — Municipio de Esmeraldas

Servicio de webhook WhatsApp Business para el sistema de soporte técnico interno de la Dirección de Tecnologías de la Información y Sistemas (TIS) del Municipio de Esmeraldas. Permite a los funcionarios municipales crear, consultar y gestionar tickets de soporte técnico directamente desde WhatsApp, y a los agentes TIS atenderlos desde el mismo canal.

---

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura](#2-arquitectura)
3. [Estructura del proyecto](#3-estructura-del-proyecto)
4. [Módulos del sistema](#4-módulos-del-sistema)
5. [Flujos de conversación](#5-flujos-de-conversación)
6. [Cron Jobs](#6-cron-jobs)
7. [WhatsApp Flows (Meta)](#7-whatsapp-flows-meta)
8. [API REST](#8-api-rest)
9. [Configuración y variables de entorno](#9-configuración-y-variables-de-entorno)
10. [Instalación y puesta en marcha](#10-instalación-y-puesta-en-marcha)
11. [Scripts de administración](#11-scripts-de-administración)
12. [Conocimientos previos y pendientes](#12-conocimientos-previos-y-pendientes)

---

## 1. Visión general

El sistema actúa como **bot de WhatsApp** conectado a la API de WhatsApp Business Cloud (Meta). Atiende dos tipos de usuarios:

**Funcionarios municipales (ciudadanos internos)**

- Se identifican por su número de teléfono cruzado contra el ERP (nómina PostgreSQL).
- Pueden abrir tickets de soporte (Internet, computadores, impresoras, servidores, sistemas, etc.) mediante un WhatsApp Flow interactivo.
- Consultan el estado de sus tickets activos e históricos.
- Califican el servicio recibido (vía WhatsApp o correo electrónico).

**Agentes TIS**

- Se identifican automáticamente por teléfono (ERP).
- Tienen un **Panel TIS** con opciones diferenciadas: ver tickets pendientes, aceptar y resolver tickets, abrir tickets para otros funcionarios.
- Confirman diariamente su disponibilidad mediante un WhatsApp Flow enviado cada mañana.
- Reciben notificaciones de tickets sin asignar en su línea de soporte.

Adicionalmente el bot mantiene una **base de conocimiento municipal** (consultas ciudadanas generales) y un módulo de **registro de incidentes/denuncias** ciudadanas heredado del sistema principal.

---

## 2. Arquitectura

```
WhatsApp Cloud API (Meta)
        │  POST /api/whatsapp/webhook
        ▼
  WebhookController
        │
  WebhookService          ← deduplicación (Redis), rate limit
        │
  IntentProcessorService  ← detección de intención (IA + botones) + enrutamiento
        │
  ┌─────┴──────────────────────────────────────────────────────────────┐
  │                        Use Cases                                    │
  │  WelcomeUseCase          TicketCreationUseCase                     │
  │  TicketManagementUseCase TicketListingUseCase                      │
  │  AgentConsentUseCase     UserRegistrationUseCase                   │
  │  IncidentCreationUseCase IncidentListingUseCase                    │
  │  KnowledgeQueryUseCase   KnowledgeUpdateUseCase  ...               │
  └─────────────────────────────────────────────────────────────────────┘
        │
  ┌─────┴──────────────────────────────────────────────────┐
  │                    Servicios compartidos                │
  │  ErpService (PostgreSQL)   TicketService (MongoDB)     │
  │  AgentConsentService       AgentAvailabilityService     │
  │  MailService (SMTP)        WhatsAppService (Graph API)  │
  │  AiService (OpenAI)        EnhancedKnowledgeService     │
  │  RedisService              TicketQueueService            │
  └────────────────────────────────────────────────────────┘
        │
  ┌─────┴──────────────────────────────┐
  │          Bases de datos             │
  │  MongoDB (datos del bot)            │
  │  PostgreSQL (nómina ERP — read-only)│
  │  Redis (dedup + rate limit)         │
  └─────────────────────────────────────┘
```

**Patrones clave:**

- **Use Case pattern**: cada flujo de conversación es un `UseCase` independiente con método `execute(conversation, message)`.
- **Máquina de estados**: `conversation.state` determina qué `UseCase` maneja el siguiente mensaje.
- **Detección de intención con IA**: para mensajes sin estado activo, `IntentProcessorService` llama a OpenAI para detectar la intención y enrutar.

---

## 3. Estructura del proyecto

```
src/
├── main.ts                          # Bootstrap NestJS
├── app.module.ts                    # Módulo raíz
│
├── admin/                           # Endpoints de administración
│   ├── admin.controller.ts          # POST /admin/availability/send, GET/POST /admin/consent
│   ├── admin.guard.ts               # Validación Bearer token (ADMIN_API_SECRET)
│   ├── admin.module.ts
│   └── consent-admin.service.ts     # Listado personal TIS + envío proactivo de consentimiento
│
├── config/
│   └── configuration.ts            # Mapeo de variables de entorno tipado
│
├── contact/
│   ├── conversation.service.ts      # CRUD de conversaciones + updateState()
│   ├── contact.module.ts
│   ├── intent-processor.service.ts  # Enrutador central (IA + buttons + estados)
│   └── webhook/
│       ├── webhook.controller.ts    # GET/POST /whatsapp/webhook
│       ├── webhook.service.ts       # Orquestación principal + dedup + rate limit
│       ├── webhook.module.ts        # Registro de todos los UseCases y estados
│       │
│       ├── services/
│       │   ├── ai.service.ts               # Wrapper OpenAI
│       │   ├── data-extractor.service.ts   # Extracción de datos con IA
│       │   ├── enhanced-knowledge.service.ts # Búsqueda semántica con IA
│       │   ├── knowledge.service.ts        # CRUD base de conocimiento
│       │   ├── media-processor.service.ts  # Procesamiento de imágenes/audio
│       │   └── whatsapp.service.ts         # Wrapper Graph API de Meta
│       │
│       └── use-cases/
│           ├── agent/
│           │   └── agent-consent.use-case.ts      # Manejo de consent_accept/decline
│           ├── emergency/
│           │   └── emergency-creation.use-case.ts
│           ├── incident/
│           │   ├── incident-creation.use-case.ts
│           │   └── incident-listing.use-case.ts
│           ├── knowledge/
│           │   ├── knowledge-approval.use-case.ts
│           │   ├── knowledge-creation.use-case.ts
│           │   ├── knowledge-query.use-case.ts
│           │   ├── knowledge-search.use-case.ts
│           │   └── knowledge-update.use-case.ts
│           ├── tickets/
│           │   ├── ticket-creation.use-case.ts    # Creación via WhatsApp Flow
│           │   ├── ticket-listing.use-case.ts     # Mis tickets
│           │   ├── ticket-management.use-case.ts  # Panel TIS
│           │   ├── add-evidence.use-case.ts
│           │   ├── list-evidences.use-case.ts
│           │   ├── update-evidence.use-case.ts
│           │   └── remove-evidence.use-case.ts
│           ├── user/
│           │   └── user-registration.use-case.ts
│           ├── welcome/
│           │   └── welcome.use-case.ts            # Identificación + menú inicial
│           ├── help.use-case.ts
│           ├── media-processing.use-case.ts
│           └── system-info.use-case.ts
│
├── database/
│   ├── database.module.ts
│   └── postgresql.provider.ts       # Pool pg para el ERP
│
├── jobs/
│   ├── jobs.module.ts
│   ├── availability-template.job.ts # Cron 08:00 ECT — envía template disponibilidad
│   ├── ticket-notification.job.ts   # Cron cada 5 min — notifica tickets sin asignar
│   └── availability-reset.job.ts    # Cron 00:00 ECT — expira PENDING del día anterior
│
├── shared/
│   ├── modules/
│   │   ├── agent-availability/      # Disponibilidad diaria de agentes
│   │   ├── agent-consent/           # Consentimiento LOPDP de agentes TIS
│   │   ├── erp/                     # Consulta ERP (PostgreSQL view_nomina_rol)
│   │   ├── incident/                # Incidentes/denuncias ciudadanas
│   │   ├── mail/                    # Notificaciones SMTP
│   │   ├── redis/                   # Dedup de mensajes + rate limiting
│   │   ├── ticket-queue/            # Cola de tickets para notificación
│   │   ├── tickets/                 # Dominio de tickets TIS
│   │   └── user/                    # Ciudadanos registrados
│   ├── schemas/
│   │   ├── conversation.schema.ts
│   │   └── knowledge.schema.ts
│   ├── services/
│   │   └── file-processor.service.ts
│   └── utils/
│       └── extractor-message.ts
│
docs/
├── postman/
│   └── v1-postman.json              # Colección Postman completa
└── whatsapp-bussines/
    └── flows/
        └── template/
            ├── TICKET_TECNICO.json   # Flow Meta — formulario de ticket
            └── DISPONIBILIDAD.json   # Flow Meta — disponibilidad diaria

scripts/
├── send-consent.js                  # CLI gestión de consentimiento
└── manage-flow.js                   # CLI gestión de flows en Meta
```

---

## 4. Módulos del sistema

### 4.1 Tickets (`shared/modules/tickets`)

Dominio central del helpdesk. Gestiona el ciclo de vida completo de un ticket de soporte.

**Líneas de soporte:**

| Línea               | Unidad ERP                        | Categorías                                |
| ------------------- | --------------------------------- | ----------------------------------------- |
| `TECHNICAL_SUPPORT` | Unidad de Soporte Tecnológico     | Internet, Computadores, Impresoras, Otro  |
| `INFRASTRUCTURE`    | Unidad de Infraestructura         | Servidores, WiFi, Internet, Otro          |
| `SYSTEMS`           | Unidad de Aplicaciones y Sistemas | Email, Cabildo, Sigdar, Sigcal, ERP, Otro |

**Estados del ticket:**

```
OPEN → IN_PROGRESS → RESOLVED → CLOSED
                   ↘ FALSE_TICKET
```

- `OPEN` — creado, esperando que un agente lo acepte
- `IN_PROGRESS` — agente lo tomó, en camino
- `RESOLVED` — agente lo marcó como resuelto, esperando calificación
- `CLOSED` — calificado por el funcionario
- `FALSE_TICKET` — marcado como falso por el agente o el funcionario

Un funcionario no puede tener más de un ticket activo (`OPEN`, `IN_PROGRESS` o `RESOLVED`) al mismo tiempo.

### 4.2 Consentimiento de agentes (`shared/modules/agent-consent`)

Implementa el requisito de la **Ley Orgánica de Protección de Datos Personales (LOPDP)** del Ecuador. Antes de enviar mensajes proactivos a los agentes TIS, el sistema solicita autorización explícita.

**Estados:** `PENDING → ACCEPTED | DECLINED`

Solo los agentes con estado `ACCEPTED` reciben el template de disponibilidad diario.

### 4.3 Disponibilidad de agentes (`shared/modules/agent-availability`)

Registra diariamente si cada agente TIS está disponible para atender tickets.

**Estados:** `PENDING → AVAILABLE | UNAVAILABLE | EXPIRED`

Un agente disponible (`AVAILABLE`) aparece en la cola de notificación de tickets sin asignar de su línea.

### 4.4 Cola de tickets (`shared/modules/ticket-queue`)

Cuando se crea un ticket, se encola automáticamente. El job de notificación lo procesa cada 5 minutos en horario laboral, notificando a los agentes disponibles de la línea correspondiente. Si un agente acepta el ticket, la entrada se marca como `ASSIGNED`.

### 4.5 ERP (`shared/modules/erp`)

Conecta en solo lectura a la vista `view_nomina_rol` de PostgreSQL. Provee:

- Búsqueda de empleado por teléfono (para identificar al remitente)
- Búsqueda por cédula
- Validación de pertenencia a unidades TIS (`isTisAgent()`)

### 4.6 Correo (`shared/modules/mail`)

Envía notificaciones SMTP en tres momentos del ciclo de ticket:

- **Ticket creado** — al beneficiario del ticket (con link al bot WA)
- **Ticket en atención** — cuando un agente lo acepta
- **Ticket resuelto** — con botones de calificación (Bueno / Malo / Falso) enlazados por token

---

## 5. Flujos de conversación

### 5.1 Identificación de usuario (todos los mensajes)

```
Mensaje entrante
      │
      ├── ¿Es agente TIS? (por teléfono en ERP)
      │       ├── SÍ → ¿Tiene consentimiento ACCEPTED?
      │       │           ├── NO → pedir consentimiento (corta flujo)
      │       │           └── SÍ → Menú TIS
      │       └── NO → ¿Está registrado en MongoDB (ciudadano)?
      │                   ├── SÍ → Menú ciudadano
      │                   └── NO → Flujo de registro
```

### 5.2 Creación de ticket (funcionario municipal)

```
"quiero reportar un problema" / botón "Reportar problema"
      │
      ├── Agente TIS → ¿Para ti o para otro funcionario?
      │       ├── Para mí → _sendTicketFlow()
      │       └── Para otro → buscar por cédula → confirmar → _sendTicketFlow()
      │
      └── Funcionario → identificar por ERP → _sendTicketFlow()
                                                    │
                                          WhatsApp Flow (TICKET_TECNICO)
                                                    │
                                          nfm_reply → crear ticket en DB
                                                    │
                                          Notificación correo + encolar para agentes
```

### 5.3 Panel TIS (agentes)

```
"panel" / botón "Panel TIS"
      │
      ├── 📋 Tickets pendientes → lista OPEN filtrada por línea del agente
      │       └── Seleccionar ticket → confirmar aceptación → IN_PROGRESS
      │
      └── ✅ Resolver ticket → buscar ticket por número → RESOLVED | FALSE_TICKET
                                    └── (opcional) solicitar evidencias fotográficas
```

### 5.4 Disponibilidad diaria (agentes)

```
08:00 AM ECT — Cron AvailabilityTemplateJob
      │
      ├── Solo agentes con consentimiento ACCEPTED
      │
      └── Envía template "disponibilidad_diaria" (con WhatsApp Flow DISPONIBILIDAD)
                │
                └── Agente responde → AVAILABLE | UNAVAILABLE
                        │
                        └── TicketNotificationJob notifica tickets pendientes
                            a agentes AVAILABLE de esa línea cada 5 min
```

### 5.5 Consentimiento (agentes — primer contacto)

**Reactivo** (agente escribe al bot):

- `WelcomeUseCase` detecta que no tiene consentimiento → muestra aviso LOPDP con botones

**Proactivo** (administrador dispara desde CLI o endpoint):

- `ConsentAdminService.sendConsentTemplate()` → template con quick_reply buttons
- Agente responde → `AgentConsentUseCase` registra ACCEPTED o DECLINED

---

## 6. Cron Jobs

| Job                       | Horario (ECT)                  | Función                                                       |
| ------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `AvailabilityTemplateJob` | Lun–Vie 08:00                  | Envía template de disponibilidad a agentes con consentimiento |
| `TicketNotificationJob`   | Lun–Vie 08:00–16:55 cada 5 min | Notifica tickets OPEN sin asignar a agentes disponibles       |
| `AvailabilityResetJob`    | Todos los días 00:00           | Marca EXPIRED los PENDING del día anterior                    |

---

## 7. WhatsApp Flows (Meta)

Los JSON de los flows están en `docs/whatsapp-bussines/flows/template/`.

### `TICKET_TECNICO.json`

Formulario de creación de ticket. Campos:

- `categoria` — Dropdown con todas las categorías (INTERNET, COMPUTERS, PRINTERS, SERVERS, WIFI, EMAIL, CABILDO, SIGDAR, SIGCAL, ERP, OTHER)
- `ubicacion` — Texto libre (Ej: "Piso 2 - Edificio Central")
- `descripcion` — TextArea, máx. 500 caracteres

Respuesta como `nfm_reply` → procesada en `_processFlowResponse()` de `TicketCreationUseCase`.

### `DISPONIBILIDAD.json`

Flow de confirmación de disponibilidad diaria. Botones: "✅ Sí, disponible" / "❌ No disponible". Se envía embebido en el template `disponibilidad_diaria`.

### Templates de Meta requeridos

| Nombre                         | Categoría | Descripción                                         |
| ------------------------------ | --------- | --------------------------------------------------- |
| `disponibilidad_diaria`        | UTILITY   | Template diario de disponibilidad con Flow embebido |
| `solicitud_consentimiento_tic` | UTILITY   | Aviso LOPDP con 2 quick_reply buttons               |

---

## 8. API REST

Prefijo global: `/api`

### Webhook WhatsApp

| Método | Ruta                    | Descripción                       |
| ------ | ----------------------- | --------------------------------- |
| `GET`  | `/api/whatsapp/webhook` | Verificación del webhook (Meta)   |
| `POST` | `/api/whatsapp/webhook` | Recepción de mensajes de WhatsApp |

### Calificación de tickets

| Método | Ruta                                          | Descripción                            |
| ------ | --------------------------------------------- | -------------------------------------- |
| `GET`  | `/api/tickets/rate/:token?v=good\|bad\|false` | Calificación web desde link del correo |

### Administración (requiere `Authorization: Bearer <ADMIN_API_SECRET>`)

| Método | Ruta                              | Descripción                                      |
| ------ | --------------------------------- | ------------------------------------------------ |
| `POST` | `/api/admin/availability/send`    | Disparar template de disponibilidad              |
| `GET`  | `/api/admin/consent`              | Listar personal TIS con estado de consentimiento |
| `POST` | `/api/admin/consent/send`         | Enviar aviso de consentimiento (batch)           |
| `POST` | `/api/admin/consent/send/:cedula` | Enviar aviso a un agente específico              |

**`POST /api/admin/availability/send` — body:**

```jsonc
{}                           // sin body → cédulas de prueba hardcodeadas
{ "cedulas": [] }            // array vacío → job completo (todos los TIS)
{ "cedulas": ["XXXXXXXXXX"] }// cédulas específicas
```

**`POST /api/admin/consent/send` — body:**

```jsonc
{}                                   // todos los que no han aceptado
{ "cedulas": ["XXXXXXXXXX"] }        // agentes específicos
{ "force": true }                    // incluir también los que ya aceptaron
```

Ver `docs/postman/v1-postman.json` para la colección Postman completa.

---

## 9. Configuración y variables de entorno

Copia `.env.example` a `.env` y rellena los valores:

```env
# ── General ──────────────────────────────────────────────────────────────────
NODE_ENV=development
PORT=3000
BASE_URL=https://tu-dominio.com/api   # URL pública HTTPS (para links de correo)
RATING_SECRET=                        # Clave para firmar tokens de calificación
ADMIN_API_SECRET=                     # Token de acceso a endpoints /admin

# ── MongoDB ───────────────────────────────────────────────────────────────────
MONGODB_URI=mongodb://localhost:27017/esmeraldas_la_bella

# ── PostgreSQL (ERP — solo lectura) ───────────────────────────────────────────
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=erp
PG_USER=postgres
PG_PASSWORD=

# ── WhatsApp Business Cloud API (Meta) ────────────────────────────────────────
WHATSAPP_ACCESS_TOKEN=          # Token permanente de Meta Business Suite
WHATSAPP_PHONE_NUMBER_ID=       # ID del número de teléfono de la app
WHATSAPP_TOKEN_WEBHOOBS=        # Token de verificación del webhook (typo heredado)
BOT_WA_PHONE=                   # Número WA del bot (593XXXXXXXXX) — para links en correos

# ── WhatsApp Flows ────────────────────────────────────────────────────────────
WHATSAPP_FLOW_TICKET_TECNICO=   # ID del Flow de creación de ticket
WHATSAPP_FLOW_ID_DISPONIBILIDAD=# ID del Flow de disponibilidad

# ── Templates ─────────────────────────────────────────────────────────────────
AVAILABILITY_TEMPLATE_NAME=disponibilidad_diaria
CONSENT_TEMPLATE_NAME=solicitud_consentimiento_tic

# ── OpenAI ────────────────────────────────────────────────────────────────────
CHATGPT_API_KEY=

# ── DINARDAP (verificación cédula ecuatoriana — fail-open si no se configura) ─
DINARDAP_URL=https://geoapi.esmeraldas.gob.ec/new/dinardap/consultar_date_exp
DINARDAP_API_KEY=

# ── SMTP ─────────────────────────────────────────────────────────────────────
MAIL_HOST=
MAIL_PORT=2525
MAIL_SECURE=false
MAIL_USER=
MAIL_PASSWORD=
MAIL_FROM=helpdesk <tecnologias.informacion@esmeraldas.gob.ec>

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_HOST=
REDIS_PORT=6380
REDIS_PASSWORD=
RATE_LIMIT_MAX=10               # Mensajes máximos por remitente por minuto

# ── Almacenamiento de evidencias ──────────────────────────────────────────────
FILES_BASE_PATH=                # Ruta absoluta al directorio de uploads
FILES_PUBLIC_URL=               # URL pública base para servir archivos

# ── Administración ────────────────────────────────────────────────────────────
ADMIN_WA_PHONE=593XXXXXXXXX     # Número WA del admin (recibe resúmenes y alertas)
```

### Configuración de unidades TIS (`configuration.ts`)

Las unidades ERP que se consideran personal TIS se configuran en `src/config/configuration.ts`:

```typescript
tis: {
  units: [
    "UNIDAD DE SOPORTE TECNOLOGICO",
    "UNIDAD DE APLICACIONES Y SISTEMAS",
    "UNIDAD DE INFRAESTRUCTURA",
    "DIRECCION DE TECNOLOGIAS DE LA INFORMACION",
  ];
}
```

---

## 10. Instalación y puesta en marcha

### Requisitos

- Node.js ≥ 18
- MongoDB
- PostgreSQL (con vista `view_nomina_rol` del ERP municipal)
- Redis
- Cuenta de WhatsApp Business Cloud (Meta) con número aprobado
- URL pública HTTPS (ngrok en desarrollo)

### Instalación

```bash
npm install
cp .env.example .env
# Editar .env con los valores reales
```

### Desarrollo

```bash
npm run start:dev
```

### Producción

```bash
npm run build
npm run start:prod
```

### Registrar el webhook en Meta

```
URL:   https://tu-dominio.com/api/whatsapp/webhook
Token: (valor de WHATSAPP_TOKEN_WEBHOOBS en .env)
```

Suscribir al campo `messages`.

### Alias de paths TypeScript

El proyecto usa alias en `tsconfig.json`:

```
@config/*  → src/config/*
@contact/* → src/contact/*
@database/*→ src/database/*
@shared/*  → src/shared/*
@jobs/*    → src/jobs/*
```

En producción se requiere `tsconfig-paths-bootstrap.js` (incluido en el script `start:prod`).

---

## 11. Scripts de administración

### `scripts/send-consent.js` — gestión de consentimiento

Requiere el servidor levantado y `ADMIN_API_SECRET` en `.env`.

```bash
# Listar todo el personal TIS con su estado de consentimiento
node scripts/send-consent.js list

# Filtrar por estado (pending | accepted | declined | no_record)
node scripts/send-consent.js list no_record

# Enviar aviso a todos los que aún no han respondido
node scripts/send-consent.js send-all

# Enviar aviso a todos (incluyendo quienes ya aceptaron)
node scripts/send-consent.js send-all --force

# Enviar a uno o varios agentes específicos por cédula
node scripts/send-consent.js send 0803768530
node scripts/send-consent.js send 0803768530 0802305581
```

### `scripts/manage-flow.js` — gestión de WhatsApp Flows en Meta

No requiere servidor. Llama directamente a la Graph API de Meta.

```bash
# Crear el flow vacío en Meta (obtiene el flow_id)
node scripts/manage-flow.js create

# Subir/actualizar el JSON de pantallas del flow
node scripts/manage-flow.js update

# Ver estado, validación y errores del flow
node scripts/manage-flow.js info

# Obtener URL de preview en el teléfono
node scripts/manage-flow.js preview

# Publicar el flow (⚠️ irreversible)
node scripts/manage-flow.js publish

# Simular una respuesta de flow al webhook local (sin WhatsApp real)
node scripts/manage-flow.js simulate COMPUTERS "Piso 2" "PC no enciende"
```

---

## 12. Conocimientos previos y pendientes

### Bugs conocidos

- **Typo en variable de entorno**: el controlador lee `WHATSAPP_TOKEN_WEBHOOBS` (debería ser `_WEBHOOKS`). Debe definirse con el typo hasta corregirlo en `webhook.controller.ts`.
- **Doble configuración de MongoDB**: `app.module.ts` lee `MONGODB_URI` directamente; `configuration.ts` también lo mapea. Ambas deben apuntar al mismo valor.

### Patches pendientes

- **`AgentConsentService`**: agregar `findAll()` para el listado admin del consentimiento.
- **`IntentProcessorService`**: manejar mensajes de tipo `button` (respuestas de template quick_reply). Actualmente solo maneja `interactive` (botones de `sendButtonMessage`).
- **`AgentConsentUseCase`**: normalizar extracción del `buttonId` para soportar tanto `interactive.button_reply.id` (botones en chat) como `button.payload` (quick_reply de template).

### Flujos de consentimiento

El template `solicitud_consentimiento_tic` debe crearse en Meta Business Manager con:

- Body con variable `{{1}}` = nombre del agente
- Botón 0 (QUICK_REPLY): payload `consent_accept`
- Botón 1 (QUICK_REPLY): payload `consent_decline`

COMANDOS PAR RESPALDOS:

C:\Program Files\PostgreSQL\18\bin>pg_dump -U postgres -d ERP_2026 -t par_ciu -t nom_personal -t nom_departamento -t nom_cargo -t nom_adicional -t par_catalogo -t public.view_nomina_rol > respaldo_rrhh.sql

C:\Program Files\MongoDB\Tools\100\bin>mongodump --db labella --out ./backup

pg_dump -U postgres -d ERP_2026 -t par_ciu -t nom_personal -t nom_departamento -t nom_cargo -t nom_adicional -t par_catalogo -t public.view_nomina_rol | gzip > respaldo_rrhh.sql.gz

(restaurar) pg_restore -U postgres -d nueva_base respaldo_rrhh.backup

https://developers.facebook.com/apps/

# Primer uso: crear el flow y obtener el ID

node scripts/manage-flow.js create

# Subir el JSON de pantallas

node scripts/manage-flow.js update

# Verificar estado y errores de validación

node scripts/manage-flow.js info

# Simular respuesta del flow al webhook local (sin tocar WhatsApp real)

node scripts/manage-flow.js simulate COMPUTERS "Piso 2" "PC sin internet"

# Publicar cuando esté listo

node scripts/manage-flow.js publish
