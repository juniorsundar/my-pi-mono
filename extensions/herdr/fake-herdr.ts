// Test fake for the herdr library: Herdr Terminals as plain records a test advances by hand.
// No hc argv here: that is covered once, in herdr.test.ts.

import type { Herdr, HerdrTerminal, StartPiOptions, TerminalState } from "./herdr.js";

export interface FakeTerminal extends TerminalState {
  address: string;
  start: StartPiOptions;
  /** What screenTail() returns. */
  screen: string;
  /** The next this-many state() calls fail (return undefined), as a flaky hc get would. */
  failStates: number;
  /** What send() returns; a successful send also marks the terminal working. */
  sendResult: { ok: boolean; error?: string };
}

export type FakeCall = [address: string, method: string, ...args: unknown[]];

export function createFakeHerdr() {
  const terminals: FakeTerminal[] = [];
  const calls: FakeCall[] = [];

  const herdr: Herdr = {
    async startPi(start) {
      const t: FakeTerminal = {
        address: `t${terminals.length + 1}`,
        start,
        live: true,
        turn: 0,
        status: "idle",
        screen: "",
        failStates: 0,
        sendResult: { ok: true },
      };
      terminals.push(t);
      calls.push([t.address, "startPi", start]);
      return handle(t);
    },
  };

  function handle(t: FakeTerminal): HerdrTerminal {
    const record = (method: string, ...args: unknown[]) => calls.push([t.address, method, ...args]);
    return {
      address: t.address,
      async state() {
        record("state");
        if (t.failStates > 0) {
          t.failStates--;
          return undefined;
        }
        return { live: t.live, turn: t.turn, status: t.status };
      },
      async wait(timeoutS) {
        record("wait", timeoutS);
      },
      async send(text, options = {}) {
        record("send", text, { ifWorking: options.ifWorking ?? false });
        if (t.sendResult.ok) t.status = "working";
        return t.sendResult;
      },
      async peek() {
        record("peek");
      },
      async interrupt() {
        record("interrupt");
      },
      async screenTail() {
        record("screenTail");
        return t.screen;
      },
      async close() {
        record("close");
        t.live = false;
      },
      async remove() {
        record("remove");
      },
    };
  }

  /** Calls of one method, without the address and method name. */
  const callsOf = (method: string) => calls.filter((c) => c[1] === method).map(([address, , ...args]) => ({ address, args }));

  return { herdr, terminals, calls, callsOf };
}
