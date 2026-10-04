// Minimal ambient types for the node: built-ins used by this package (no @types/node offline).
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}
declare module "node:crypto" {
  interface Hash { update(data: string): Hash; digest(encoding: "hex"): string; }
  export function createHash(algorithm: string): Hash;
}
