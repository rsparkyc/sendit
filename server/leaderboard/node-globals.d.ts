/** Minimal Node globals used by the server entry points (instead of @types/node). */
declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  exitCode: number | undefined;
  readonly stdout: { write(s: string): boolean };
  readonly stderr: { write(s: string): boolean };
};
