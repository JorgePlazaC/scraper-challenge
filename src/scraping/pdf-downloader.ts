/**
 * Descarga el PDF de una resolución.
 *
 * Es un GET simple al servlet (no requiere ViewState ni AJAX), pero:
 *  - Debe usarse GET (HEAD devuelve HTML, no el PDF).
 *  - El cuerpo se valida por *magic bytes* `%PDF-`: un 200 con HTML suele indicar
 *    sesión caída, y así evitamos guardar archivos corruptos.
 *  - Los 429/5xx/timeouts se gestionan vía RetryPolicy.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../config';
import type { HttpClient } from '../http/http-client';
import type { RetryPolicy } from '../http/retry-policy';

export interface PdfDownloadResult {
  bytes: number;
  serverFilename: string | null;
  sha256: string;
}

export class PdfDownloader {
  constructor(
    private readonly http: HttpClient,
    private readonly retry: RetryPolicy,
    private readonly config: Config,
  ) {}

  /** URL de descarga determinista a partir del uuid. */
  buildUrl(uuid: string): string {
    return `${this.config.baseUrl}/ServletDescarga?uuid=${encodeURIComponent(uuid)}`;
  }

  /** Descarga y guarda el PDF en `filePath`. Lanza si la respuesta no es un PDF. */
  async download(uuid: string, filePath: string): Promise<PdfDownloadResult> {
    const url = this.buildUrl(uuid);
    const response = await this.retry.send(`pdf ${uuid.slice(0, 8)}`, () =>
      this.http.get(url, {
        responseType: 'arraybuffer',
        headers: { Referer: `${this.config.baseUrl}/faces/page/resultado.xhtml` },
      }),
    );
    if (response.status !== 200) throw new Error(`Descarga PDF devolvió ${response.status}`);

    const buffer = Buffer.from(response.data as ArrayBuffer);
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('La respuesta no es un PDF válido (posible sesión caída o documento inexistente)');
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);

    return {
      bytes: buffer.length,
      serverFilename: this.parseFilename(response.headers['content-disposition']),
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  private parseFilename(contentDisposition: unknown): string | null {
    if (typeof contentDisposition !== 'string') return null;
    const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    return match ? decodeURIComponent(match[1] as string) : null;
  }
}
