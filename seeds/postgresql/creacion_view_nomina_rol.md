## Crear vista requerida

Después de restaurar el seed PostgreSQL, ejecutar:

```sql
CREATE OR REPLACE VIEW public.view_nomina_rol AS
 SELECT a.idprov,
    a.razon,
    a.direccion,
    a.telefono,
    a.correo,
    a.movil,
    a.idciudad,
    a.nombre,
    a.apellido,
    b.id_departamento,
    b.id_cargo,
    b.responsable,
    b.regimen,
    b.fecha,
    b.contrato,
    b.sueldo,
    c.nombre AS unidad,
    d.nombre AS cargo,
    a.grafico,
    e.fechan,
    e.nacionalidad,
    e.etnia,
    e.ecivil,
    e.vivecon,
    e.tsangre,
    e.cargas,
    a.estado,
    a.cta_banco,
    a.id_banco,
    a.tipo_cta,
    a.sifondo,
    a.vivienda,
    a.salud,
    a.educacion,
    a.alimentacion,
    a.vestimenta,
    a.registro,
    e.recorrido,
    e.tiempo,
    e.estudios,
    e.emaile,
    e.titulo,
    e.carrera,
    a.programa,
    a.titulo AS sigla,
    now() - b.fecha::timestamp with time zone AS tiempo_ingreso,
    now()::date - b.fecha AS dias_trascurrido,
    (now()::date - b.fecha) / 365 AS anio_trascurrido,
    d.jerarquico,
    c.ambito,
    b.genero,
    b.foto,
    a.fondo,
    b.sidecimo,
    b.sicuarto,
    b.sihoras,
    b.sisubrogacion,
    b.fecha_salida,
    b.motivo,
    COALESCE(date_part('year'::text, b.fecha_salida), '-1'::integer::double precision) AS anio_salida,
    c.nivel,
    (now()::date - e.fechan) / 365 AS edad,
    date_part('year'::text, e.fechan) AS anio_nacio,
    date_part('month'::text, e.fechan) AS mes_nacio,
    h.nombre AS ciudad,
    b.discapacidad,
    a.turismo,
    d.tipo,
    COALESCE(date_part('year'::text, b.fecha_salida), 0::double precision) AS asale,
    COALESCE(date_part('month'::text, b.fecha_salida), - 1::double precision) AS msale,
    a.autorizacion,
    a.categoria_lic,
    a.tipo_lic,
    a.valido_lic,
    a.de_edad,
    a.de_enfer,
    a.de_carga,
    a.de_disca,
    a.contacto,
    a.ctelefono,
    a.ccorreo,
    e.parentesco_contacto,
    a.proyecto,
    a.actividadp,
    b.tipo_contrato,
    b.cargoe,
    b.unidade,
    b.idprov_bene,
    b.jubilado_bene
   FROM par_ciu a
     JOIN par_ciu x ON a.modulo = 'N'::bpchar AND a.idprov = x.idprov
     JOIN nom_personal b ON a.idprov = b.idprov
     LEFT JOIN nom_departamento c ON b.id_departamento = c.id_departamento
     LEFT JOIN nom_cargo d ON d.id_cargo = b.id_cargo
     LEFT JOIN nom_adicional e ON e.idprov = a.idprov
     LEFT JOIN par_catalogo h ON h.idcatalogo = a.idciudad;
...
```

Esta vista es requerida por el servicio ERP para consultar funcionarios activos:

```ts
SELECT idprov, nombre, apellido, correo, emaile,
       movil, telefono, unidad, cargo, estado, ccorreo,
       direccion, fecha, regimen, tipo_contrato
FROM view_nomina_rol
WHERE TRIM(idprov) = $1
  AND estado = 'S'
```
