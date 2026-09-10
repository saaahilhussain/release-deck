import { MongoClient, type Db } from 'mongodb';

export interface MongoConnection {
  readonly client: MongoClient;
  readonly db: Db;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface MongoConnectionOptions {
  serverSelectionTimeoutMs?: number;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
}

export async function connectMongo(
  uri: string,
  options: MongoConnectionOptions = {},
): Promise<MongoConnection> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMs ?? 5_000,
    connectTimeoutMS: options.connectTimeoutMs ?? 5_000,
    socketTimeoutMS: options.operationTimeoutMs ?? 5_000,
  });

  try {
    await client.connect();
    const db = client.db();
    const operationTimeoutMs = options.operationTimeoutMs ?? 5_000;
    await db.command({ ping: 1 }, { timeoutMS: operationTimeoutMs });

    let closed = false;
    return {
      client,
      db,
      async ping() {
        await db.command({ ping: 1 }, { timeoutMS: operationTimeoutMs });
      },
      async close() {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
