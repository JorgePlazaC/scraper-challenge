/**
 * Genera el espacio de búsqueda (facetas) según el modo de ejecución.
 *
 * El sitio EXIGE filtros y una sola combinación puede superar 15 000 resultados,
 * por lo que "recorrer todo" se materializa enumerando facetas Corte × Año.
 */

import type { Config } from '../config';
import type { CorteId, ExecutionMode, Facet } from '../types';

const CORTE_NOMBRE: Record<CorteId, 'Suprema' | 'Superior'> = {
  1: 'Suprema',
  2: 'Superior',
};

export function makeFacet(corte: CorteId, anio: number): Facet {
  return { corte, corteNombre: CORTE_NOMBRE[corte], anio };
}

/** Páginas máximas a procesar por faceta según el modo. */
export function maxPagesForMode(mode: ExecutionMode): number {
  switch (mode) {
    case 'FIRST_PAGE':
      return 1;
    case 'FIRST_5_PAGES':
      return 5;
    case 'ALL':
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Construye la lista de facetas a recorrer.
 * - Modos de desarrollo: una única faceta de referencia.
 * - Modo ALL: cortes × años (años de config o autodetectados del sitio).
 */
export function buildSearchSpace(config: Config, detectedYears: number[]): Facet[] {
  if (config.executionMode !== 'ALL') {
    return [makeFacet(config.referenceFacet.corte, config.referenceFacet.anio)];
  }

  const years = config.allYears.length > 0 ? config.allYears : detectedYears;
  const facets: Facet[] = [];
  for (const corte of config.allCortes) {
    for (const anio of years) {
      facets.push(makeFacet(corte, anio));
    }
  }
  return facets;
}
