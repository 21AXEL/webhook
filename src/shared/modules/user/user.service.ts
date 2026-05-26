/**
 * user.service.ts
 * Servicio de dominio para gestionar usuarios.
 * Se conecta a las mismas colecciones MongoDB del sistema principal.
 * Implementa los métodos que los use-cases del webhook necesitan:
 *   getById, getByPhoneNumber, createUser, formatUserData, update.
 */

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { Model } from "mongoose";
import axios from "axios";
import {
  USER_MODEL,
  ROLE_MODEL,
  UserDocument,
  RoleDocument,
} from "./user.schema";

// ─── Tipos internos ───────────────────────────────────────────────────────────

/** Estructura del campo tempUserData almacenado en la conversación */
interface TempField {
  value: string;
  isValid: boolean;
}

interface TempUserData {
  name?: TempField;
  last_name?: TempField;
  dni?: TempField;
  telf?: TempField;
  email?: TempField;
  date_expedition?: TempField;
  [key: string]: TempField | undefined;
}

interface CreateUserResult {
  success: boolean;
  data: UserDocument | null;
  message: string;
}

// ─── Constante del rol ciudadano ──────────────────────────────────────────────
const CITIZEN_ROLE_NAME = "Ciudadano";

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectModel(USER_MODEL)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(ROLE_MODEL)
    private readonly roleModel: Model<RoleDocument>,
    private readonly configService: ConfigService,
  ) {}

  // ─── Consultas ────────────────────────────────────────────────────────────────

  /** Obtiene un usuario por su ID, populando el rol */
  async getById(id: string): Promise<UserDocument> {
    const user = await this.userModel
      .findById(id)
      .populate({ path: "role", populate: { path: "permisos" } });
    if (!user) throw new NotFoundException("Usuario no encontrado");
    return user;
  }

  /**
   * Busca un usuario por número de teléfono.
   * Acepta tanto el formato local (0XXXXXXXXX) como el internacional (593XXXXXXXXX).
   */
  async getByPhoneNumber(phoneNumber: string): Promise<UserDocument | null> {
    // Normalizar: quitar prefijo ecuatoriano si viene con +593 / 593
    const normalizedPhone = phoneNumber.replace(/^593/, "0");
    return this.userModel.findOne({
      $or: [{ telf: phoneNumber }, { telf: normalizedPhone }],
    });
  }

  // ─── Creación ─────────────────────────────────────────────────────────────────

  /**
   * Verifica la cédula contra DINARDAP y crea el usuario en la colección principal.
   * Si el usuario ya existe (por DNI o teléfono), devuelve el existente sin error.
   *
   * @param userData - Datos ya en formato plano (resultado de formatUserData)
   */
  async createUser(userData: Record<string, any>): Promise<CreateUserResult> {
    try {
      // Asignar rol Ciudadano si no viene especificado
      if (!userData.role) {
        const citizenRole = await this._getOrCreateCitizenRole();
        userData.role = citizenRole._id;
      }

      // Verificar si ya existe por DNI
      if (userData.dni) {
        const existing = await this.userModel.findOne({ dni: userData.dni });
        if (existing) {
          return {
            success: true,
            data: existing,
            message: `Bienvenido de nuevo, ${existing.name}.`,
          };
        }
      }

      // Verificar si ya existe por teléfono
      if (userData.telf) {
        const existingByPhone = await this.getByPhoneNumber(userData.telf);
        if (existingByPhone) {
          return {
            success: true,
            data: existingByPhone,
            message: `Bienvenido de nuevo, ${existingByPhone.name}.`,
          };
        }
      }

      // Verificar cédula con DINARDAP
      if (userData.date_expedition && userData.dni) {
        const dinardapResult = await this._verifyDNI(
          userData.dni,
          userData.date_expedition,
        );
        if (!dinardapResult.success) {
          return {
            success: false,
            data: null,
            message: dinardapResult.message,
          };
        }
      }

      // Asignar email placeholder si el ciudadano no proporcionó uno
      if (!userData.email) {
        const phoneSuffix = (userData.telf ?? `whatsapp_${Date.now()}`).replace(
          /\D/g,
          "",
        );
        userData.email = `whatsapp.${phoneSuffix}@esmeraldas.gob.ec`;
      }

      // Asignar contraseña temporal aleatoria (el ciudadano no inicia sesión por password)
      if (!userData.password) {
        userData.password = Math.random().toString(36).slice(-10);
      }

      // Eliminar campo date_expedition — no pertenece al schema del sistema principal
      const { date_expedition, ...userDataToSave } = userData;

      const newUser = await this.userModel.create(userDataToSave);
      this.logger.log(`Usuario creado: ${newUser._id} (${newUser.name})`);

      return {
        success: true,
        data: newUser,
        message: `¡Registro exitoso! Bienvenido, ${newUser.name}.`,
      };
    } catch (error) {
      this.logger.error("Error al crear usuario:", error);
      // Manejar duplicado de email/dni de Mongoose (código 11000)
      if ((error as any).code === 11000) {
        const field =
          Object.keys((error as any).keyPattern ?? {})[0] ?? "campo";
        return {
          success: false,
          data: null,
          message: `El ${field} ya está registrado en el sistema.`,
        };
      }
      return {
        success: false,
        data: null,
        message:
          "Error al registrar el usuario. Por favor, intenta nuevamente.",
      };
    }
  }

  // ─── Actualización ────────────────────────────────────────────────────────────

  /** Actualiza campos de un usuario */
  async update(
    id: string,
    updateData: Record<string, any>,
  ): Promise<UserDocument> {
    const user = await this.userModel.findByIdAndUpdate(id, updateData, {
      new: true,
    });
    if (!user) throw new NotFoundException("Usuario no encontrado");
    return user;
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────────

  /**
   * Aplana el formato tempUserData → objeto plano con los valores.
   * Soporta tanto la estructura { campo: { value, isValid } } como
   * datos ya planos (retorna tal cual).
   *
   * Ejemplo:
   *   { name: { value: 'Juan', isValid: true }, ... }
   *   → { name: 'Juan', ... }
   */
  formatUserData(
    userData: TempUserData | Record<string, any>,
  ): Record<string, any> {
    // Si los datos no tienen la estructura tempUserData, devolver tal cual
    const firstVal = Object.values(userData)[0];
    if (!firstVal || typeof firstVal !== "object" || !("value" in firstVal)) {
      return userData as Record<string, any>;
    }

    return Object.entries(userData).reduce<Record<string, any>>(
      (acc, [key, item]) => {
        acc[key] = (item as TempField).value ?? "";
        return acc;
      },
      {},
    );
  }

  /**
   * Valida los datos de usuario antes de intentar el registro.
   * Retorna un objeto { isValid, errors } para uso en el use-case si se necesita.
   */
  validateUserData(userData: Record<string, any>): {
    isValid: boolean;
    errors: Record<string, string>;
  } {
    const errors: Record<string, string> = {};

    if (!userData.name?.trim()) errors.name = "El nombre es requerido";
    if (!userData.last_name?.trim())
      errors.last_name = "El apellido es requerido";
    if (!userData.dni || !/^\d{10}$/.test(userData.dni))
      errors.dni = "La cédula debe tener 10 dígitos";
    if (userData.email && !/^[\w.-]+@[\w.-]+\.\w+$/.test(userData.email))
      errors.email = "Correo electrónico inválido";
    if (!userData.telf) errors.telf = "El teléfono es requerido";
    if (
      !userData.date_expedition ||
      !/^\d{2}\/\d{2}\/\d{4}$/.test(userData.date_expedition)
    )
      errors.date_expedition = "Formato de fecha inválido (DD/MM/AAAA)";

    return { isValid: Object.keys(errors).length === 0, errors };
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────────

  /**
   * Obtiene el rol 'Ciudadano'. Si no existe lo crea para no bloquear el registro.
   * El rol creado aquí es mínimo — el sistema principal puede enriquecerlo después.
   */
  private async _getOrCreateCitizenRole(): Promise<RoleDocument> {
    let role = await this.roleModel.findOne({ name: CITIZEN_ROLE_NAME });
    if (!role) {
      this.logger.warn(
        `Rol '${CITIZEN_ROLE_NAME}' no encontrado — creando uno básico.`,
      );
      role = await this.roleModel.create({
        name: CITIZEN_ROLE_NAME,
        permisos: [],
      });
    }
    return role;
  }

  /**
   * Verifica la cédula ecuatoriana contra el servicio DINARDAP.
   * Si el servicio no está disponible, permite continuar (fail-open) con un log de aviso.
   */
  private async _verifyDNI(
    dni: string,
    dateExpedition: string,
  ): Promise<{ success: boolean; message: string }> {
    const baseUrl = this.configService.get<string>("DINARDAP_URL");
    //const apiKey = this.configService.get<string>("DINARDAP_API_KEY");

    if (!baseUrl) {
      this.logger.warn(
        "DINARDAP_URL no configurado — omitiendo verificación de cédula.",
      );
      return {
        success: true,
        message: "Verificación omitida (servicio no configurado)",
      };
    }

    try {
      const response = await axios.post(
        baseUrl,
        { identificacion: dni, fechaExpedicion: dateExpedition },
        {
          headers: {
            //  Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 8000,
        },
      );

      const data = response.data;

      if (data?.success === false) {
        return {
          success: false,
          message: data.mensaje ?? "La cédula no pudo ser verificada.",
        };
      }

      return { success: true, message: "Cédula verificada correctamente" };
    } catch (error) {
      // Si DINARDAP falla por red/timeout, registrar y continuar para no bloquear al ciudadano
      this.logger.warn(
        `DINARDAP no disponible (${(error as Error).message}) — omitiendo verificación.`,
      );
      return {
        success: true,
        message: "Verificación omitida por disponibilidad del servicio",
      };
    }
  }
}
