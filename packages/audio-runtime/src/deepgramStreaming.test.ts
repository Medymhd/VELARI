import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepgramStreamingSttEngine, type WebSocketLike } from "./sttStreaming.js";

class FakeSocket implements WebSocketLike {
  sent: (string | Buffer)[] = [];
  closed = false;
  private handlers = new Map<string, ((...args: never[]) => void)[]>();

  on(event: "open" | "message" | "error" | "close", cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = true;
    this.emit("close", code ?? 1000);
  }
  open(): void {
    this.emit("open");
  }
  message(data: string): void {
    this.emit("message", data);
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}

function jsonResult(text: string, isFinal: boolean, confidence = 0.9): string {
  return JSON.stringify({ channel: { alternatives: [{ transcript: text, confidence }] }, is_final: isFinal });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("emits partial then final in message order", () => {
  const sockets: FakeSocket[] = [];
  const engine = new DeepgramStreamingSttEngine("key", {
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  const results: string[] = [];
  const chunk = Buffer.alloc(320 * 2);
  engine.feed(chunk, 0, (r) => results.push(`${r.isFinal ? "final" : "partial"}:${r.text}`));

  sockets[0]!.open();
  sockets[0]!.message(jsonResult("hello there", false));
  sockets[0]!.message(jsonResult("hello there friend", true));
  engine.close();

  assert.deepEqual(results, ["partial:hello there", "final:hello there friend"]);
  const final = results[1]!;
  assert.ok(final.startsWith("final:"));
});

test("buffers chunks while connecting and flushes them on open, Finalize on flush", () => {
  const sockets: FakeSocket[] = [];
  const engine = new DeepgramStreamingSttEngine("key", {
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  const chunk = Buffer.alloc(64, 1);
  engine.feed(chunk, 0, () => {});
  engine.feed(chunk, 20, () => {});
  engine.feed(chunk, 40, () => {});

  sockets[0]!.open();
  const binary = sockets[0]!.sent.filter((d) => Buffer.isBuffer(d));
  assert.equal(binary.length, 3, "buffered chunks flushed on open");

  const finals: unknown[] = [];
  engine.flush((r) => finals.push(r));
  assert.ok(
    sockets[0]!.sent.some((d) => typeof d === "string" && d.includes("Finalize")),
    "flush sends Finalize",
  );
  engine.close();
});

test("reconnect exhausts attempts then fires onUnavailable once", async () => {
  const sockets: FakeSocket[] = [];
  const engine = new DeepgramStreamingSttEngine("key", {
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    reconnectBaseMs: 1,
    reconnectMaxMs: 2,
    maxAttemptsPerRung: 2,
  });
  let unavailable = 0;
  engine.onUnavailable(() => {
    unavailable += 1;
  });

  engine.feed(Buffer.alloc(32), 0, () => {});
  sockets[0]!.close(1006);
  await sleep(20); // attempt 2 dials
  assert.equal(sockets.length, 2, "second attempt after first abnormal close");
  sockets[1]!.close(1006);
  await sleep(20);

  assert.equal(unavailable, 1, "exhaustion fires onUnavailable exactly once");
  assert.equal(sockets.length, 2, "no dialing after exhaustion");
  engine.close();
});

test("clean close (1000) does not reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const engine = new DeepgramStreamingSttEngine("key", {
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    reconnectBaseMs: 1,
  });
  engine.feed(Buffer.alloc(32), 0, () => {});
  sockets[0]!.close(1000);
  await sleep(10);
  assert.equal(sockets.length, 1, "no reconnect after clean close");
  engine.close();
});
