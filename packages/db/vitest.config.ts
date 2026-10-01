import { defineConfig } from "vitest/config";

// Testes de integração usam o banco de teste: rodam em série para não disputar tabelas.
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
  },
});
