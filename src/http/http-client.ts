/**
 * Cliente HTTP de bajo nivel.
 *
 * Responsabilidades:
 *  - Única puerta de salida HTTP (centraliza User-Agent, timeout y throttling).
 *  - Cookie jar manual: persiste `JSESSIONID` (y cualquier otra cookie) entre
 *    peticiones sin dependencias externas. El sufijo de routing del clúster
 *    (`.jvmr-scjurispN`) se conserva al guardar el valor íntegro.
 *  - No reintenta ni interpreta códigos de estado: de eso se encarga RetryPolicy.
 *    `validateStatus` acepta TODOS los códigos, así que solo lanza ante errores
 *    de red o timeout.
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { Config } from '../config';
import { Throttle } from '../utils/async';

export class HttpClient {
  private readonly axios: AxiosInstance;
  private readonly throttle: Throttle;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly config: Config) {
    this.throttle = new Throttle(config.delayBetweenRequests);
    this.axios = axios.create({
      timeout: config.requestTimeout,
      maxRedirects: 0, // gestionamos redirects manualmente (patrón POST-Redirect-GET)
      validateStatus: () => true,
      // El sitio sirve text/html y text/xml; los PDFs se piden con responseType propio.
      headers: { 'Accept-Language': 'es-PE,es;q=0.9' },
    });
  }

  /** Realiza una petición. Aplica throttle e inyecta cookies y User-Agent. */
  async request(config: AxiosRequestConfig): Promise<AxiosResponse> {
    await this.throttle.acquire();

    const headers = {
      'User-Agent': this.config.userAgent,
      ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
      ...config.headers,
    };

    const response = await this.axios.request({ ...config, headers });
    this.storeCookies(response.headers['set-cookie']);
    return response;
  }

  get(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse> {
    return this.request({ ...config, method: 'GET', url });
  }

  /** POST de formulario (application/x-www-form-urlencoded). */
  postForm(url: string, body: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse> {
    return this.request({
      ...config,
      method: 'POST',
      url,
      data: body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...config.headers },
    });
  }

  /** ¿Hay sesión establecida (cookie JSESSIONID presente)? */
  hasSession(): boolean {
    return this.cookies.has('JSESSIONID');
  }

  /** Olvida todas las cookies (para forzar un re-bootstrap de sesión). */
  clearCookies(): void {
    this.cookies.clear();
  }

  // ─────────────────────────── Cookies ───────────────────────────

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(setCookie: string[] | undefined): void {
    if (!setCookie) return;
    for (const raw of setCookie) {
      const firstPair = raw.split(';', 1)[0] ?? '';
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }
}
