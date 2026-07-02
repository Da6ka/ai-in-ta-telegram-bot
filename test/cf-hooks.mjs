// Module-resolution hook: maps the `cloudflare:workers` specifier to a local
// stub so the Worker source can run under plain Node for behavioral tests.
// Registered via module.register() in worker.behavior.test.mjs.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { shortCircuit: true, url: new URL('./cf-stub.mjs', import.meta.url).href }
  }
  return nextResolve(specifier, context)
}
