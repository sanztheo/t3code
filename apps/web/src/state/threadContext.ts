import { createThreadContextEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-context";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadContextEnvironment = createThreadContextEnvironmentAtoms(connectionAtomRuntime);
