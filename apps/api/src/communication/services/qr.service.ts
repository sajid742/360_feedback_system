import { Injectable } from '@nestjs/common';

/** Generates a QR code as a data URL on demand (not stored). */
@Injectable()
export class QrService {
  async dataUrl(text: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const qrcode = require('qrcode') as { toDataURL(text: string): Promise<string> };
    return qrcode.toDataURL(text);
  }
}
