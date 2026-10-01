import { migrateTestDatabase } from "../src/testing";

export default function setup(): void {
  migrateTestDatabase();
}
