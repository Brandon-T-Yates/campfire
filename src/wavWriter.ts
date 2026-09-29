import fs from 'node:fs';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const HEADER_SIZE = 44;

export class WavWriter {
  readonly filePath: string;
  private readonly stream: fs.WriteStream;
  private dataBytes = 0;
  private writable = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath);
    this.stream.write(encodeWavHeader(0));
  }

  writePcm(chunk: Buffer) {
    this.dataBytes += chunk.length;
    this.writable = this.writable.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.stream.write(chunk, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );
  }

  async close() {
    await this.writable;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    const header = encodeWavHeader(this.dataBytes);
    const file = await fs.promises.open(this.filePath, 'r+');
    await file.write(header, 0, HEADER_SIZE, 0);
    await file.close();
  }
}

function encodeWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE((SAMPLE_RATE * CHANNELS * BIT_DEPTH) / 8, 28);
  header.writeUInt16LE((CHANNELS * BIT_DEPTH) / 8, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
