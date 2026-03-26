module.exports = {
  apps: [
    {
      name: "openai-compat-shim",
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 8787,
        TARGET_BASE_URL: process.env.TARGET_BASE_URL || "",
        TARGET_API_KEY: process.env.TARGET_API_KEY || "",
        SHIM_API_KEY: process.env.SHIM_API_KEY || "",
        DEFAULT_MODEL: process.env.DEFAULT_MODEL || "gpt-5.4",
        STRIP_FIELDS: process.env.STRIP_FIELDS || "audio",
        DEBUG_CAPTURE_DIR: process.env.DEBUG_CAPTURE_DIR || ""
      }
    }
  ]
};
