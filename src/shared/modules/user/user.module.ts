/**
 * user.module.ts
 * Módulo NestJS para el servicio de usuarios.
 * Registra los modelos apuntando a las colecciones 'users' y 'roles'
 * del sistema principal (mismo MongoDB, cero migración de datos).
 */

import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfigModule } from "@nestjs/config";
import { UserService } from "./user.service";
import { USER_MODEL, UserSchema, ROLE_MODEL, RoleSchema } from "./user.schema";

@Module({
  imports: [
    ConfigModule, // Necesario para DINARDAP_URL y DINARDAP_API_KEY
    MongooseModule.forFeature([
      // 'user'  →  colección 'users'  (mismo nombre que Model.User del sistema principal)
      { name: USER_MODEL, schema: UserSchema },
      // 'role'  →  colección 'roles'  (para resolver el rol Ciudadano al crear usuarios)
      { name: ROLE_MODEL, schema: RoleSchema },
    ]),
  ],
  providers: [UserService],
  exports: [UserService, MongooseModule],
})
export class UserModule {}
