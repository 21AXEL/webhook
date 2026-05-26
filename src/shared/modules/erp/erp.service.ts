// Servicio de acceso al ERP municipal vía PostgreSQL
// Responsabilidades: identificar funcionarios por cédula o teléfono,
// actualizar datos de contacto, verificar pertenencia a TIS.
import { Injectable, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Pool, QueryResult } from "pg";
import { PG_POOL } from "../../../database/postgresql.provider";

// ─────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────

export interface Employee {
  citizenId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  institutionalEmail: string | null;
  personalEmail: string | null;
  mobile: string | null;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  address: string | null;
  status: "ACTIVE";
  startDate: Date | null;
  regime: string | null;
  contractType: string | null;
}

export interface EmployeeSummary extends Pick<
  Employee,
  | "citizenId"
  | "firstName"
  | "lastName"
  | "fullName"
  | "jobTitle"
  | "department"
  | "status"
  | "mobile"
  | "phone"
> {}

export interface UpdateContactFields {
  email?: string;
  mobile?: string;
  photo?: string; // Referencia a foto de perfil (campo `grafico` en ERP)
}

export interface SearchEmployeeCriteria {
  jobTitle?: string;
  department?: string;
}

// Fila cruda devuelta por view_nomina_rol
interface NominaRow {
  idprov: string;
  nombre: string;
  apellido: string;
  correo: string;
  emaile: string;
  movil: string;
  telefono: string;
  unidad: string;
  cargo: string;
  estado: string;
  ccorreo: string;
  direccion: string;
  fecha: Date;
  regimen: string;
  tipo_contrato: string;
}

// ─────────────────────────────────────────────
// Servicio
// ─────────────────────────────────────────────

