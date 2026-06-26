/**
 * Ejecuta búsquedas y pagina resultados.
 *
 *  - Búsqueda: POST a inicio.xhtml (patrón POST-Redirect-GET) → GET resultado.xhtml.
 *  - Paginación: POST parcial de RichFaces a resultado.xhtml con el parámetro
 *    `formBuscador:data1:page=N` (permite saltar directamente a cualquier página).
 *
 * El ViewState rota en cada respuesta y se actualiza en la sesión.
 */

import type { Config } from '../config';
import type { Logger } from '../logging/logger';
import type { HttpClient } from '../http/http-client';
import type { RetryPolicy } from '../http/retry-policy';
import type { JsfSession } from '../http/jsf-session';
import type { Facet, RowSummary } from '../types';
import {
  applyOverrides,
  encodeForm,
  extractAllCdata,
  extractViewStateFromHtml,
  extractViewStateFromPartial,
  parseTotalResults,
  serializeForm,
} from './jsf-utils';
import { discoverSearchButton } from './jsf-utils';
import { parseRows } from './result-parser';

export interface SearchResult {
  total: number | null;
  rows: RowSummary[];
}

export class SearchClient {
  constructor(
    private readonly http: HttpClient,
    private readonly retry: RetryPolicy,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly session: JsfSession,
  ) {}

  private get inicioUrl(): string {
    return `${this.config.baseUrl}/faces/page/inicio.xhtml`;
  }
  private get resultadoUrl(): string {
    return `${this.config.baseUrl}/faces/page/resultado.xhtml`;
  }

  /**
   * Ejecuta una búsqueda para una faceta (Corte × Año) y devuelve la 1ª página.
   * Si se pasa `inicioHtml` (el del bootstrap), se reutiliza para evitar un GET extra.
   */
  async search(facet: Facet, inicioHtml?: string): Promise<SearchResult> {
    const html = inicioHtml ?? (await this.fetchFreshInicio());
    const inicioForm = serializeForm(html);

    // El sitio exige filtros: enviamos siempre corte + año (resto en "Todos").
    const fields = applyOverrides(inicioForm, {
      'formBuscador:buCorte': String(facet.corte),
      'formBuscador:buAnio': String(facet.anio),
      'formBuscador:buDistrito': '0',
      'formBuscador:buEspecialidad': '0',
      'formBuscador:buSala': '0',
      'formBuscador:buTipoRecurso': '0',
      'formBuscador:txtBusqueda': '',
      'formBuscador:buNroExpediente': '',
    });

    const body = encodeForm(fields, this.session.searchButtonParams, this.session.viewState);
    const postResponse = await this.retry.send('POST búsqueda', () =>
      this.http.postForm(this.inicioUrl, body, { headers: { Referer: this.inicioUrl } }),
    );
    if (postResponse.status !== 302 && postResponse.status !== 200) {
      throw new Error(`POST de búsqueda devolvió ${postResponse.status}`);
    }

    // POST-Redirect-GET: el resultado queda en sesión; lo recuperamos con un GET.
    const getResponse = await this.retry.send('GET resultado.xhtml', () =>
      this.http.get(this.resultadoUrl, { headers: { Referer: this.inicioUrl } }),
    );
    if (getResponse.status !== 200) {
      throw new Error(`GET resultado.xhtml devolvió ${getResponse.status}`);
    }
    const resultadoHtml = String(getResponse.data);

    const viewState = extractViewStateFromHtml(resultadoHtml);
    if (!viewState) throw new Error('No se encontró ViewState en resultado.xhtml');
    this.session.viewState = viewState;
    this.session.resultadoForm = serializeForm(resultadoHtml);

    const total = parseTotalResults(resultadoHtml);
    const rows = parseRows(resultadoHtml);

    if (rows.length === 0 && /Debe ingresar filtros/i.test(resultadoHtml)) {
      throw new Error('El sitio rechazó la búsqueda: "Debe ingresar filtros de información"');
    }
    return { total, rows };
  }

  /** Navega a la página `pageNum` (>1) vía dataScroller y devuelve sus filas. */
  async goToPage(pageNum: number): Promise<RowSummary[]> {
    const extra: Record<string, string> = {
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': 'formBuscador:data1',
      'javax.faces.partial.execute': 'formBuscador:data1',
      'javax.faces.partial.render': 'formBuscador:panealJur',
      'org.richfaces.ajax.component': 'formBuscador:data1',
      'formBuscador:data1:page': String(pageNum),
    };
    const body = encodeForm(this.session.resultadoForm, extra, this.session.viewState);

    const response = await this.retry.send(`paginar p${pageNum}`, () =>
      this.http.postForm(this.resultadoUrl, body, {
        headers: {
          'Faces-Request': 'partial/ajax',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: this.resultadoUrl,
        },
      }),
    );
    if (response.status !== 200) throw new Error(`Paginación p${pageNum} devolvió ${response.status}`);

    const xml = String(response.data);
    this.session.updateViewState(extractViewStateFromPartial(xml));
    return parseRows(extractAllCdata(xml));
  }

  private async fetchFreshInicio(): Promise<string> {
    const response = await this.retry.send('GET inicio.xhtml', () => this.http.get(this.inicioUrl));
    if (response.status !== 200) throw new Error(`inicio.xhtml devolvió ${response.status}`);
    const html = String(response.data);

    const viewState = extractViewStateFromHtml(html);
    if (!viewState) throw new Error('No se encontró ViewState en inicio.xhtml');
    this.session.viewState = viewState;

    const button = discoverSearchButton(html);
    if (button) this.session.searchButtonParams = button;
    return html;
  }
}
