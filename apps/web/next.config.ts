import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// O .env fica na raiz do monorepo. Variáveis já definidas no ambiente têm prioridade.
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const apiUrl = process.env.API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  // O painel fala com a API pelo mesmo domínio: /api/* vai para a API.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
