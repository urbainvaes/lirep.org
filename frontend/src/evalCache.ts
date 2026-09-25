export interface EvaluationCache {
  persistent: boolean;
  get(fen: string): Promise<number | undefined>;
  set(fen: string, cp: number): Promise<void>;
}

export async function openEvaluationCache(username: string): Promise<EvaluationCache> {
  const memory = new Map<string, number>();
  let db: IDBDatabase | null = null;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lirep-position-evals", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("positions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Browsers that block IndexedDB can still calculate during this page visit.
  }

  const database = db;
  return {
    persistent: database !== null,
    async get(fen) {
      if (memory.has(fen)) return memory.get(fen);
      if (!database) return undefined;
      const value = await new Promise<number | undefined>((resolve, reject) => {
        const request = database.transaction("positions", "readonly").objectStore("positions").get([username, fen]);
        request.onsuccess = () => resolve(request.result as number | undefined);
        request.onerror = () => reject(request.error);
      });
      if (value !== undefined) memory.set(fen, value);
      return value;
    },
    async set(fen, cp) {
      if (database) {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("positions", "readwrite");
          transaction.objectStore("positions").put(cp, [username, fen]);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
      memory.set(fen, cp);
    },
  };
}
