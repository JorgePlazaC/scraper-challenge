/**
 * Política de reintentos con backoff exponencial.
 *
 * Distingue dos clases de fallo, con presupuestos de reintento independientes:
 *  - 429 (Too Many Requests): rate limiting. Respeta `Retry-After` si viene.
 *  - Transitorio: 5xx, timeouts y errores de red (ECONNRESET/ETIMEDOUT...).
 *
 * Un 4xx distinto de 429 NO se reintenta (es un error determinista del request).
 * Si se agotan los reintentos, lanza `RetryError` para que el llamador registre
 * el documento como fallido y continúe con el siguiente (nunca aborta el lote).
 */

import type { AxiosResponse } from 'axios';
import type { Config } from '../config';
import type { Logger } from '../logging/logger';
import { sleep } from '../utils/async';

export class RetryError extends Error {
  constructor(
    message: string,
    readonly lastStatus: number | null,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

export class RetryPolicy {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Ejecuta `attempt` (una única petición HTTP) con reintentos. `attempt` debe
   * devolver la respuesta incluso para 4xx/5xx (HttpClient usa validateStatus:all)
   * y solo lanzar ante errores de red/timeout.
   */
  async send(label: string, attempt: () => Promise<AxiosResponse>): Promise<AxiosResponse> {
    let retries429 = 0;
    let retriesTransient = 0;
    let lastStatus: number | null = null;

    for (;;) {
      try {
        const response = await attempt();
        lastStatus = response.status;

        if (response.status === 429) {
          if (retries429 >= this.config.maxRetries429) {
            throw new RetryError(`${label}: 429 persistente tras ${retries429} reintentos`, 429);
          }
          const delay = this.retryAfterMs(response) ?? this.backoff(retries429);
          retries429 += 1;
          this.logger.warn(`${label}: 429 (rate limit) — reintento ${retries429}/${this.config.maxRetries429}`, {
            esperaMs: delay,
          });
          await sleep(delay);
          continue;
        }

        if (response.status >= 500) {
          if (retriesTransient >= this.config.maxRetriesTransient) {
            throw new RetryError(`${label}: ${response.status} persistente`, response.status);
          }
          const delay = this.backoff(retriesTransient);
          retriesTransient += 1;
          this.logger.warn(
            `${label}: ${response.status} (transitorio) — reintento ${retriesTransient}/${this.config.maxRetriesTransient}`,
            { esperaMs: delay },
          );
          await sleep(delay);
          continue;
        }

        // 2xx/3xx o 4xx no-429: resultado definitivo, sin reintento.
        return response;
      } catch (error) {
        if (error instanceof RetryError) throw error;

        // Error de red / timeout → transitorio.
        if (retriesTransient >= this.config.maxRetriesTransient) {
          throw new RetryError(`${label}: error de red persistente`, lastStatus, error);
        }
        const delay = this.backoff(retriesTransient);
        retriesTransient += 1;
        this.logger.warn(
          `${label}: error de red — reintento ${retriesTransient}/${this.config.maxRetriesTransient}`,
          { esperaMs: delay, error: (error as Error).message },
        );
        await sleep(delay);
      }
    }
  }

  /** Backoff exponencial acotado, con jitter opcional. */
  private backoff(attempt: number): number {
    const exp = Math.min(this.config.retryBackoffBase * 2 ** attempt, this.config.retryBackoffMaxDelay);
    if (!this.config.retryJitter) return exp;
    // Jitter "full": un valor aleatorio en [exp/2, exp].
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  /** Convierte la cabecera Retry-After (segundos o fecha HTTP) a milisegundos. */
  private retryAfterMs(response: AxiosResponse): number | null {
    const header = response.headers['retry-after'];
    if (!header) return null;

    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);

    const asDate = Date.parse(String(header));
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());

    return null;
  }
}
