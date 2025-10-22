// packages/decoders/src/efuse-decoder.ts
import { ProtocolDecoder, DecodedFrame, FrameField, FrameError, ChecksumInfo } from '@commwatch/proto-core';
import { CRCCalculator } from '@commwatch/proto-core';

/**
 * EFuse Custom Frame Format:
 * [0xAA] [Type:1] [Length:2] [Payload:N] [CRC16:2] [0xBB]
 * 
 * - Start: 0xAA
 * - Type: 1 byte message type
 * - Length: 2 bytes (big-endian) payload length
 * - Payload: N bytes
 * - CRC16: 2 bytes CRC-16/CCITT-FALSE over Type+Length+Payload
 * - End: 0xBB
 */
export class EFuseDecoder implements ProtocolDecoder {
  id = 'efuse';
  name = 'EFuse Custom Frame';

  private static readonly START_MARKER = 0xAA;
  private static readonly END_MARKER = 0xBB;
  private static readonly MIN_FRAME_LENGTH = 7; // AA + Type + Len(2) + CRC(2) + BB

  decode(raw: Uint8Array): DecodedFrame | null {
    if (raw.length < EFuseDecoder.MIN_FRAME_LENGTH) {
      return null;
    }

    // Verify markers
    if (raw[0] !== EFuseDecoder.START_MARKER || raw[raw.length - 1] !== EFuseDecoder.END_MARKER) {
      return null;
    }

    const type = raw[1];
    const payloadLength = (raw[2] << 8) | raw[3];
    
    // Verify frame length
    const expectedLength = 1 + 1 + 2 + payloadLength + 2 + 1; // markers + type + len + payload + crc + marker
    if (raw.length !== expectedLength) {
      return null;
    }

    // Extract payload
    const payloadStart = 4;
    const payloadEnd = payloadStart + payloadLength;
    const payload = raw.slice(payloadStart, payloadEnd);

    // Extract CRC
    const crcExpected = (raw[payloadEnd] << 8) | raw[payloadEnd + 1];

    // Calculate CRC over Type + Length + Payload
    const crcData = raw.slice(1, payloadEnd);
    const crcCalculated = CRCCalculator.crc16CcittFalse(crcData);
    const crcValid = crcExpected === crcCalculated;

    // Parse fields
    const fields: FrameField[] = [
      {
        name: 'type',
        value: type,
        type: 'uint8',
        raw: raw.slice(1, 2),
        offset: 1,
      },
      {
        name: 'length',
        value: payloadLength,
        type: 'uint16',
        raw: raw.slice(2, 4),
        offset: 2,
      },
      {
        name: 'payload',
        value: payload,
        type: 'bytes',
        raw: payload,
        offset: 4,
      },
    ];

    // Try to decode payload based on type
    const decodedPayload = this.decodePayload(type, payload);
    if (decodedPayload) {
      fields.push(...decodedPayload);
    }

    const checksum: ChecksumInfo = {
      type: 'crc16-ccitt-false',
      expected: crcExpected,
      calculated: crcCalculated,
      valid: crcValid,
    };

    return {
      protocol: 'efuse',
      fields,
      checksum,
      metadata: { type, payloadLength },
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const typeField = fields.find(f => f.name === 'type');
    const payloadField = fields.find(f => f.name === 'payload');

    if (!typeField || !payloadField) {
      throw new Error('Missing required fields: type and payload');
    }

    const type = typeField.value as number;
    const payload = payloadField.value as Uint8Array;
    const payloadLength = payload.length;

    // Build frame
    const frameLength = 1 + 1 + 2 + payloadLength + 2 + 1;
    const frame = new Uint8Array(frameLength);
    
    let offset = 0;
    frame[offset++] = EFuseDecoder.START_MARKER;
    frame[offset++] = type;
    frame[offset++] = (payloadLength >> 8) & 0xFF;
    frame[offset++] = payloadLength & 0xFF;
    frame.set(payload, offset);
    offset += payloadLength;

    // Calculate CRC
    const crcData = frame.slice(1, offset);
    const crc = CRCCalculator.crc16CcittFalse(crcData);
    frame[offset++] = (crc >> 8) & 0xFF;
    frame[offset++] = crc & 0xFF;
    frame[offset++] = EFuseDecoder.END_MARKER;

    return frame;
  }

  validate(raw: Uint8Array): FrameError | null {
    if (raw.length < EFuseDecoder.MIN_FRAME_LENGTH) {
      return {
        code: 'FRAME_TOO_SHORT',
        message: `Frame too short: ${raw.length} < ${EFuseDecoder.MIN_FRAME_LENGTH}`,
        severity: 'error',
      };
    }

    if (raw[0] !== EFuseDecoder.START_MARKER) {
      return {
        code: 'INVALID_START_MARKER',
        message: `Invalid start marker: 0x${raw[0].toString(16)}`,
        severity: 'error',
      };
    }

    if (raw[raw.length - 1] !== EFuseDecoder.END_MARKER) {
      return {
        code: 'INVALID_END_MARKER',
        message: `Invalid end marker: 0x${raw[raw.length - 1].toString(16)}`,
        severity: 'error',
      };
    }

    const payloadLength = (raw[2] << 8) | raw[3];
    const expectedLength = 1 + 1 + 2 + payloadLength + 2 + 1;
    
    if (raw.length !== expectedLength) {
      return {
        code: 'LENGTH_MISMATCH',
        message: `Length mismatch: expected ${expectedLength}, got ${raw.length}`,
        severity: 'error',
      };
    }

    // Verify CRC
    const payloadEnd = 4 + payloadLength;
    const crcExpected = (raw[payloadEnd] << 8) | raw[payloadEnd + 1];
    const crcData = raw.slice(1, payloadEnd);
    const crcCalculated = CRCCalculator.crc16CcittFalse(crcData);

    if (crcExpected !== crcCalculated) {
      return {
        code: 'CRC_MISMATCH',
        message: `CRC mismatch: expected 0x${crcExpected.toString(16)}, calculated 0x${crcCalculated.toString(16)}`,
        severity: 'error',
      };
    }

    return null;
  }

  private decodePayload(type: number, payload: Uint8Array): FrameField[] | null {
    switch (type) {
      case 0x01: // ADC reading
        return this.decodeAdcPayload(payload);
      case 0x02: // Status
        return this.decodeStatusPayload(payload);
      case 0x03: // Configuration
        return this.decodeConfigPayload(payload);
      default:
        return null;
    }
  }

  private decodeAdcPayload(payload: Uint8Array): FrameField[] {
    if (payload.length < 2) return [];
    
    const rawValue = (payload[0] << 8) | payload[1];
    const voltage = (rawValue / 4095.0) * 3.3; // 12-bit ADC, 3.3V ref

    return [
      {
        name: 'adc_raw',
        value: rawValue,
        type: 'uint16',
        raw: payload.slice(0, 2),
        offset: 0,
      },
      {
        name: 'voltage',
        value: voltage.toFixed(3),
        type: 'float',
        raw: payload.slice(0, 2),
        offset: 0,
        scaling: 3.3 / 4095.0,
        unit: 'V',
      },
    ];
  }

  private decodeStatusPayload(payload: Uint8Array): FrameField[] {
    if (payload.length < 1) return [];
    
    const status = payload[0];
    return [
      {
        name: 'status',
        value: status,
        type: 'uint8',
        raw: payload.slice(0, 1),
        offset: 0,
      },
      {
        name: 'ready',
        value: !!(status & 0x01),
        type: 'uint8',
        raw: payload.slice(0, 1),
        offset: 0,
      },
      {
        name: 'error',
        value: !!(status & 0x02),
        type: 'uint8',
        raw: payload.slice(0, 1),
        offset: 0,
      },
    ];
  }

  private decodeConfigPayload(payload: Uint8Array): FrameField[] {
    if (payload.length < 4) return [];
    
    return [
      {
        name: 'config_value',
        value: (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3],
        type: 'uint32',
        raw: payload.slice(0, 4),
        offset: 0,
      },
    ];
  }
}

// packages/decoders/src/cobs-decoder.ts
export class COBSDecoder implements ProtocolDecoder {
  id = 'cobs';
  name = 'Consistent Overhead Byte Stuffing';

