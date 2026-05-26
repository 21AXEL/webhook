import {
  RemoveEvidenceInput,
  RemoveEvidenceUseCase,
} from "./use-cases/tickets/remove-evidence.use-case";
import { KnowledgeQueryUseCase } from "./use-cases/knowledge/knowledge-query.use-case";
import { KnowledgeUpdateUseCase } from "./use-cases/knowledge/knowledge-update.use-case";
import { IncidentListingUseCase } from "./use-cases/incident/incident-listing.use-case";
import { WebhookService } from "./webhook.service";
import { WhatsAppService } from "./services/whatsapp.service";
/**
 * webhook.module.ts
 * Módulo NestJS del webhook de WhatsApp.
 * Reemplaza ServiceInitializer.js + ServiceLocator.js:
 *   - Todos los servicios y UseCases se declaran en `providers[]`
 *   - El registro de intenciones/estados se hace en OnModuleInit (equivalente a initialize())
 *   - Los schemas de Conversation y Knowledge se registran tal cual para NO alterar la colección
 */

import { Module, OnModuleInit } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModule } from "@nestjs/config";

// Schemas (sin modificaciones estructurales)
import {
  CONVERSATION_MODEL,
  ConversationSchema,
} from "../../shared/schemas/conversation.schema";
import {
  KNOWLEDGE_MODEL,
  KnowledgeSchema,
} from "../../shared/schemas/knowledge.schema";

// Controlador
import { WebhookController } from "./webhook.controller";

// Servicios core
import { KnowledgeService } from "./services/knowledge.service";
import { AiService } from "./services/ai.service";
import { MediaProcessorService } from "./services/media-processor.service";
import { DataExtractorService } from "./services/data-extractor.service";

// Casos de uso
import { MediaProcessingUseCase } from "./use-cases/media-processing.use-case";
import { SystemInfoUseCase } from "./use-cases/system-info.use-case";
import { HelpUseCase } from "./use-cases/help.use-case";

// UserModule (para UserService)
import { UserModule } from "@shared/modules/user/user.module";
import { ConversationService } from "../conversation.service";
import { IntentProcessorService } from "../intent-processor.service";
import { UserRegistrationUseCase } from "./use-cases/user/user-registration.use-case";
import { IncidentCreationUseCase } from "./use-cases/incident/incident-creation.use-case";
import { EmergencyCreationUseCase } from "./use-cases/emergency/emergency-creation.use-case";
import { KnowledgeCreationUseCase } from "./use-cases/knowledge/knowledge-creation.use-case";
import { KnowledgeApprovalUseCase } from "./use-cases/knowledge/knowledge-approval.use-case";
import { KnowledgeSearchUseCase } from "./use-cases/knowledge/knowledge-search.use-case";
import { IncidentModule } from "@shared/modules/incident/incident.module";
import {
  CATEGORIA_MODEL,
  CategoriaSchema,
  ESTADO_INCIDENTE_MODEL,
  EstadoIncidenteSchema,
  INCIDENT_MODEL,
  IncidentSchema,
  SUBCATEGORIA_MODEL,
  SubcategoriaSchema,
} from "@shared/modules/incident/incident.schema";
import { USER_MODEL, UserSchema } from "@shared/modules/user/user.schema";
import { FileProcessor } from "@shared/services/file-processor.service";
import { EnhancedKnowledgeService } from "./services/enhanced-knowledge.service";
import { WelcomeUseCase } from "./use-cases/welcome/welcome.use-case";
import { ErpModule } from "@shared/modules/erp/erp.module";
import { TicketModule } from "@shared/modules/tickets/ticket.module";
import { RedisModule } from "@shared/modules/redis/redis.module";
import { TicketCreationUseCase } from "./use-cases/tickets/ticket-creation.use-case";
import { AddEvidenceUseCase } from "./use-cases/tickets/add-evidence.use-case";
import { ListEvidencesUseCase } from "./use-cases/tickets/list-evidences.use-case";
import { UpdateEvidenceUseCase } from "./use-cases/tickets/update-evidence.use-case";
import {
  TICKET_MODEL,
  TicketSchema,
} from "@shared/modules/tickets/ticket.schema";
import { TicketManagementUseCase } from "./use-cases/tickets/ticket-management.use-case";
import { TicketListingUseCase } from "./use-cases/tickets/ticket-listing.use-case";
import { MailModule } from "@shared/modules/mail/mail.module";
import { AgentConsentUseCase } from "./use-cases/agent/agent-consent.use-case";
import { AgentConsentModule } from "@shared/modules/agent-consent/agent-consent.module";
import { IncidentFlowUseCase } from "./use-cases/incident/incident-flow.use-case";

