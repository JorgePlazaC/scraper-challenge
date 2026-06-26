/**
 * Estado de la sesión JSF.
 *
 * Concentra el acoplamiento al framework: el `javax.faces.ViewState` (que rota en
 * cada respuesta), los campos del formulario de resultados (que se reutilizan en
 * cada POST de paginación/ficha) y los parámetros del botón de búsqueda
 * (descubiertos dinámicamente, nunca hardcodeados).
 */

import type { Config } from '../config';
import type { Logger } from '../logging/logger';
import type { HttpClient } from './http-client';
import type { RetryPolicy } from './retry-policy';
import {
  discoverSearchButton,
  extractViewStateFromHtml,
  parseAvailableYears,
  type FormField,
} from '../scraping/jsf-utils';

export class JsfSession {
  /** ViewState vigente. Se actualiza tras cada respuesta (HTML o parcial). */
  viewState = '';
  /** Campos del formulario de la página de resultados (sin ViewState). */
  resultadoForm: FormField[] = [];
  /** Parámetros sintéticos del botón "Buscar" especializado, descubiertos en inicio. */
  searchButtonParams: Record<string, string> = {};
  /** Años disponibles según el selector del sitio (para el modo ALL). */
  availableYears: number[] = [];

  constructor(
    private readonly http: HttpClient,
    private readonly retry: RetryPolicy,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private get inicioUrl(): string {
    return `${this.config.baseUrl}/faces/page/inicio.xhtml`;
  }

  /**
   * Carga inicio.xhtml: establece la cookie de sesión, captura el ViewState,
   * descubre el botón de búsqueda y autodetecta los años disponibles. Devuelve el
   * HTML para que el llamador lo reutilice en el primer POST de búsqueda.
   */
  async bootstrap(): Promise<string> {
    this.logger.info('Bootstrap de sesión: GET inicio.xhtml');
    const response = await this.retry.send('GET inicio.xhtml', () => this.http.get(this.inicioUrl));

    if (response.status !== 200) {
      throw new Error(`inicio.xhtml respondió ${response.status} (¿VPN a Perú activa?)`);
    }
    const html = String(response.data);

    const viewState = extractViewStateFromHtml(html);
    if (!viewState) throw new Error('No se encontró javax.faces.ViewState en inicio.xhtml');
    this.viewState = viewState;

    const button = discoverSearchButton(html);
    if (!button) throw new Error('No se pudo descubrir el botón de búsqueda en inicio.xhtml');
    this.searchButtonParams = button;

    this.availableYears = parseAvailableYears(html);

    this.logger.info('Sesión establecida', {
      sesion: this.http.hasSession(),
      botonBusqueda: Object.keys(button).filter((k) => k.includes('j_idt') || k === 'forward').length,
      anios: this.availableYears.length,
    });
    return html;
  }

  /** Actualiza el ViewState desde una respuesta parcial (text/xml), si viene uno nuevo. */
  updateViewState(value: string | null): void {
    if (value) this.viewState = value;
  }
}