  decode(raw: Uint8Array): DecodedFrame | null {
    const decoded = this.cobsDecode(raw);
    if (!decoded) return null;

    return {
      protocol: 'cobs',
      fields: [
        {
          name: 'data',
          value: decoded,
          type: 'bytes',
          raw: decoded,
          offset: 0,
        },
      ],
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const dataField = fields.find(f => f.name === 'data');
    if (!dataField) {
      throw new Error('Missing data field');
    }
    return this.cobsEncode(dataField.value as Uint8Array);
  }

  validate(raw: Uint8Array): FrameError | null {
    if (raw.length === 0) {
      return { code: 'EMPTY_FRAME', message: 'Empty COBS frame', severity: 'error' };
    }
    
    const decoded = this.cobsDecode(raw);
    if (!decoded) {
      return { code: 'INVALID_COBS', message: 'Invalid COBS encoding', severity: 'error' };
    }
    
    return null;
  }

  private cobsEncode(data: Uint8Array): Uint8Array {
    const result: number[] = [];
    let codeIndex = 0;
    let code = 1;

    result.push(0); // Placeholder for first code

    for (const byte of data) {
      if (byte === 0) {
        result[codeIndex] = code;
        codeIndex = result.length;
        result.push(0);
        code = 1;
      } else {
        result.push(byte);
        code++;
        if (code === 0xFF) {
          result[codeIndex] = code;
          codeIndex = result.length;
          result.push(0);
          code = 1;
        }
      }
    }

    result[codeIndex] = code;
    return new Uint8Array(result);
  }

  private cobsDecode(data: Uint8Array): Uint8Array | null {
    const result: number[] = [];
    let i = 0;

    while (i < data.length) {
      const code = data[i++];
      if (code === 0) {
        return null; // Invalid COBS
      }

      for (let j = 1; j < code && i < data.length; j++) {
        result.push(data[i++]);
      }

      if (code < 0xFF && i < data.length) {
        result.push(0);
      }
    }

    return new Uint8Array(result);
  }
}

// packages/decoders/src/slip-decoder.ts
export class SLIPDecoder implements ProtocolDecoder {
  id = 'slip';
  name = 'Serial Line IP';

