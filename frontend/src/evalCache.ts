import { DEFAULT_SEARCH_DEPTH } from "./engine";

export interface EvaluationCache {
  persistent: boolean;
  get(fen: string, depth: number): Promise<number | undefined>;
  set(fen: string, depth: number, cp: number): Promise<void>;
}

export async function openEvaluationCache(username: string): Promise<EvaluationCache> {
  const memory = new Map<string, number>();
  let db: IDBDatabase | null = null;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lirep-position-evals", 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (!database.objectStoreNames.contains("positions")) database.createObjectStore("positions");
        else if (transaction) {
          const store = transaction.objectStore("positions");
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const key = cursor.primaryKey;
            if (Array.isArray(key) && key.length === 2) {
              const value = cursor.value;
              const next = cursor.continue.bind(cursor);
              cursor.delete();
              store.put(value, [...key, DEFAULT_SEARCH_DEPTH]);
              next();
              return;
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Browsers that block IndexedDB can still calculate during this page visit.
  }

  const database = db;
  return {
    persistent: database !== null,
    async get(fen, depth) {
      const key = `${fen}|${depth}`;
      if (memory.has(key)) return memory.get(key);
      if (!database) return undefined;
      const value = await new Promise<number | undefined>((resolve, reject) => {
        const request = database.transaction("positions", "readonly").objectStore("positions").get([username, fen, depth]);
        request.onsuccess = () => resolve(request.result as number | undefined);
        request.onerror = () => reject(request.error);
      });
      if (value !== undefined) memory.set(key, value);
      return value;
    },
    async set(fen, depth, cp) {
      const key = `${fen}|${depth}`;
      if (database) {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("positions", "readwrite");
          transaction.objectStore("positions").put(cp, [username, fen, depth]);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
      memory.set(key, cp);
    },
  };
}
