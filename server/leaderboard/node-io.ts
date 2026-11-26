/**
 * The few Node built-ins the server uses, typed locally so the project does
 * not need @types/node (which would leak Node globals into the browser code's
 * type check).
 */

interface NodeFs {
  readFileSync(path: string | URL): Uint8Array;
}

/** Read a file shipped next to the bundle (or any path / file URL). */
export async function readAsset(name: string, base: string): Promise<Uint8Array> {
  const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as NodeFs;
  return new Uint8Array(fs.readFileSync(new URL(name, base)));
}
