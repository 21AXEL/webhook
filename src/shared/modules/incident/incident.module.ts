/**
 * incident.module.ts
 * Módulo NestJS para el servicio de incidentes.
 * Registra los modelos apuntando a las colecciones existentes del sistema principal.
 */

import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  INCIDENT_MODEL,
  IncidentSchema,
  ESTADO_INCIDENTE_MODEL,
  EstadoIncidenteSchema,
  CategoriaSchema,
  SubcategoriaSchema,
  EncargadoCategoriaSchema,
  CATEGORIA_MODEL,
  SUBCATEGORIA_MODEL,
  ENCARGADO_CATEGORIA_MODEL,
} from "./incident.schema";
import { IncidentService } from "./incident.service";
import { IncidentFlowController } from "./incident-flow.controller";
import { IncidentFlowExchangeService } from "./incident-flow-exchange.service";
import { UserModule } from "../user/user.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      // Mismo nombre de modelo que usa el sistema principal →
      // Mongoose resuelve la colección 'incidentes_denuncias' automáticamente
      { name: INCIDENT_MODEL, schema: IncidentSchema },
      // Colección 'estado_incidentes'
      { name: ESTADO_INCIDENTE_MODEL, schema: EstadoIncidenteSchema },
      // Colección 'categorias'
      { name: CATEGORIA_MODEL, schema: CategoriaSchema },
      // Colección 'subcategorias'
      { name: SUBCATEGORIA_MODEL, schema: SubcategoriaSchema },
      // Colección 'encargado_categorias'
      { name: ENCARGADO_CATEGORIA_MODEL, schema: EncargadoCategoriaSchema },
    ]),
    UserModule,
  ],
  providers: [IncidentService, IncidentFlowExchangeService],
  controllers: [IncidentFlowController],
  exports: [IncidentService, IncidentFlowExchangeService, MongooseModule],
})
export class IncidentModule {}
