/**
 * Construcción de nombres de archivo para los PDFs.
 *
 * El desafío pide un "nombre descriptivo". A la vez necesitamos una clave única y
 * estable. La solución combina ambas: una parte descriptiva legible (recurso +
 * nº de expediente + fecha) y el `uuid` como identificador único garantizado.
 *
 *   Casacion_012722-2021_2023-12-29_26ec07bf-ca63-46dd-802d-d5cddd52ea64.pdf
 *   └─────── descriptivo ───────┘ └──────────────── id única ───────────────┘
 *
 * El uuid al final garantiza unicidad aunque la parte descriptiva se repita (un
 * mismo expediente puede tener varias resoluciones), y mantiene la correlación
 * directa con el objeto JSON.
 */

export interface PdfNameParts {
  recurso: string;
  nroExpediente: string;
  /** Fecha en formato dd/mm/yyyy tal como la entrega el sitio (puede ir vacía). */
  fechaResolucion: string;
  uuid: string;
}

/** Normaliza un texto a un fragmento seguro para nombres de archivo. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos/diacríticos
    .replace(/[^a-zA-Z0-9-]+/g, '_') // todo lo no alfanumérico (salvo '-') → '_'
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Convierte dd/mm/yyyy → yyyy-mm-dd (ordenable). Devuelve '' si no es válida. */
function toIsoDate(fecha: string): string {
  const match = fecha.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Construye el nombre de archivo descriptivo y único del PDF.
 * Siempre termina en `<uuid>.pdf`, antecedido por los campos descriptivos
 * disponibles (los vacíos se omiten).
 */
export function buildPdfFileName(parts: PdfNameParts): string {
  const descriptive = [
    slugify(parts.recurso) || 'Resolucion',
    slugify(parts.nroExpediente),
    toIsoDate(parts.fechaResolucion),
  ]
    .filter((segment) => segment.length > 0)
    .join('_');

  return `${descriptive}_${parts.uuid}.pdf`;
}
