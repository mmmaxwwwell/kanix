import { loadConfig } from "./config.js";
import { createServer, markReady } from "./server.js";

const config = loadConfig();
const { start } = createServer({ config });

await start();

// Mark ready once the server is listening
// In the future, this will wait for DB connection etc.
markReady();
