/**
 * Utilidades asíncronas: espera, throttle global y pool de concurrencia.
 */

/** Pausa la ejecución `ms` milisegundos. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Throttle global: garantiza una separación mínima entre el INICIO de operaciones
 * sucesivas. Sirve para no saturar el servidor y reducir la probabilidad de 429.
 *
 * No limita la concurrencia en sí (de eso se encarga `mapWithConcurrency`), sino
 * el ritmo al que se inician las peticiones.
 */
export class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  /** Espera hasta que sea seguro iniciar la siguiente operación. */
  acquire(): Promise<void> {
    // Encadenamos para serializar el cálculo de tiempos entre llamadas concurrentes.
    const result = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.last + this.minIntervalMs - now);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    });
    this.chain = result.catch(() => undefined);
    return result;
  }
}

/**
 * Procesa `items` con un límite de concurrencia, preservando el orden de los
 * resultados. Equivalente mínimo a `p-map`, sin dependencias externas.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
