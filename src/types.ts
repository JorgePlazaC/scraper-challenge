/**
 * Tipos del dominio del scraper.
 *
 * Todos los nombres de campo provienen de la estructura HTTP/HTML real del sitio
 * (ver SPEC.md). Los datos del listado son un *resumen*; la ficha (modal) es la
 * fuente completa de información de cada resolución.
 */

/** Modo de ejecución. Controla cuántas páginas se recorren (sin tocar código). */
export type ExecutionMode = 'FIRST_PAGE' | 'FIRST_5_PAGES' | 'ALL';

/** Nivel de verbosidad del logger, de mayor a menor detalle. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Corte del Poder Judicial. El sitio la codifica como 1 (Suprema) o 2 (Superior). */
export type CorteId = 1 | 2;

/**
 * Una faceta del espacio de búsqueda. El sitio EXIGE filtros, por lo que el
 * recorrido completo se materializa enumerando combinaciones Corte × Año.
 */
export interface Facet {
  corte: CorteId;
  corteNombre: 'Suprema' | 'Superior';
  anio: number;
}

/**
 * Los 10 parámetros que el `onclick` del botón "Ficha" de cada fila transporta.
 * Deben re-enviarse ÍNTEGROS al disparar el modal: si falta alguno, la validación
 * JSF falla y el servidor no devuelve la ficha.
 */
export interface FichaParams {
  uuid: string;
  recurso: string;
  nroexp: string;
  palabras: string;
  pretensiones: string;
  normaDI: string;
  tipoResolucion: string;
  fechaResolucion: string;
  sala: string;
  sumilla: string;
}

/** Datos de una fila del listado de resultados (resumen + claves para enriquecer). */
export interface RowSummary {
  /** Identificador estable de la resolución (clave canónica JSON↔PDF). */
  uuid: string;
  nroExpediente: string;
  recurso: string;
  tipoResolucion: string;
  /** Fecha en formato original dd/mm/yyyy tal como la entrega el sitio. */
  fechaResolucion: string;
  sala: string;
  pretensiones: string[];
  palabrasClave: string[];
  normaDerechoInterno: string | null;
  sumilla: string | null;
  /** clientId del botón Ficha (formBuscador:repeat:N:j_idtXXX), autogenerado. */
  fichaButtonId: string;
  /** Parámetros crudos del onclick, necesarios para disparar el modal. */
  fichaParams: FichaParams;
  /** Índice de fila dentro de la página (0..9). */
  rowIndex: number;
}

/**
 * Ficha completa extraída del modal. Cada sección es un mapa etiqueta→valor con
 * las etiquetas reales del sitio (limpias, sin los dos puntos finales).
 *
 * Se modela como mapa flexible (en lugar de campos fijos) para ser tolerante a
 * que distintos tipos de resolución expongan distintos campos.
 */
export interface Ficha {
  titulo: string | null;
  datosResolucion: Record<string, string>;
  datosProceso: Record<string, string>;
  datosProcedencia: Record<string, string>;
}

/** Estado del archivo PDF asociado a la resolución. */
export type PdfStatus = 'pending' | 'downloaded' | 'failed' | 'skipped';

export interface PdfInfo {
  downloadUrl: string;
  /** Nombre que sugiere el servidor en Content-Disposition (legibilidad humana). */
  serverFilename: string | null;
  /** Ruta local relativa donde se guardó el PDF. */
  localPath: string | null;
  status: PdfStatus;
  bytes: number | null;
  sha256: string | null;
  attempts: number;
  error: string | null;
}

/** Metadatos de trazabilidad y reanudación. */
export interface DocumentMeta {
  facet: { corte: CorteId; anio: number };
  page: number;
  rowIndex: number;
  scrapedAt: string;
}

/**
 * Documento JSON final: un único objeto enriquecido por resolución que fusiona
 * el resumen del listado, la ficha del modal y los metadatos del PDF.
 */
export interface DocumentRecord {
  uuid: string;
  nroExpediente: string;
  recurso: string;
  tipoResolucion: string;
  fechaResolucion: string;
  sala: string;
  corte: 'Suprema' | 'Superior';
  anio: number;
  pretensiones: string[];
  palabrasClave: string[];
  normaDerechoInterno: string | null;
  sumilla: string | null;
  /** Ficha completa del modal (null si FetchFichaModal está desactivado o falló). */
  ficha: Ficha | null;
  pdf: PdfInfo;
  _meta: DocumentMeta;
}

/** Entrada de la cola de fallidos, para reintentar después. */
export interface FailedEntry {
  uuid: string;
  nroExpediente: string | null;
  stage: 'ficha' | 'pdf' | 'page' | 'search';
  reason: string;
  facet: { corte: CorteId; anio: number };
  page: number;
  pdfUrl: string | null;
  failedAt: string;
}
