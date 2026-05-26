/**
 * incident-flow-exchange.service.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Maneja el protocolo data_exchange del WhatsApp Flow de registro de incidentes.
 *
 * Meta llama a POST /whatsapp/flows/incidents en dos momentos:
 *   • action = "init"          → El flow acaba de abrirse; devolver primera pantalla
 *   • action = "data_exchange" → El usuario avanzó de pantalla; devolver la siguiente
 *   • action = "ping"          → Health-check de Meta; responder { data: { status: "active" } }
 *
 * Flujo de pantallas:
 *   USER_LOOKUP → (usuario existe) → CATEGORIES → SUBCATEGORIES → DETAILS [complete]
 *              → (no existe)       → USER_REGISTER → CATEGORIES → ...
 *              → (error fecha)     → USER_REGISTER  (misma pantalla, nuevo mensaje)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { ConfigService } from "@nestjs/config";
import { IncidentService } from "@shared/modules/incident/incident.service";
import { UserService } from "@shared/modules/user/user.service";
import { USER_MODEL, UserDocument } from "@shared/modules/user/user.schema";

// ─── Tipos internos ───────────────────────────────────────────────────────────

export interface FlowExchangeRequest {
  version: string;
  action: "init" | "data_exchange" | "ping";
  flow_token: string;
  screen?: string;
  data?: Record<string, any>;
}

export interface FlowExchangeResponse {
  version: string;
  screen: string;
  data: Record<string, any>;
}

@Injectable()
export class IncidentFlowExchangeService {
  private readonly logger = new Logger(IncidentFlowExchangeService.name);

  constructor(
    @InjectModel(USER_MODEL)
    private readonly userModel: Model<UserDocument>,
    private readonly incidentService: IncidentService,
    private readonly userService: UserService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Punto de entrada principal ───────────────────────────────────────────────

  async handle(
    req: FlowExchangeRequest,
  ): Promise<FlowExchangeResponse | { data: { status: string } }> {
    const { action, screen, data, flow_token } = req;

    if (action === "ping") {
      return { data: { status: "active" } };
    }

    if (action === "init") {
      return this._handleInit();
    }

    if (action === "data_exchange" && screen) {
      return this._handleDataExchange(screen, data ?? {}, flow_token);
    }

    this.logger.warn(`Acción no reconocida: ${action}`);
    return this._screenError(
      "USER_LOOKUP",
      "Ocurrió un error inesperado. Intenta nuevamente.",
    );
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  /** El flow acaba de abrirse → mostrar pantalla de identificación */
  private _handleInit(): FlowExchangeResponse {
    return {
      version: "3.0",
      screen: "USER_LOOKUP",
      data: {
        info_text:
          "Para registrar tu reporte necesitamos identificarte. Ingresa tu número de cédula ecuatoriana.",
      },
    };
  }

  // ─── Data exchange por pantalla ───────────────────────────────────────────────

  private async _handleDataExchange(
    screen: string,
    data: Record<string, any>,
    flowToken: string,
  ): Promise<FlowExchangeResponse> {
    this.logger.log(`data_exchange — pantalla: ${screen}`);

    switch (screen) {
      case "USER_LOOKUP":
        return this._onUserLookup(data, flowToken);

      case "USER_REGISTER":
        return this._onUserRegister(data, flowToken);

      case "CATEGORIES":
        return this._onCategorySelected(data);

      default:
        this.logger.warn(`Pantalla sin handler: ${screen}`);
        return this._screenError(
          "USER_LOOKUP",
          "Error de navegación. Vuelve a intentarlo.",
        );
    }
  }

  // ─── Handlers por pantalla ────────────────────────────────────────────────────

  /**
   * USER_LOOKUP: el usuario ingresó su cédula.
   * Si el usuario existe → cargar categorías y pasar a CATEGORIES.
   * Si no existe          → pasar a USER_REGISTER para verificar identidad.
   */
  private async _onUserLookup(
    data: Record<string, any>,
    flowToken: string,
  ): Promise<FlowExchangeResponse> {
    const cedula = (data.cedula ?? "").trim();

    if (!cedula || !/^\d{10}$/.test(cedula)) {
      return this._screenError(
        "USER_LOOKUP",
        "La cédula debe tener exactamente 10 dígitos.",
      );
    }

    // Buscar usuario por DNI en la colección del sistema principal
    const existingUser = await this.userModel.findOne({ dni: cedula }).lean();

    if (existingUser) {
      // Usuario ya registrado → cargar categorías directamente
      const firstName = this._extractFirstName(
        existingUser.name ?? "",
        existingUser.last_name ?? "",
      );
      this.logger.log(`Usuario encontrado por DNI: ${cedula} → ${firstName}`);
      return this._buildCategoriesScreen(cedula, firstName);
    }

    // No registrado → pedir verificación de fecha de expedición
    return {
      version: "3.0",
      screen: "USER_REGISTER",
      data: {
        cedula,
        message:
          "No encontramos tu registro en el sistema. Necesitamos verificar tu identidad mediante la fecha de expedición de tu cédula.",
      },
    };
  }

  /**
   * USER_REGISTER: el usuario ingresó cédula + fecha de expedición.
   * 1. Validar cédula + fecha contra la GeoAPI del Municipio.
   * 2. Si válido → obtener nombre de DINARDAP → crear usuario → ir a CATEGORIES.
   * 3. Si inválido → volver a USER_REGISTER con mensaje de error.
   */
  private async _onUserRegister(
    data: Record<string, any>,
    flowToken: string,
  ): Promise<FlowExchangeResponse> {
    const cedula = (data.cedula ?? "").trim();
    // DatePicker de WhatsApp devuelve "YYYY-MM-DD" → convertir a "DD/MM/YYYY"
    const fechaRaw: string = data.fecha_expedicion ?? "";
    const fechaExpedicion = this._isoToSlash(fechaRaw);

    if (!cedula || !/^\d{10}$/.test(cedula)) {
      return {
        version: "3.0",
        screen: "USER_REGISTER",
        data: {
          cedula,
          message: "La cédula debe tener exactamente 10 dígitos.",
        },
      };
    }

    if (!fechaExpedicion) {
      return {
        version: "3.0",
        screen: "USER_REGISTER",
        data: {
          cedula,
          message: "La fecha de expedición es obligatoria.",
        },
      };
    }

    // ── 1. Validar cédula + fecha ──────────────────────────────────────────────
    const validationOk = await this._validateDateExpedicion(
      cedula,
      fechaExpedicion,
    );

    if (!validationOk) {
      return {
        version: "3.0",
        screen: "USER_REGISTER",
        data: {
          cedula,
          message:
            "❌ La fecha de expedición no coincide con los registros. " +
            "Verifica que sea la fecha exacta que aparece al reverso de tu cédula.",
        },
      };
    }

    // ── 2. Obtener nombre desde DINARDAP ───────────────────────────────────────
    const personData = await this._fetchPersonData(cedula);
    const fullName = personData?.nombre ?? "Ciudadano";
    const nameParts = fullName.trim().split(/\s+/);
    // Formato DINARDAP: "APELLIDO1 APELLIDO2 NOMBRE1 NOMBRE2"
    const firstName = nameParts.length >= 3 ? nameParts[2] : nameParts[0];
    const lastName =
      nameParts.length >= 2 ? `${nameParts[0]} ${nameParts[1]}` : nameParts[0];

    // ── 3. Crear usuario en el sistema ─────────────────────────────────────────
    // Extraer senderId del flow_token: "incident_{senderId}_{timestamp}"
    const senderId = this._extractSenderId(flowToken);
    const localPhone = senderId.replace(/^593/, "0");

    const createResult = await this.userService.createUser({
      name: firstName,
      last_name: lastName,
      dni: cedula,
      telf: localPhone,
      date_expedition: fechaExpedicion,
    });

    if (!createResult.success) {
      this.logger.warn(
        `Error creando usuario ${cedula}: ${createResult.message}`,
      );
      // Continuar de todos modos — el usuario podría ya existir con otro teléfono
    } else {
      this.logger.log(
        `Usuario creado/encontrado: ${cedula} — ${createResult.message}`,
      );
    }

    return this._buildCategoriesScreen(cedula, firstName);
  }

  /**
   * CATEGORIES: el usuario seleccionó una categoría.
   * Cargar subcategorías de esa categoría y pasar a SUBCATEGORIES.
   */
  private async _onCategorySelected(
    data: Record<string, any>,
  ): Promise<FlowExchangeResponse> {
    const categoryId = data.category_id ?? "";
    const cedula = data.cedula ?? "";
    const userName = data.user_name ?? "";

    if (!categoryId) {
      return this._screenError(
        "CATEGORIES",
        "Selecciona una categoría para continuar.",
      );
    }

    const subcategories =
      await this.incidentService.getSubcategoriesByCategory(categoryId);

    if (!subcategories || subcategories.length === 0) {
      return this._screenError(
        "CATEGORIES",
        "Esta categoría no tiene subcategorías disponibles. Elige otra.",
      );
    }

    return {
      version: "3.0",
      screen: "SUBCATEGORIES",
      data: {
        subcategories: subcategories.map((s: any) => ({
          id: s._id.toString(),
          title: s.nombre,
          description: s.descripcion ?? "",
        })),
        category_id: categoryId,
        cedula,
        user_name: userName,
      },
    };
  }

  // ─── Helpers de construcción ──────────────────────────────────────────────────

  /** Construye la respuesta de la pantalla CATEGORIES con todas las categorías cargadas */
  private async _buildCategoriesScreen(
    cedula: string,
    userName: string,
  ): Promise<FlowExchangeResponse> {
    const categories = await this.incidentService.getAllCategories();

    return {
      version: "3.0",
      screen: "CATEGORIES",
      data: {
        categories: categories.map((c: any) => ({
          id: c._id.toString(),
          title: c.nombre,
        })),
        cedula,
        user_name: userName,
      },
    };
  }

  /** Devuelve la misma pantalla con un mensaje de error sin cambiar de screen */
  private _screenError(
    screen: "USER_LOOKUP" | "USER_REGISTER" | "CATEGORIES",
    message: string,
  ): FlowExchangeResponse {
    const dataMap: Record<string, Record<string, any>> = {
      USER_LOOKUP: { info_text: message },
      USER_REGISTER: { cedula: "", message },
      CATEGORIES: {
        categories: [],
        user_name: "",
        cedula: "",
        info_error: message,
      },
    };
    return {
      version: "3.0",
      screen,
      data: dataMap[screen] ?? { message },
    };
  }

  // ─── Integración GeoAPI Municipio ─────────────────────────────────────────────

  /**
   * Valida la cédula + fecha de expedición contra la GeoAPI del Municipio de Esmeraldas.
   * GET https://geoapi.esmeraldas.gob.ec/new/dinardap/consultar_date_exp
   */
  private async _validateDateExpedicion(
    cedula: string,
    fechaExpedicion: string, // formato DD/MM/YYYY
  ): Promise<boolean> {
    const baseUrl =
      this.configService.get<string>("GEOAPI_URL") ??
      "https://geoapi.esmeraldas.gob.ec/new/dinardap";

    const url = `${baseUrl}/consultar_date_exp?identificacion=${cedula}&fechaExpedicion=${encodeURIComponent(fechaExpedicion)}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) {
        this.logger.warn(`GeoAPI status ${res.status} para cédula ${cedula}`);
        return false;
      }
      const body = (await res.json()) as { success: boolean; mensaje?: string };
      this.logger.log(
        `GeoAPI validación: success=${body.success} — ${body.mensaje ?? ""}`,
      );
      return body.success === true;
    } catch (err: any) {
      this.logger.error(`Error llamando GeoAPI validación: ${err.message}`);
      // Fail-open: si la API no responde no bloqueamos al ciudadano
      return true;
    }
  }

  /**
   * Obtiene los datos personales desde la GeoAPI (Registro Civil via DINARDAP).
   * GET https://geoapi.esmeraldas.gob.ec/new/dinardap/consultar
   * Devuelve null si falla — el caller usará un placeholder.
   */
  /**
   * Obtiene los datos personales desde la GeoAPI (Registro Civil via DINARDAP).
   * GET https://geoapi.esmeraldas.gob.ec/new/dinardap/consultar
   * Devuelve null si falla — el caller usará un placeholder.
   */
  private async _fetchPersonData(
    cedula: string,
  ): Promise<{ nombre: string | null; cedula: string | null } | null> {
    const baseUrl =
      this.configService.get<string>("GEOAPI_URL") ??
      "https://geoapi.esmeraldas.gob.ec/new/dinardap";

    const url = `${baseUrl}/consultar?identificacion=${cedula}&codigoPaquete=3789`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        success: boolean;
        datos?: {
          entidades?: Array<{
            data?: Array<{ nombre?: string; cedula?: string }>;
          }>;
        };
      };

      const personData = body.datos?.entidades?.[0]?.data?.[0];

      if (!personData) return null;

      // Asegurar que siempre devolvemos un objeto con las propiedades definidas
      return {
        nombre: personData.nombre ?? null,
        cedula: personData.cedula ?? null,
      };
    } catch (err: any) {
      this.logger.error(`Error llamando GeoAPI datos: ${err.message}`);
      return null;
    }
  }

  // ─── Utilidades ───────────────────────────────────────────────────────────────

  /**
   * Convierte "YYYY-MM-DD" (DatePicker de WhatsApp Flows) a "DD/MM/YYYY" (GeoAPI).
   * Devuelve "" si el formato no coincide.
   */
  private _isoToSlash(iso: string): string {
    if (!iso) return "";
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      // Intentar si ya viene en formato DD/MM/YYYY (por si acaso)
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) return iso;
      return "";
    }
    return `${match[3]}/${match[2]}/${match[1]}`;
  }

  /**
   * Extrae el senderId del flow_token con formato "incident_{senderId}_{timestamp}".
   * Ej: "incident_593979409799_1716300000000" → "593979409799"
   */
  private _extractSenderId(flowToken: string): string {
    const parts = flowToken.split("_");
    // parts[0] = "incident", parts[1] = senderId, parts[2] = timestamp
    return parts.length >= 3 ? parts[1] : "";
  }

  /**
   * Extrae el primer nombre del ciudadano.
   * DINARDAP entrega "APELLIDO1 APELLIDO2 NOMBRE1 NOMBRE2" en el campo `nombre`.
   * La colección de usuarios almacena name + last_name separados.
   */
  private _extractFirstName(name: string, _lastName: string): string {
    if (!name) return "Ciudadano";
    const parts = name.trim().split(/\s+/);
    return parts[0] ?? "Ciudadano";
  }
}
