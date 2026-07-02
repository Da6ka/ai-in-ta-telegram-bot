// Minimal stand-in for the `cloudflare:workers` module so worker/src/index.js
// can be imported under Node's test runner (see cf-hooks.mjs).
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
  }
}