  private static readonly END = 0xC0;
  private static readonly ESC = 0xDB;
  private static readonly ESC_END = 0xDC;
  private static readonly ESC_ESC = 0xDD;

  decode(raw: Uint8Array): DecodedFrame | null {
    const decoded = this.slipDecode(raw);
    if (!decoded) return null;

    return {
      protocol: 'slip',
      fields: [
        {
          name: 'data',
          value: decoded,
          type: 'bytes',
          raw: decoded,
          offset: 0,
        },
      ],
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const dataField = fields.find(f => f.name === 'data');
    if (!dataField) {
      throw new Error('Missing data field');
    }
    return this.slipEncode(dataField.value as Uint8Array);
  }

  validate(raw: Uint8Array): FrameError | null {
    if (raw.length === 0) {
      return { code: 'EMPTY_FRAME', message: 'Empty SLIP frame', severity: 'error' };
    }
    return null;
  }

  private slipEncode(data: Uint8Array): Uint8Array {
    const result: number[] = [];

    for (const byte of data) {
      if (byte === SLIPDecoder.END) {
        result.push(SLIPDecoder.ESC, SLIPDecoder.ESC_END);
      } else if (byte === SLIPDecoder.ESC) {
        result.push(SLIPDecoder.ESC, SLIPDecoder.ESC_ESC);
      } else {
        result.push(byte);
      }
    }

    result.push(SLIPDecoder.END);
    return new Uint8Array(result);
  }

  private slipDecode(data: Uint8Array): Uint8Array | null {
    const result: number[] = [];
    let escaped = false;

    for (const byte of data) {
      if (byte === SLIPDecoder.END) {
        break; // End of frame
      } else if (escaped) {
        if (byte === SLIPDecoder.ESC_END) {
          result.push(SLIPDecoder.END);
        } else if (byte === SLIPDecoder.ESC_ESC) {
          result.push(SLIPDecoder.ESC);
        } else {
          return null; // Invalid escape sequence
        }
        escaped = false;
      } else if (byte === SLIPDecoder.ESC) {
        escaped = true;
      } else {
        result.push(byte);
      }
    }

    return new Uint8Array(result);
  }
}

// packages/decoders/src/hex-decoder.ts
export class HexDecoder implements ProtocolDecoder {
  id = 'hex';
  name = 'Hexadecimal';

  decode(raw: Uint8Array): DecodedFrame | null {
    return {
      protocol: 'hex',
      fields: [
        {
          name: 'hex',
          value: Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join(' '),
          type: 'string',
          raw,
          offset: 0,
        },
        {
          name: 'raw',
          value: raw,
          type: 'bytes',
          raw,
          offset: 0,
        },
      ],
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const hexField = fields.find(f => f.name === 'hex');
    if (hexField) {
      const hexStr = (hexField.value as string).replace(/\s/g, '');
      const bytes = new Uint8Array(hexStr.length / 2);
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes[i / 2] = parseInt(hexStr.substr(i, 2), 16);
      }
      return bytes;
    }

    const rawField = fields.find(f => f.name === 'raw');
    if (rawField) {
      return rawField.value as Uint8Array;
    }

    throw new Error('Missing hex or raw field');
  }

  validate(raw: Uint8Array): FrameError | null {
    return null; // Hex is always valid
  }
}

// packages/decoders/src/ascii-decoder.ts
export class ASCIIDecoder implements ProtocolDecoder {
  id = 'ascii';
  name = 'ASCII Text';

  decode(raw: Uint8Array): DecodedFrame | null {
    const text = new TextDecoder('ascii', { fatal: false }).decode(raw);
    
    return {
      protocol: 'ascii',
      fields: [
        {
          name: 'text',
          value: text,
          type: 'string',
          raw,
          offset: 0,
        },
      ],
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const textField = fields.find(f => f.name === 'text');
    if (!textField) {
      throw new Error('Missing text field');
    }
    return new TextEncoder().encode(textField.value as string);
  }

  validate(raw: Uint8Array): FrameError | null {
    // Check for non-printable characters
    for (const byte of raw) {
      if (byte < 0x20 && byte !== 0x0A && byte !== 0x0D && byte !== 0x09) {
        return {
          code: 'NON_PRINTABLE',
          message: 'Contains non-printable characters',
          severity: 'warning',
        };
      }
    }
    return null;
  }
}

// packages/decoders/src/index.ts
export { EFuseDecoder } from './efuse-decoder';
export { COBSDecoder } from './cobs-decoder';
export { SLIPDecoder } from './slip-decoder';
export { HexDecoder } from './hex-decoder';
export { ASCIIDecoder } from './ascii-decoder';

export const DEFAULT_DECODERS = [
  new EFuseDecoder(),
  new COBSDecoder(),
  new SLIPDecoder(),
  new HexDecoder(),
  new ASCIIDecoder(),
];