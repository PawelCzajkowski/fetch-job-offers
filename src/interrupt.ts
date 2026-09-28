/** The exit code of a run stopped by Ctrl-C (128 + SIGINT). */
export const INTERRUPTED_EXIT_CODE = 130;

export interface InterruptDeps {
  /** Where SIGINT is emitted: `process` in production. */
  process: { on(event: "SIGINT", listener: () => void): unknown };
  exit: (code: number) => void;
  stderr: (text: string) => void;
}

/**
 * Handles Ctrl-C (spec section 11). The first SIGINT aborts the returned
 * signal, so the run stops, saves the store, writes the report and exits
 * 130 on its own. A second SIGINT exits 130 at once.
 */
export function abortOnInterrupt(deps: InterruptDeps): AbortSignal {
  const controller = new AbortController();
  deps.process.on("SIGINT", () => {
    if (controller.signal.aborted) {
      deps.exit(INTERRUPTED_EXIT_CODE);
      return;
    }
    deps.stderr(
      "\nStopping: saving the store and writing the report. Press Ctrl-C again to quit now.\n",
    );
    controller.abort();
  });
  return controller.signal;
}
