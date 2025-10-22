// packages/proto-core/src/types/transport.ts
export interface DeviceInfo {
  id: string;
  name: string;
  type: TransportType;
  path?: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  serialNumber?: string;
  metadata?: Record<string, unknown>;
}

export type TransportType = 'uart' | 'spi' | 'i2c' | 'can' | 'ethernet';

export interface RxMeta {
  timestamp: bigint;
  direction: 'rx' | 'tx';
  length: number;
  error?: string;
  transportSpecific?: Record<string, unknown>;
}

export type Unsubscribe = () => void;

export interface AdapterOpenOptions {
  // UART
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl?: 'none' | 'xon-xoff' | 'rts-cts' | 'dsr-dtr';
  readTimeout?: number;
  
  // SPI
  spiMode?: 0 | 1 | 2 | 3;
  clockSpeed?: number;
  bitOrder?: 'msb' | 'lsb';
  csPolarity?: 'active-low' | 'active-high';
  csHoldTime?: number;
  
  // I²C
  i2cBusSpeed?: 100000 | 400000 | 1000000;
  i2cAddressMode?: 7 | 10;
  i2cSlaveAddress?: number;
  
  // CAN
  canBitrate?: number;
  canFD?: boolean;
  canListenOnly?: boolean;
  canFilters?: CanFilter[];
  
  // Ethernet
  ethInterface?: string;
  ethProtocol?: 'udp' | 'tcp' | 'raw';
  ethPort?: number;
  ethHost?: string;
  ethBpfFilter?: string;
  ethMulticast?: string[];
}

export interface CanFilter {
  id: number;
  mask: number;
  extended?: boolean;
}

export interface AdapterHandle {
  write(frame: Uint8Array): Promise<void>;
  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe;
  setOptions(opts: Partial<AdapterOpenOptions>): Promise<void>;
  close(): Promise<void>;
  getStats(): Promise<AdapterStats>;
}

export interface AdapterStats {
  bytesRx: number;
  bytesTx: number;
  messagesRx: number;
  messagesTx: number;
  errors: number;
  uptime: number;
}

export interface TransportAdapter {
  id: string;
  name: string;
  type: TransportType;
  listDevices(): Promise<DeviceInfo[]>;
  open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle>;
  supportsSimulation(): boolean;
  createSimulator?(config: SimulatorConfig): Promise<AdapterHandle>;
}

export interface SimulatorConfig {
  mode: 'loopback' | 'scripted' | 'burst' | 'error-inject';
  script?: SimulatorScript;
  errorRate?: number;
  burstSize?: number;
  burstInterval?: number;
}

export interface SimulatorScript {
  events: SimulatorEvent[];
  loop?: boolean;
}

export interface SimulatorEvent {
  delay: number;
  action: 'send' | 'receive' | 'error' | 'disconnect';
  data?: Uint8Array;
  error?: string;
}

// packages/proto-core/src/types/protocol.ts
export interface ProtocolFrame {
  id: string;
  timestamp: bigint;
  direction: 'rx' | 'tx';
  raw: Uint8Array;
  decoded?: DecodedFrame;
  error?: FrameError;
}

export interface DecodedFrame {
  protocol: string;
  fields: FrameField[];
  checksum?: ChecksumInfo;
  metadata?: Record<string, unknown>;
}

export interface FrameField {
  name: string;
  value: unknown;
  type: 'uint8' | 'uint16' | 'uint32' | 'int8' | 'int16' | 'int32' | 'float' | 'string' | 'bytes';
  raw: Uint8Array;
  offset: number;
  scaling?: number;
  unit?: string;
}

export interface ChecksumInfo {
  type: 'crc16-ccitt-false' | 'crc32' | 'checksum8' | 'custom';
  expected: number;
  calculated: number;
  valid: boolean;
}

