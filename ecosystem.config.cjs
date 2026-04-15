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
        DEBUG_CAPTURE_DIR: process.env.DEBUG_CAPTURE_DIR || "",
        ENABLE_STREAM_TOOL_TRANSFORM: process.env.ENABLE_STREAM_TOOL_TRANSFORM || "0",
        UPSTREAM_REQUEST_TIMEOUT_MS: process.env.UPSTREAM_REQUEST_TIMEOUT_MS || "300000",
        NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY || "1",
        HTTP_PROXY: process.env.HTTP_PROXY || "",
        HTTPS_PROXY: process.env.HTTPS_PROXY || "",
        NO_PROXY: process.env.NO_PROXY || "127.0.0.1,localhost"
      }
    }
  ]
};
