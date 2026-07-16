export function unsupportedOperation(operation: string): never {
  throw new Error(`Elitical ${operation} is not available in this runtime.`);
}
