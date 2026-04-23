/**
 * expo-sqlite stub for node-side jest. The real module is ESM-only which
 * blows up babel-jest's default transform, AND it relies on a native
 * driver that doesn't exist on node. Tests that need DB behaviour should
 * go through a higher-level integration suite; this mock is purely for
 * import-time survival.
 */
type Row = Record<string, any>;
const _rows: Row[] = [];

class FakeDatabase {
    async runAsync(_sql: string, ..._args: any[]) { return { lastInsertRowId: 0, changes: 0 }; }
    async getFirstAsync<T = any>(_sql: string, ..._args: any[]): Promise<T | null> { return null; }
    async getAllAsync<T = any>(_sql: string, ..._args: any[]): Promise<T[]> { return _rows as any; }
    async execAsync(_sql: string): Promise<void> {}
    async closeAsync(): Promise<void> {}
    async withExclusiveTransactionAsync(fn: (tx: FakeDatabase) => Promise<void>): Promise<void> {
        await fn(this);
    }
}

export async function openDatabaseAsync(_name: string): Promise<FakeDatabase> {
    return new FakeDatabase();
}

export function openDatabaseSync(_name: string): FakeDatabase {
    return new FakeDatabase();
}

export const SQLiteDatabase = FakeDatabase;
export default { openDatabaseAsync, openDatabaseSync, SQLiteDatabase };
