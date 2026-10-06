/** Device-only storage: never written to Vault, plugin data.json, or LiveSync. */
export interface DeviceStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export class IndexedDeviceStore implements DeviceStore {
  private database?: Promise<IDBDatabase>;
  public constructor(private readonly namespace: string) {}

  private open(): Promise<IDBDatabase> {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(`okf-original-files:${this.namespace}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { this.database = undefined; reject(request.error); };
    });
  }

  private async transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("records", mode);
      const request = action(transaction.objectStore("records"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("本机文件保存中断"));
    });
  }

  public async get<T>(key: string): Promise<T | undefined> {
    return await this.transact("readonly", (store) => store.get(key)) as T | undefined;
  }
  public async put<T>(key: string, value: T): Promise<void> {
    await this.transact("readwrite", (store) => store.put(value, key));
  }
  public async delete(key: string): Promise<void> {
    await this.transact("readwrite", (store) => store.delete(key));
  }
  public async keys(prefix: string): Promise<string[]> {
    const keys = await this.transact("readonly", (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
  }
}
