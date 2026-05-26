/**
 * incident.service.ts
 * Servicio de dominio para gestionar incidentes.
 * Se conecta a las mismas colecciones MongoDB del sistema principal (sin duplicar datos).
 * Métodos equivalentes a IncidentService.js del módulo original.
 */

import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import {
  INCIDENT_MODEL,
  ESTADO_INCIDENTE_MODEL,
  IncidentDocument,
  EstadoIncidenteDocument,
  CATEGORIA_MODEL,
  SUBCATEGORIA_MODEL,
  SubcategoriaDocument,
  CategoriaDocument,
} from "./incident.schema";

@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  constructor(
    @InjectModel(INCIDENT_MODEL)
    private readonly incidentModel: Model<IncidentDocument>,
    @InjectModel(ESTADO_INCIDENTE_MODEL)
    private readonly estadoModel: Model<EstadoIncidenteDocument>,
    @InjectModel(CATEGORIA_MODEL)
    private readonly categoriaModel: Model<CategoriaDocument>,
    @InjectModel(SUBCATEGORIA_MODEL)
    private readonly subcategoriaModel: Model<SubcategoriaDocument>,
  ) {}

  // ─── Consultas de Incidentes ──────────────────────────────────────────────────

  async search(
    criteria: any,
    options: { page?: number; limit?: number; sort?: Record<string, any> } = {},
  ): Promise<any> {
    const { page = 1, limit = 10, sort = { createdAt: -1 } } = options;
    const skip = (page - 1) * limit;
    const query: Record<string, unknown> = {};

    if (criteria.ciudadano) {
      query.ciudadano = criteria.ciudadano;
    }

    if (criteria.categoria) {
      query.categoria = criteria.categoria;
    }

    if (criteria.subcategoria) {
      query.subcategoria = criteria.subcategoria;
    }

    if (criteria.estado) {
      query.estado = criteria.estado;
    }

    if (criteria.descripcion) {
      query.descripcion = { $regex: criteria.descripcion, $options: "i" };
    }

    if (criteria.location) {
      query.direccion_geo = {
        nombre: { $regex: criteria.location, $options: "i" },
      };
    }

    if (criteria.priority) {
      query.priority = criteria.priority;
    }

    const [data, total] = await Promise.all([
      this.incidentModel.find(query).sort(sort).skip(skip).limit(limit).exec(),
      this.incidentModel.countDocuments(query).exec(),
    ]);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /** Obtiene un incidente por su ID */
  async getById(id: string): Promise<IncidentDocument> {
    const incident = await this.incidentModel.findById(id);
    if (!incident) throw new NotFoundException("Incidente no encontrado");
    return incident;
  }

  /** Obtiene un incidente con sus referencias populadas */
  async getByIdAndPopulate(id: string): Promise<IncidentDocument> {
    const incident = await this.incidentModel
      .findById(id)
      .populate("categoria")
      .populate("subcategoria")
      .populate("ciudadano")
      .populate("estado");
    if (!incident) throw new NotFoundException("Incidente no encontrado");
    return incident;
  }

  /**
   * Obtiene incidentes de un usuario específico con filtros opcionales.
   * @param userId  - ID del ciudadano dueño de los incidentes
   * @param filters - Filtros adicionales (ej. { estado: estadoId })
   * @param options - Paginación y ordenamiento
   */
  async getByUserId(
    userId: string,
    filters: Record<string, any> = {},
    options: { limit?: number; skip?: number; sort?: Record<string, any> } = {},
  ): Promise<any> {
    const { limit = 10, skip = 0, sort = { createdAt: -1 } } = options;
    return this.incidentModel
      .find({ ciudadano: userId, ...filters })
      .populate("categoria")
      .populate("subcategoria")
      .populate("estado")
      .sort(sort)
      .skip(skip)
      .limit(limit);
  }

  /** Obtiene todos los estados de incidente disponibles */
  async getEstadosAll(): Promise<EstadoIncidenteDocument[]> {
    return this.estadoModel.find().sort({ nombre: 1 });
  }

  /** Obtiene un estado por nombre (case-insensitive) */
  async getEstadoByName(
    nombre: string,
  ): Promise<EstadoIncidenteDocument | null> {
    return this.estadoModel.findOne({
      nombre: { $regex: new RegExp(`^${nombre}$`, "i") },
    });
  }

  async getEstadoById(id: string): Promise<EstadoIncidenteDocument | null> {
    return this.estadoModel.findById(id);
  }

  // ─── Consultas de Categorías y Subcategorías ─────────────────────────────────

  /**
   * Obtiene todas las categorías, excluyendo las que tienen nombre "CIOCE" y "EMERGENCIAS"
   * @returns Lista de categorías
   */
  async getAllCategories(): Promise<CategoriaDocument[]> {
    try {
      const categories = await this.categoriaModel.find({
        nombre: { $nin: ["CIOCE", "EMERGENCIAS"] },
      });
      return categories;
    } catch (error) {
      this.logger.error("Error al obtener categorías:", error);
      throw error;
    }
  }

  /**
   * Obtiene una categoría por su nombre
   * @param name - Nombre de la categoría
   */
  async getCategoryName(name: string): Promise<CategoriaDocument | null> {
    try {
      const category = await this.categoriaModel.findOne({ nombre: name });
      return category;
    } catch (error) {
      this.logger.error("Error al obtener categoría por nombre:", error);
      throw error;
    }
  }

  /**
   * Obtiene una categoría por su ID
   * @param categoryId - ID de la categoría
   */
  async getCategoryById(categoryId: string): Promise<CategoriaDocument> {
    try {
      const category = await this.categoriaModel.findById(categoryId);
      if (!category) {
        throw new NotFoundException("Categoría no encontrada");
      }
      return category;
    } catch (error) {
      this.logger.error("Error al obtener categoría por ID:", error);
      throw error;
    }
  }

  /**
   * Obtiene una subcategoría por nombre (case-insensitive)
   * @param name - Nombre de la subcategoría
   */
  async getSubcategoryName(name: string): Promise<SubcategoriaDocument | null> {
    try {
      const subcategory = await this.subcategoriaModel
        .findOne({
          nombre: { $regex: name, $options: "i" },
        })
        .populate("categoria");
      return subcategory;
    } catch (error) {
      this.logger.error("Error al obtener subcategoría:", error);
      throw error;
    }
  }

  /**
   * Obtiene una subcategoría por ID
   * @param subcategoryId - ID de la subcategoría
   */
  async getSubCategoryById(
    subcategoryId: string,
  ): Promise<SubcategoriaDocument> {
    try {
      const subcategory = await this.subcategoriaModel.findById(subcategoryId);
      if (!subcategory) {
        throw new NotFoundException("Subcategoría no encontrada");
      }
      return subcategory;
    } catch (error) {
      this.logger.error("Error al obtener subcategoría por ID:", error);
      throw error;
    }
  }

  /**
   * Obtiene subcategorías por categoría
   * @param categoryId - ID de la categoría
   */
  async getSubcategoriesByCategory(
    categoryId: string,
  ): Promise<SubcategoriaDocument[]> {
    try {
      const subcategories = await this.subcategoriaModel.find({
        categoria: categoryId,
      });
      return subcategories;
    } catch (error) {
      this.logger.error("Error al obtener subcategorías por categoría:", error);
      throw error;
    }
  }

  /**
   * Obtiene todas las categorías con sus subcategorías
   * @returns Lista de subcategorías con información de categoría
   */
  async getCategoriesWithSubcategories(): Promise<any[]> {
    try {
      const subcategories = await this.subcategoriaModel
        .find()
        .populate("categoria")
        .lean()
        .then((docs) =>
          docs
            .filter(
              (doc: any) =>
                doc.categoria &&
                doc.categoria.nombre !== "CIOCE" &&
                doc.categoria.nombre !== "EMERGENCIAS",
            )
            .map((doc: any) => ({
              _id: doc._id,
              nombre: doc.nombre,
              descripcion: doc.descripcion,
              categoria: doc.categoria
                ? {
                    _id: doc.categoria._id,
                    nombre: doc.categoria.nombre,
                    descripcion: doc.categoria.descripcion,
                  }
                : null,
            })),
        );
      return subcategories;
    } catch (error) {
      this.logger.error(
        "Error al obtener categorías con subcategorías:",
        error,
      );
      throw error;
    }
  }

  // ─── Creación ─────────────────────────────────────────────────────────────────

  /** Crea un nuevo incidente */
  async create(incidentData: Record<string, any>): Promise<IncidentDocument> {
    try {
      const incident = await this.incidentModel.create(incidentData);
      this.logger.log(`Incidente creado: ${incident._id}`);
      return incident;
    } catch (error) {
      this.logger.error("Error al crear incidente:", error);
      throw error;
    }
  }

  /**
   * Crea un incidente a partir de los datos temporales de una conversación.
   * Equivalente a IncidentService.createFromTempData() del módulo original.
   */
  async createFromTempData(
    tempIncidentData: Record<string, any>,
    userId: string | undefined,
  ): Promise<IncidentDocument> {
    if (!tempIncidentData || !userId) {
      throw new Error("Datos incompletos para crear incidente");
    }
    return this.create({ ...tempIncidentData, ciudadano: userId });
  }

  // ─── Actualizaciones ──────────────────────────────────────────────────────────

  /** Actualiza campos arbitrarios de un incidente */
  async update(
    id: string,
    updateData: Record<string, any>,
  ): Promise<IncidentDocument> {
    const incident = await this.incidentModel.findByIdAndUpdate(
      id,
      updateData,
      { new: true },
    );
    if (!incident) throw new NotFoundException("Incidente no encontrado");
    return incident;
  }

  /** Añade fotos al array de evidencia de un incidente */
  async addPhotos(
    id: string,
    photoUrls: string | string[],
  ): Promise<IncidentDocument> {
    const urls = Array.isArray(photoUrls) ? photoUrls : [photoUrls];
    const incident = await this.incidentModel.findByIdAndUpdate(
      id,
      { $push: { foto: { $each: urls } } },
      { new: true },
    );
    if (!incident) throw new NotFoundException("Incidente no encontrado");
    return incident;
  }

  /**
   * Cambia el estado de un incidente.
   * @param id         - ID del incidente
   * @param estadoId   - ID del nuevo estado
   * @param statusNote - Nota opcional sobre el cambio
   */
  async updateStatus(
    id: string,
    estadoId: string,
    statusNote = "",
  ): Promise<IncidentDocument> {
    const updateData: Record<string, any> = { estado: estadoId };
    if (statusNote) updateData.nota_estado = statusNote;
    return this.update(id, updateData);
  }

  validateIncidentData(incidentData: any): { isValid: boolean; errors: any } {
    const errors: any = {};

    // Validar categoría
    if (!incidentData.category_id) {
      errors.category_id = "La categoría es requerida";
    }

    // Validar subcategoría
    if (!incidentData.subcategory_id) {
      errors.subcategory_id = "La subcategoría es requerida";
    }

    // Validar descripción
    if (!incidentData.description || incidentData.description.trim() === "") {
      errors.description = "La descripción es requerida";
    }

    // Validar ubicación
    if (
      !incidentData.location ||
      !incidentData.location.latitude ||
      !incidentData.location.longitude
    ) {
      errors.location = "La ubicación es requerida";
    }

    return {
      isValid: Object.keys(errors).length === 0,
      errors,
    };
  }
}
