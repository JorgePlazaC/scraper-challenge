/**
 * Dispara el modal "Ficha" y devuelve la ficha completa.
 *
 * El AJAX hace un lookup server-side por `uuid`, pero EXIGE re-enviar los 10
 * parámetros del onclick de la fila: si falta alguno, la validación JSF falla y
 * el servidor responde sin el popup. Por eso reenviamos `row.fichaParams` íntegro.
 */

import type { Config } from '../config';
import type { HttpClient } from '../http/http-client';
import type { RetryPolicy } from '../http/retry-policy';
import type { JsfSession } from '../http/jsf-session';
import type { Ficha, RowSummary } from '../types';
import { encodeForm, extractAllCdata, extractPartialUpdate, extractViewStateFromPartial } from './jsf-utils';
import { parseFicha } from './result-parser';

export class FichaClient {
  constructor(
    private readonly http: HttpClient,
    private readonly retry: RetryPolicy,
    private readonly config: Config,
    private readonly session: JsfSession,
  ) {}

  private get resultadoUrl(): string {
    return `${this.config.baseUrl}/faces/page/resultado.xhtml`;
  }

  async fetch(row: RowSummary): Promise<Ficha> {
    const p = row.fichaParams;
    const extra: Record<string, string> = {
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': row.fichaButtonId,
      'javax.faces.partial.execute': row.fichaButtonId,
      'org.richfaces.ajax.component': row.fichaButtonId,
      [row.fichaButtonId]: row.fichaButtonId,
      // Los 10 parámetros del onclick — obligatorios para que el modal se renderice.
      uuid: p.uuid,
      recurso: p.recurso,
      nroexp: p.nroexp,
      palabras: p.palabras,
      pretensiones: p.pretensiones,
      normaDI: p.normaDI,
      tipoResolucion: p.tipoResolucion,
      fechaResolucion: p.fechaResolucion,
      sala: p.sala,
      sumilla: p.sumilla,
    };

    const body = encodeForm(this.session.resultadoForm, extra, this.session.viewState);
    const response = await this.retry.send(`ficha ${p.nroexp}`, () =>
      this.http.postForm(this.resultadoUrl, body, {
        headers: {
          'Faces-Request': 'partial/ajax',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: this.resultadoUrl,
        },
      }),
    );
    if (response.status !== 200) throw new Error(`Ficha devolvió ${response.status}`);

    const xml = String(response.data);
    this.session.updateViewState(extractViewStateFromPartial(xml));

    // El popup llega en un <update id="...popupResolucion">; si no, usamos todo el CDATA.
    const popupHtml =
      extractPartialUpdate(xml, 'formBuscador:popupResolucion') ?? extractAllCdata(xml);
    const ficha = parseFicha(popupHtml);

    const isEmpty =
      Object.keys(ficha.datosResolucion).length === 0 &&
      Object.keys(ficha.datosProceso).length === 0 &&
      Object.keys(ficha.datosProcedencia).length === 0;
    if (isEmpty) throw new Error('El modal de ficha llegó vacío (validación JSF rechazada)');

    return ficha;
  }
}
