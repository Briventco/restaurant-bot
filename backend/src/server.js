const { createApp } = require("./app");
const { env } = require("./config/env");
const { runStartupChecks } = require("./config/startupChecks");
const logger = require("./infra/logger");

runStartupChecks({ env, logger });
const app = createApp();

app.listen(env.PORT, () => {
  logger.info("Backend service started", {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
  });
});
