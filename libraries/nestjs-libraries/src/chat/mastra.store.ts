import { PostgresStore, PgVector } from '@mastra/pg';

let _pStore: PostgresStore | null = null;
let _pStoreInitPromise: Promise<PostgresStore> | null = null;

async function createStoreWithRetry(maxRetries = 3, delayMs = 2000): Promise<PostgresStore> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const store = new PostgresStore({
        connectionString: process.env.DATABASE_URL,
      });
      // Force init to validate the connection early
      if (typeof (store as any).init === 'function') {
        await (store as any).init();
      }
      return store;
    } catch (err: any) {
      console.warn(
        `[MastraStore] PostgresStore init attempt ${attempt}/${maxRetries} failed: ${err.message}`
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        console.error(
          `[MastraStore] All ${maxRetries} attempts failed. Creating store without pre-init.`
        );
        // Return a store instance anyway — it may reconnect lazily
        return new PostgresStore({
          connectionString: process.env.DATABASE_URL,
        });
      }
    }
  }
  // Fallback (should not reach here)
  return new PostgresStore({
    connectionString: process.env.DATABASE_URL,
  });
}

export function getPStore(): Promise<PostgresStore> {
  if (_pStore) return Promise.resolve(_pStore);
  if (!_pStoreInitPromise) {
    _pStoreInitPromise = createStoreWithRetry().then((store) => {
      _pStore = store;
      return store;
    });
  }
  return _pStoreInitPromise;
}

// Keep backward-compatible synchronous export for existing imports.
// This creates the store eagerly but does NOT call init(), avoiding the crash.
export const pStore = new PostgresStore({
  connectionString: process.env.DATABASE_URL,
});
