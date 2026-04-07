/**
 * Test preload file for cleanup of native resources.
 *
 * Handles LLM disposal on process exit to avoid GGML_ASSERT failures.
 */
import { disposeDefaultLlamaCpp } from "./llm";

// Dispose on process exit to avoid GGML_ASSERT failures
let isDisposing = false;
const doDispose = async () => {
  if (isDisposing) return;
  isDisposing = true;
  try {
    await disposeDefaultLlamaCpp();
  } catch {
    // Ignore disposal errors
  }
};

process.on("beforeExit", doDispose);
process.on("SIGINT", async () => {
  await doDispose();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await doDispose();
  process.exit(0);
});
