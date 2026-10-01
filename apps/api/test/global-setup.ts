import { migrateTestDatabase } from "@proximo/db/testing";

export default function setup(): void {
  migrateTestDatabase();
}
