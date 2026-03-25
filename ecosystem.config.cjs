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
        DEFAULT_MODEL: process.env.DEFAULT_MODEL || "gpt-5.4"
      }
    }
  ]
};
