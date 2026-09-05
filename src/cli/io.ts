export interface CliIo {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export const defaultIo: CliIo = { out: process.stdout, err: process.stderr };

export function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}
