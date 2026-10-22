/**
 * The one place a sandbox id becomes a Durable Object, so every caller lands on the same one.
 */
export function openSandbox<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  sandboxId: string,
): DurableObjectStub<T> {
  return namespace.getByName(sandboxId.toLowerCase())
}