@Module({
  imports: [
    ConfigModule,
    // Registrar los modelos de Mongoose manteniendo los mismos nombres de colección
    // IMPORTANTE: el nombre del modelo determina la colección en MongoDB
    //   'Conversation' → colección 'conversations'
    //   'knowledge'    → colección 'knowledges'
    MongooseModule.forFeature([
      { name: CONVERSATION_MODEL, schema: ConversationSchema },
      { name: KNOWLEDGE_MODEL, schema: KnowledgeSchema },
    ]),
    IncidentModule,
    UserModule,
    ErpModule,
    TicketModule,
    RedisModule,
    MailModule,
    AgentConsentModule,
  ],
  controllers: [WebhookController],
  providers: [
    // ─── Servicios de infraestructura ────────────────────────────────────────
    WhatsAppService,
    AiService,
    MediaProcessorService,
    DataExtractorService,

    // ─── Servicios de dominio ─────────────────────────────────────────────────
    ConversationService,
    KnowledgeService,
    EnhancedKnowledgeService,
    WebhookService,

    // ─── Orquestador de intenciones ───────────────────────────────────────────
    IntentProcessorService,

    // ─── Casos de uso ─────────────────────────────────────────────────────────
    UserRegistrationUseCase,
    IncidentCreationUseCase,
    IncidentListingUseCase,
    IncidentFlowUseCase,
    EmergencyCreationUseCase,
    KnowledgeCreationUseCase,
    KnowledgeApprovalUseCase,
    KnowledgeUpdateUseCase,
    KnowledgeQueryUseCase,
    KnowledgeSearchUseCase,
    MediaProcessingUseCase,
    WelcomeUseCase,
    SystemInfoUseCase,
    HelpUseCase,
    FileProcessor,
    // ─── Casos de uso Tickets ──────────────────────────────────────────────────
    TicketCreationUseCase,
    AddEvidenceUseCase,
    ListEvidencesUseCase,
    RemoveEvidenceUseCase,
    UpdateEvidenceUseCase,
    TicketManagementUseCase,
    TicketListingUseCase,
    AgentConsentUseCase,
  ],
  exports: [WebhookService, WhatsAppService, ConversationService],
})
export class WebhookModule implements OnModuleInit {
  /**
   * Constructor: recibe todos los UseCases e IntentProcessor por DI.
   * Equivalente al bloque initialize() de ServiceInitializer.js.
   */
  constructor(
    private readonly intentProcessor: IntentProcessorService,

    private readonly userRegistrationUseCase: UserRegistrationUseCase,
    private readonly incidentCreationUseCase: IncidentCreationUseCase,
    private readonly incidentListingUseCase: IncidentListingUseCase,
    private readonly emergencyCreationUseCase: EmergencyCreationUseCase,
    private readonly knowledgeCreationUseCase: KnowledgeCreationUseCase,
    private readonly knowledgeApprovalUseCase: KnowledgeApprovalUseCase,
    private readonly knowledgeUpdateUseCase: KnowledgeUpdateUseCase,
    private readonly knowledgeQueryUseCase: KnowledgeQueryUseCase,
    private readonly knowledgeSearchUseCase: KnowledgeSearchUseCase,
    private readonly mediaProcessingUseCase: MediaProcessingUseCase,
    private readonly systemInfoUseCase: SystemInfoUseCase,
    private readonly helpUseCase: HelpUseCase,
    private readonly welcomeUseCase: WelcomeUseCase,
    private readonly ticketCreationUseCase: TicketCreationUseCase,
    private readonly ticketManagementUseCase: TicketManagementUseCase,
    private readonly ticketListingUseCase: TicketListingUseCase,
    private readonly addEvidenceUseCase: AddEvidenceUseCase,
    private readonly listEvidencesUseCase: ListEvidencesUseCase,
    private readonly removeEvidenceUseCase: RemoveEvidenceUseCase,
    private readonly updateEvidenceUseCase: UpdateEvidenceUseCase,
    private readonly agentConsentUseCase: AgentConsentUseCase,
    private readonly incidentFlowUseCase: IncidentFlowUseCase,
  ) {}

