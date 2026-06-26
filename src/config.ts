/**
 * Configuración central del scraper.
 *
 * TODO el comportamiento se controla desde aquí: no hay entrada por consola ni
 * interfaces interactivas, y no hace falta tocar el código para cambiar el alcance.
 * No se usan valores mágicos dispersos por el proyecto: cada constante vive aquí,
 * tipada y documentada.
 */

import type { CorteId, ExecutionMode, LogLevel } from './types';

export interface ReferenceFacet {
  corte: CorteId;
  anio: number;
}

export interface Config {
  // ─────────────────────────── Alcance del recorrido ───────────────────────────
  /**
   * - FIRST_PAGE:    solo la 1ª página de la faceta de referencia (desarrollo rápido).
   * - FIRST_5_PAGES: las primeras 5 páginas de la faceta de referencia.
   * - ALL:           recorre todo el sitio enumerando facetas Corte × Año.
   */
  executionMode: ExecutionMode;
  /** Faceta usada en los modos de desarrollo (FIRST_PAGE / FIRST_5_PAGES). */
  referenceFacet: ReferenceFacet;
  /** Años a recorrer en modo ALL (descendente). Si se deja vacío, se autodetectan. */
  allYears: number[];
  /** Cortes a recorrer en modo ALL. */
  allCortes: CorteId[];

  // ─────────────────────────── Throttling / red ───────────────────────────
  /** Pausa mínima entre el inicio de peticiones (ms), para no saturar el servidor. */
  delayBetweenRequests: number;
  /** Timeout por petición (ms). Aborta requests colgados (red/VPN). */
  requestTimeout: number;
  /** User-Agent realista, coherente con un cliente legítimo. */
  userAgent: string;

  // ─────────────────────────── Reintentos / 429 ───────────────────────────
  /** Nº máx. de reintentos ante 429 (Too Many Requests) antes de rendirse. */
  maxRetries429: number;
  /** Nº máx. de reintentos ante errores transitorios (5xx, timeouts, red). */
  maxRetriesTransient: number;
  /** Base del backoff exponencial (ms): espera ≈ base * 2^intento. */
  retryBackoffBase: number;
  /** Techo del backoff (ms): la espera nunca supera este valor. */
  retryBackoffMaxDelay: number;
  /** Si true, añade jitter aleatorio al backoff (evita "thundering herd"). */
  retryJitter: boolean;

  // ─────────────────────────── Extracción ───────────────────────────
  /**
   * Si true, dispara el modal "Ficha" por documento. Es la FUENTE PRINCIPAL de
   * datos (la fila es solo un resumen). Poner false solo en corridas de desarrollo
   * que se conformen con el resumen del listado.
   */
  fetchFichaModal: boolean;

  // ─────────────────────────── Descarga de PDFs ───────────────────────────
  /** Si true, descarga los PDFs. Si false, solo extrae datos. */
  downloadPdfs: boolean;
  /** Nº de descargas de PDF concurrentes (bajo, por el riesgo de 429). */
  concurrentPdfDownloads: number;

  // ─────────────────────────── Persistencia ───────────────────────────
  /** Carpeta raíz de salida (data, pdfs, state, logs). */
  outputDirectory: string;
  /** Si true, reintenta la cola de fallidos (failed.ndjson) al iniciar. */
  resumeFailedDownloads: boolean;

  // ─────────────────────────── Logging ───────────────────────────
  /** Nivel de detalle del logger. */
  logLevel: LogLevel;

  // ─────────────────────────── Constantes del sitio ───────────────────────────
  /** Base de la aplicación. Punto único de entorno. */
  baseUrl: string;
}

/**
 * Configuración efectiva del proyecto.
 *
 * Ajusta `executionMode` para cambiar el alcance:
 *   'FIRST_PAGE'    → prueba mínima (10 documentos).
 *   'FIRST_5_PAGES' → prueba media (≈50 documentos).
 *   'ALL'           → recorrido completo del sitio.
 */
export const config: Config = {
  // Alcance — por defecto, modo de desarrollo seguro.
  executionMode: 'FIRST_PAGE',
  referenceFacet: { corte: 1, anio: 2024 }, // Corte Suprema, 2024
  allYears: [], // vacío => se autodetectan desde el formulario del sitio
  allCortes: [1, 2], // Suprema y Superior

  // Throttling / red
  delayBetweenRequests: 1500,
  requestTimeout: 30_000,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',

  // Reintentos / 429
  maxRetries429: 5,
  maxRetriesTransient: 4,
  retryBackoffBase: 1000,
  retryBackoffMaxDelay: 60_000,
  retryJitter: true,

  // Extracción
  fetchFichaModal: true,

  // Descarga de PDFs
  downloadPdfs: true,
  concurrentPdfDownloads: 2,

  // Persistencia
  outputDirectory: './output',
  resumeFailedDownloads: true,

  // Logging
  logLevel: 'info',

  // Sitio
  baseUrl: 'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb',
};

/** Tamaño de página fijo del datatable del sitio (10 resultados por página). */
export const PAGE_SIZE = 10;
