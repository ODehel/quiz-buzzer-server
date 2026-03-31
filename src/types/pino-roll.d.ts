declare module "pino-roll" {
  import { WritableStream } from "node:stream/web";

  interface PinoRollOptions {
    file: string;
    frequency?: string;
    dateFormat?: string;
    mkdir?: boolean;
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<NodeJS.WritableStream>;
}
