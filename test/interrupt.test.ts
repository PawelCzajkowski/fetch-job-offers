import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { abortOnInterrupt } from "../src/interrupt.ts";

function setup() {
  const proc = new EventEmitter();
  const exits: number[] = [];
  const messages: string[] = [];
  const signal = abortOnInterrupt({
    process: proc,
    exit: (code) => {
      exits.push(code);
    },
    stderr: (text) => {
      messages.push(text);
    },
  });
  return { proc, exits, messages, signal };
}

describe("abortOnInterrupt", () => {
  it("leaves the signal alone until SIGINT", () => {
    const { signal, exits } = setup();
    expect(signal.aborted).toBe(false);
    expect(exits).toEqual([]);
  });

  it("aborts the signal on the first SIGINT, without exiting", () => {
    const { proc, signal, exits, messages } = setup();
    proc.emit("SIGINT");
    expect(signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    expect(messages.join("")).toContain("Ctrl-C again");
  });

  it("exits 130 at once on the second SIGINT", () => {
    const { proc, exits } = setup();
    proc.emit("SIGINT");
    proc.emit("SIGINT");
    expect(exits).toEqual([130]);
  });
});
