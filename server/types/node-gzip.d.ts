declare module 'node-gzip' {
  export function gzip(data: string): Promise<Buffer>;
  export function ungzip(data: Buffer): Promise<Buffer>;
} 