  onModuleInit(): void {
    this._registerIntentMappings();
    this._registerStateMappings();
    console.log("✅ IntentProcessor inicializado con todos los UseCases");
  }

  // ─── Intenciones detectadas por IA ───────────────────────────────────────────
  private _registerIntentMappings(): void {
    this.intentProcessor.registerIntentMapping(
      "register_user",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "create_incident",
      this.incidentFlowUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "list_incidents",
      this.incidentListingUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "create_emergency",
      this.emergencyCreationUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "create_knowledge",
      this.knowledgeCreationUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "approve_knowledge",
      this.knowledgeApprovalUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "update_knowledge",
      this.knowledgeUpdateUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "knowledge_query",
      this.knowledgeQueryUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "knowledge_search",
      this.knowledgeSearchUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "process_media",
      this.mediaProcessingUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "system_info",
      this.systemInfoUseCase,
    );
    this.intentProcessor.registerIntentMapping("help", this.helpUseCase);
    this.intentProcessor.registerIntentMapping(
      "free_text",
      this.knowledgeQueryUseCase,
    );
    this.intentProcessor.registerIntentMapping("welcome", this.welcomeUseCase);
    // En _registerIntentMappings():
    this.intentProcessor.registerIntentMapping(
      "create_ticket",
      this.ticketCreationUseCase,
    );

    this.intentProcessor.registerIntentMapping(
      "manage_tickets",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerIntentMapping(
      "list_my_tickets",
      this.ticketListingUseCase,
    );
  }

  // ─── Estados de conversación en curso ────────────────────────────────────────
  private _registerStateMappings(): void {
    // Registro de usuario
    this.intentProcessor.registerUseCase(
      "waiting_user_name",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_last_name",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_dni",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_dni_expedition",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_email",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_phone",
      this.userRegistrationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_user_confirmation",
      this.userRegistrationUseCase,
    );

    // Creación de incidente
    this.intentProcessor.registerUseCase(
      "incident_confirmation",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "confirming_ai_extract",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_category",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_subcategory",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_description",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_location",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_photos",
      this.incidentCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "waiting_incident_confirmation",
      this.incidentCreationUseCase,
    );

    // Listado de incidentes
    this.intentProcessor.registerUseCase(
      "incident_listing_options",
      this.incidentListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "incident_listing_status_selection",
      this.incidentListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "incident_listing_results",
      this.incidentListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "incident_detail_shown",
      this.incidentListingUseCase,
    );

    // Conocimiento
    this.intentProcessor.registerUseCase(
      "knowledge_update_content",
      this.knowledgeUpdateUseCase,
    );
    this.intentProcessor.registerUseCase(
      "knowledge_update_confirmation",
      this.knowledgeUpdateUseCase,
    );

    // Info del sistema
    this.intentProcessor.registerUseCase(
      "system_info_provided",
      this.systemInfoUseCase,
    );

    // Ayuda
    this.intentProcessor.registerUseCase("help_menu_shown", this.helpUseCase);
    this.intentProcessor.registerUseCase(
      "specific_help_provided",
      this.helpUseCase,
    );

    // En _registerStateMappings():
    this.intentProcessor.registerUseCase(
      "ticket_beneficiary_search",
      this.ticketCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_beneficiary_confirm",
      this.ticketCreationUseCase,
    );

    this.intentProcessor.registerUseCase(
      "ticket_awaiting_flow",
      this.ticketCreationUseCase,
    );

    this.intentProcessor.registerUseCase(
      "ticket_mgmt_panel",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_listing_open",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_confirm_accept",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_resolve_search",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_resolve_confirm",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_my_list",
      this.ticketListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_my_detail",
      this.ticketListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_rating",
      this.ticketListingUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_selecting_for",
      this.ticketCreationUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_post_creation_tis",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_resolve_evidence_prompt",
      this.ticketManagementUseCase,
    );
    this.intentProcessor.registerUseCase(
      "ticket_mgmt_resolve_evidence_collect",
      this.ticketManagementUseCase,
    );

    // state mapping
    this.intentProcessor.registerUseCase(
      "agent_consent_pending",
      this.agentConsentUseCase,
    );

    this.intentProcessor.registerUseCase(
      "incident_awaiting_flow",
      this.incidentFlowUseCase,
    );
  }
}
