import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createThreadContextEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Keyed by the usage snapshot's revision, so each new report asks the session again. */
    breakdownQuery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-context:breakdown",
      tag: WS_METHODS.threadContextBreakdown,
      idleTtlMs: 60_000,
    }),
  };
}
