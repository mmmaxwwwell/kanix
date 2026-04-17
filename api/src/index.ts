import { loadConfig } from "./config.js";
import { createDatabaseConnection } from "./db/connection.js";
import { createServer, markReady } from "./server.js";

const config = loadConfig();
const database = createDatabaseConnection(config.DATABASE_URL);
const { start } = createServer({ config, database });

await start();

markReady();
