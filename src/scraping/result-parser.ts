/**
 * Parsing del HTML del sitio: filas del listado y ficha del modal.
 *
 * - Las filas se reconstruyen desde el `onclick` del botón "Ficha" (que ya
 *   transporta uuid + 9 metadatos), no desde las celdas visibles: es más estable.
 * - La ficha se parsea del HTML del popup (CDATA de la respuesta parcial),
 *   agrupando los pares etiqueta→valor en sus tres secciones.
 */

import * as cheerio from 'cheerio';
import type { Ficha, FichaParams, RowSummary } from '../types';
import { decodeRichFacesAjax } from './jsf-utils';

/** Divide una lista separada por comas en un array limpio. */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Quita el prefijo "Sumilla:" redundante y normaliza espacios. */
function cleanSumilla(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/^\s*Sumilla:\s*/i, '').trim();
  return text.length > 0 ? text : null;
}

/** Construye FichaParams desde el mapa crudo del onclick (con defaults vacíos). */
function toFichaParams(p: Record<string, string>): FichaParams {
  return {
    uuid: p['uuid'] ?? '',
    recurso: p['recurso'] ?? '',
    nroexp: p['nroexp'] ?? '',
    palabras: p['palabras'] ?? '',
    pretensiones: p['pretensiones'] ?? '',
    normaDI: p['normaDI'] ?? '',
    tipoResolucion: p['tipoResolucion'] ?? '',
    fechaResolucion: p['fechaResolucion'] ?? '',
    sala: p['sala'] ?? '',
    sumilla: p['sumilla'] ?? '',
  };
}

/**
 * Extrae las filas de resoluciones de un HTML de resultados (página completa o el
 * CDATA del grid de una respuesta parcial de paginación). Deduplica por botón.
 */
export function parseRows(html: string): RowSummary[] {
  const $ = cheerio.load(html);
  const byButton = new Map<string, RowSummary>();

  $('[onclick*="uuid"]').each((_, el) => {
    const onclick = $(el).attr('onclick');
    if (!onclick) return;
    const decoded = decodeRichFacesAjax(onclick);
    if (!decoded || !decoded.params['uuid']) return;
    if (byButton.has(decoded.sourceId)) return;

    const params = decoded.params;
    const indexMatch = decoded.sourceId.match(/:repeat:(\d+):/);
    const rowIndex = indexMatch ? Number(indexMatch[1]) : byButton.size;

    byButton.set(decoded.sourceId, {
      uuid: params['uuid'] as string,
      nroExpediente: params['nroexp'] ?? '',
      recurso: params['recurso'] ?? '',
      tipoResolucion: params['tipoResolucion'] ?? '',
      fechaResolucion: params['fechaResolucion'] ?? '',
      sala: params['sala'] ?? '',
      pretensiones: splitList(params['pretensiones']),
      palabrasClave: splitList(params['palabras']),
      normaDerechoInterno: params['normaDI'] ? params['normaDI'] : null,
      sumilla: cleanSumilla(params['sumilla']),
      fichaButtonId: decoded.sourceId,
      fichaParams: toFichaParams(params),
      rowIndex,
    });
  });

  return [...byButton.values()].sort((a, b) => a.rowIndex - b.rowIndex);
}

/** Normaliza una etiqueta del modal: sin "***", sin dos puntos finales, sin espacios extra. */
function cleanLabel(text: string): string {
  return text
    .replace(/^[*\s]+/, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parsea el HTML del modal "Ficha" (popupResolucion) en sus tres secciones.
 * Cada sección es un mapa etiqueta→valor con las etiquetas reales del sitio.
 */
export function parseFicha(popupHtml: string): Ficha {
  const $ = cheerio.load(popupHtml);

  const titulo = $('[id$="popupResolucion_header_content"]').text().trim() || null;

  const ficha: Ficha = {
    titulo,
    datosResolucion: {},
    datosProceso: {},
    datosProcedencia: {},
  };

  $('.panel-gris').each((_, panel) => {
    const $panel = $(panel);
    const heading = $panel.find('.panel-heading .txtbold').first().text().toUpperCase();

    const bucket = heading.includes('PROCEDENCIA')
      ? ficha.datosProcedencia
      : heading.includes('PROCESO')
        ? ficha.datosProceso
        : heading.includes('RESOLUCI')
          ? ficha.datosResolucion
          : null;
    if (!bucket) return;

    // Recorremos etiquetas (.txtbold fuera del heading) y valores (span.data) en orden.
    let pendingLabel: string | null = null;
    $panel.find('.txtbold, span.data').each((__, node) => {
      const $node = $(node);
      if ($node.closest('.panel-heading').length > 0) return;
      if ($node.hasClass('txtbold')) {
        pendingLabel = cleanLabel($node.text());
      } else if (pendingLabel) {
        bucket[pendingLabel] = $node.text().trim();
        pendingLabel = null;
      }
    });
  });

  return ficha;
}
