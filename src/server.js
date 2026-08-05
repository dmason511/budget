const app = require("./app");
const { initializeDatabase } = require("./db/database");
const { initializeAuthStore } = require("./db/auth-store");

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  try {
    await initializeDatabase();
    await initializeAuthStore();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize application", error);
    process.exit(1);
  }
}

startServer();