@Injectable()
export class ErpService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // Utilidades de limpieza de datos
  // ─────────────────────────────────────────────

  /**
   * Elimina espacios en blanco al inicio y final (frecuentes en el ERP).
   * Retorna null si el valor queda vacío.
   */
  private sanitize(value: string | null | undefined): string | null {
    return (value ?? "").trim() || null;
  }

  /**
   * Valida y normaliza un correo institucional (@esmeraldas.gob.ec).
   */
  private validateInstitutionalEmail(
    email: string | null | undefined,
  ): string | null {
    const clean = this.sanitize(email);
    if (!clean) return null;
    return clean.toLowerCase().endsWith("@esmeraldas.gob.ec")
      ? clean.toLowerCase()
      : null;
  }

  /**
   * Extrae el correo personal de los campos disponibles en la nómina.
   * - `emaile` puede ser personal o duplicado del institucional.
   * - `ccorreo` es el correo de contacto de emergencia (a veces tiene el personal).
   */
  private extractPersonalEmail(row: NominaRow): string | null {
    const emaile = this.sanitize(row.emaile);
    const ccorreo = this.sanitize(row.ccorreo);

    if (emaile && !emaile.toLowerCase().endsWith("@esmeraldas.gob.ec")) {
      return emaile.toLowerCase();
    }
    if (ccorreo && !ccorreo.toLowerCase().endsWith("@esmeraldas.gob.ec")) {
      return ccorreo.toLowerCase();
    }
    return null;
  }

  /**
   * Valida un número móvil ecuatoriano (formato 09XXXXXXXX).
   * Elimina espacios y guiones antes de validar.
   */
  private validateMobileNumber(
    number: string | null | undefined,
  ): string | null {
    const clean = (number ?? "").replace(/[\s\-]/g, "");
    return /^09\d{8}$/.test(clean) ? clean : null;
  }

  /**
   * Mapea una fila de `view_nomina_rol` al objeto estándar de empleado.
   */
  private mapEmployeeRow(row: NominaRow): Employee {
    const firstName = this.sanitize(row.nombre) ?? "";
    const lastName = this.sanitize(row.apellido) ?? "";
    return {
      citizenId: this.sanitize(row.idprov)!,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`.trim(),
      institutionalEmail: this.validateInstitutionalEmail(row.correo),
      personalEmail: this.extractPersonalEmail(row),
      mobile: this.validateMobileNumber(this.sanitize(row.movil)),
      phone: this.sanitize(row.telefono),
      jobTitle: this.sanitize(row.cargo),
      department: this.sanitize(row.unidad),
      address: this.sanitize(row.direccion),
      status: "ACTIVE",
      startDate: row.fecha ?? null,
      regime: this.sanitize(row.regimen),
      contractType: this.sanitize(row.tipo_contrato),
    };
  }

  // ─────────────────────────────────────────────
  // Verificación de pertenencia a TIS
  // ─────────────────────────────────────────────

  /**
   * Retorna true si el empleado pertenece a una de las unidades de TIS
   * que pueden crear tickets en nombre de otros funcionarios.
   */
  isTisAgent(employee: Employee | EmployeeSummary | null): boolean {
    if (!employee?.department) return false;
    const dept = employee.department.toUpperCase().trim();
    const units = this.configService.get<string[]>("tis.units") ?? [];
    return units.some((unit) => dept === unit.toUpperCase().trim());
  }

  // ─────────────────────────────────────────────
  // Consultas principales
  // ─────────────────────────────────────────────

  /**
   * Busca un funcionario activo por número de cédula.
   * Retorna null si no existe en la nómina.
   */
  async getEmployeeByCitizenId(citizenId: string): Promise<Employee | null> {
    try {
      const result: QueryResult<NominaRow> = await this.pool.query(
        `SELECT idprov, nombre, apellido, correo, emaile,
                movil, telefono, unidad, cargo, estado, ccorreo,
                direccion, fecha, regimen, tipo_contrato
         FROM view_nomina_rol
         WHERE TRIM(idprov) = $1
           AND estado = 'S'`,
        [citizenId.trim()],
      );

      if (result.rows.length === 0) return null;
      return this.mapEmployeeRow(result.rows[0]);
    } catch (error) {
      console.error(
        "❌ Error consultando empleado por cédula:",
        (error as Error).message,
      );
      return null;
    }
  }

  /**
   * Identifica un funcionario activo por su número de teléfono o móvil.
   * Permite identificar al usuario sin que ingrese su cédula.
   * Retorna null si no hay coincidencia o el resultado es ambiguo.
   */
  async getEmployeeByPhone(phoneNumber: string): Promise<Employee | null> {
    const normalized = phoneNumber.replace(/[\s\-]/g, "").trim();
    if (!normalized) return null;

    try {
      const result: QueryResult<NominaRow> = await this.pool.query(
        `SELECT idprov, nombre, apellido, correo, emaile,
          movil, telefono, unidad, cargo, estado, ccorreo,
          direccion, fecha, regimen, tipo_contrato
          FROM view_nomina_rol
          WHERE estado = 'S'
            AND (
              REPLACE(TRIM(movil), ' ', '') ILIKE '%' || $1 || '%'
              OR REPLACE(TRIM(telefono), ' ', '') ILIKE '%' || $1 || '%'
            )
          LIMIT 2`,
        [normalized],
      );

      // Resultado ambiguo: no asumimos identidad
      if (result.rows.length !== 1) return null;
      return this.mapEmployeeRow(result.rows[0]);
    } catch (error) {
      console.error(
        "❌ Error consultando empleado por teléfono:",
        (error as Error).message,
      );
      return null;
    }
  }

  /**
   * Actualiza datos de contacto del funcionario en la tabla `par_ciu`.
   * Solo actualiza los campos incluidos en `fields`.
   */
  async updateContactInfo(
    citizenId: string,
    fields: UpdateContactFields,
  ): Promise<{ updated: boolean; rowCount: number }> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (fields.email !== undefined) {
      sets.push(`correo = $${idx++}`);
      params.push(fields.email);
    }
    if (fields.mobile !== undefined) {
      sets.push(`movil = $${idx++}`);
      params.push(fields.mobile);
    }
    // Campo para almacenar referencia a foto de perfil
    if (fields.photo !== undefined) {
      sets.push(`grafico = $${idx++}`);
      params.push(fields.photo);
    }

    if (sets.length === 0) return { updated: false, rowCount: 0 };

    params.push(citizenId.trim());
    const query = `UPDATE par_ciu SET ${sets.join(", ")} WHERE TRIM(idprov) = $${idx}`;

    try {
      const result = await this.pool.query(query, params);
      console.log(
        `📝 ERP actualizado — cédula ${citizenId}: ${sets.join(", ")} (${result.rowCount} filas)`,
      );
      return {
        updated: (result.rowCount ?? 0) > 0,
        rowCount: result.rowCount ?? 0,
      };
    } catch (error) {
      console.error(
        `❌ Error actualizando ERP para ${citizenId}:`,
        (error as Error).message,
      );
      throw error;
    }
  }

  /**
   * Busca empleados activos por cargo y/o departamento.
   * Útil para asignar tickets o listar agentes disponibles.
   */
  async searchEmployees(
    criteria: SearchEmployeeCriteria = {},
  ): Promise<EmployeeSummary[]> {
    try {
      let query = `
        SELECT idprov, nombre, apellido, unidad, cargo, movil, telefono
        FROM view_nomina_rol
        WHERE estado = 'S'
      `;
      const params: string[] = [];
      let idx = 1;

      if (criteria.jobTitle) {
        query += ` AND UPPER(TRIM(cargo)) LIKE UPPER($${idx++})`;
        params.push(`%${criteria.jobTitle}%`);
      }
      if (criteria.department) {
        query += ` AND UPPER(TRIM(unidad)) LIKE UPPER($${idx++})`;
        params.push(`%${criteria.department}%`);
      }

      query += ` ORDER BY TRIM(apellido), TRIM(nombre)`;

      const result = await this.pool.query<NominaRow>(query, params);
      console.log("📋 Resultado de searchEmployees:", result.rows[0]);
      return result.rows.map((row) => {
        const firstName = this.sanitize(row.nombre) ?? "";
        const lastName = this.sanitize(row.apellido) ?? "";
        return {
          citizenId: this.sanitize(row.idprov)!,
          firstName,
          lastName,
          mobile: this.sanitize(row.movil),
          phone: this.sanitize(row.telefono),
          fullName: `${firstName} ${lastName}`.trim(),
          jobTitle: this.sanitize(row.cargo),
          department: this.sanitize(row.unidad),
          status: "ACTIVE" as const,
        };
      });
    } catch (error) {
      console.error(
        "❌ Error buscando empleados en ERP:",
        (error as Error).message,
      );
      return [];
    }
  }
}
