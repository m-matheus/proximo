import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@proximo/core";
import { afterAll, describe, expect, it } from "vitest";
import { acquireLock, createRedis, incrementCounter, releaseLock } from "../src/index";

loadRootEnv();
const redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

describe("trava por conversa", () => {
  it("só um dono por vez, e só o dono solta", async () => {
    const key = `proximo:test:lock:${randomUUID()}`;
    const first = await acquireLock(redis, key, 5_000);
    expect(first).not.toBeNull();
    expect(await acquireLock(redis, key, 5_000)).toBeNull();

    await releaseLock(redis, key, "token-de-outro");
    expect(await acquireLock(redis, key, 5_000)).toBeNull();

    await releaseLock(redis, key, first ?? "");
    expect(await acquireLock(redis, key, 5_000)).not.toBeNull();
    await redis.del(key);
  });
});

describe("contador com expiração", () => {
  it("soma e define a expiração uma vez", async () => {
    const key = `proximo:test:counter:${randomUUID()}`;
    expect(await incrementCounter(redis, key, 60)).toBe(1);
    expect(await incrementCounter(redis, key, 60)).toBe(2);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await redis.del(key);
  });
});
