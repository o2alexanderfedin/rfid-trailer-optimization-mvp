/**
 * Back-compat surface for the original walking-skeleton import path. The hub
 * data and its `HubRegistered` mapping now live in `network/hubs.ts` (alongside
 * `network/routes.ts`); this module re-exports them so earlier callers
 * (`@mm/api`'s seed, the Plan-01 skeleton test) keep working unchanged.
 */
export { USA_HUBS, MEMPHIS, hubRegisteredEvent } from "./network/hubs.js";
