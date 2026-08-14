// npm test depends on both --import ./test/register-alias.mjs (installs the
// "@/..." alias resolver) and --experimental-test-module-mocks (required by
// mock.module() in test/admin-write-paths.test.mjs). After a Node upgrade,
// ERR_MODULE_NOT_FOUND for "@/..." or "mock.module is not a function" means
// these flags are the first thing to check. Verified on Node v22.19.0.

// Registered via --import so the alias resolver is installed before the test
// runner's module-mock loader, letting mock.module() target "@/..." specifiers.
import { register } from "node:module";

register("./alias-resolver.mjs", import.meta.url);

