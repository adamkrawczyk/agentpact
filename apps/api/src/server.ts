import { app, shutdown } from "./index.js";

const PORT = Number(process.env.API_PORT ?? 4000);
const HOST = process.env.API_HOST ?? "0.0.0.0";

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen({ port: PORT, host: HOST }).catch(async (error) => {
  app.log.error(error);
  await shutdown();
  process.exit(1);
});