export interface FrameError {
  code: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface ProtocolDecoder {
  id: string;
  name: string;
  decode(raw: Uint8Array): DecodedFrame | null;
  encode(fields: FrameField[]): Uint8Array;
  validate(raw: Uint8Array): FrameError | null;
}

// packages/proto-core/src/utils/crc.ts
export class CRCCalculator {
  private static CRC16_CCITT_FALSE_TABLE: Uint16Array;

  static {
    this.CRC16_CCITT_FALSE_TABLE = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i << 8;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      }
      this.CRC16_CCITT_FALSE_TABLE[i] = crc & 0xFFFF;
    }
  }

  static crc16CcittFalse(data: Uint8Array): number {
    let crc = 0xFFFF;
    for (const byte of data) {
      const index = ((crc >> 8) ^ byte) & 0xFF;
      crc = ((crc << 8) ^ this.CRC16_CCITT_FALSE_TABLE[index]) & 0xFFFF;
    }
    return crc;
  }

  static crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (const byte of data) {
      crc ^= byte;
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  static checksum8(data: Uint8Array): number {
    let sum = 0;
    for (const byte of data) {
      sum = (sum + byte) & 0xFF;
    }
    return sum;
  }

  static verifyCrc16CcittFalse(data: Uint8Array, expectedCrc: number): boolean {
    return this.crc16CcittFalse(data) === expectedCrc;
  }
}

// packages/proto-core/src/message-bus/events.ts
export type MessageBusEvent = 
  | { type: 'device:connected'; device: DeviceInfo }
  | { type: 'device:disconnected'; deviceId: string }
  | { type: 'device:error'; deviceId: string; error: string }
  | { type: 'frame:received'; frame: ProtocolFrame }
  | { type: 'frame:sent'; frame: ProtocolFrame }
  | { type: 'frame:error'; frame: ProtocolFrame; error: FrameError }
  | { type: 'stats:update'; deviceId: string; stats: AdapterStats };

export type MessageBusListener = (event: MessageBusEvent) => void;

export class MessageBus {
  private listeners: Map<string, Set<MessageBusListener>> = new Map();
  private allListeners: Set<MessageBusListener> = new Set();

  on(eventType: MessageBusEvent['type'] | '*', listener: MessageBusListener): Unsubscribe {
    if (eventType === '*') {
      this.allListeners.add(listener);
      return () => this.allListeners.delete(listener);
    }

    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);

    return () => {
      const set = this.listeners.get(eventType);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(eventType);
        }
      }
    };
  }

  emit(event: MessageBusEvent): void {
    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach(listener => {
        try {
          listener(event);
        } catch (error) {
          console.error(`Error in listener for ${event.type}:`, error);
        }
      });
    }

    // Notify wildcard listeners
    this.allListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in wildcard listener:', error);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
    this.allListeners.clear();
  }
}

// packages/proto-core/src/schemas/config.ts
import { z } from 'zod';

export const DeviceConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['uart', 'spi', 'i2c', 'can', 'ethernet']),
  path: z.string().optional(),
  options: z.record(z.unknown()),
});

export const ProtocolConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  decoder: z.string(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.string(),
    offset: z.number(),
    length: z.number(),
    scaling: z.number().optional(),
    unit: z.string().optional(),
  })),
});

export const SessionConfigSchema = z.object({
  name: z.string(),
  device: DeviceConfigSchema,
  protocol: ProtocolConfigSchema,
  filters: z.array(z.object({
    type: z.enum(['regex', 'pattern', 'field']),
    value: z.unknown(),
    action: z.enum(['log', 'colorize', 'export', 'respond']),
  })).optional(),
  presets: z.array(z.object({
    name: z.string(),
    data: z.string(), // hex string
    template: z.boolean().optional(),
  })).optional(),
});

export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;
export type ProtocolConfig = z.infer<typeof ProtocolConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

// packages/proto-core/src/index.ts
export * from './types/transport';
export * from './types/protocol';
export * from './utils/crc';
export * from './message-bus/events';
export * from './schemas/config';

export { MessageBus } from './message-bus/events';
export { CRCCalculator } from './utils/crc';
