// packages/transports-can/src/can-adapter.ts
import * as can from 'socketcan';
import type {
  TransportAdapter,
  DeviceInfo,
  AdapterOpenOptions,
  AdapterHandle,
  AdapterStats,
  RxMeta,
  Unsubscribe,
  SimulatorConfig,
  CanFilter,
} from '@commwatch/proto-core';
import { CANSimulator } from './can-simulator';

export interface CANMessage {
  id: number;
  ext: boolean;
  rtr: boolean;
  data: Buffer;
}

export class CANAdapter implements TransportAdapter {
  id = 'can';
  name = 'CAN Bus';
  type = 'can' as const;

  async listDevices(): Promise<DeviceInfo[]> {
    // On Linux, scan for CAN interfaces
    if (process.platform === 'linux') {
      try {
        const { execSync } = require('child_process');
        const output = execSync('ip link show type can', { encoding: 'utf8' });
        const interfaces = output.match(/\d+: (\w+):/g)?.map((m: string) => m.split(': ')[1].replace(':', '')) || [];
        
        return interfaces.map((iface: string) => ({
          id: `can:${iface}`,
          name: `CAN Interface ${iface}`,
          type: 'can' as const,
          path: iface,
        }));
      } catch {
        // If command fails, return virtual interface
        return [{
          id: 'can:vcan0',
          name: 'Virtual CAN Interface (vcan0)',
          type: 'can' as const,
          path: 'vcan0',
        }];
      }
    }

    // On other platforms, return simulator
    return [{
      id: 'can:simulator',
      name: 'CAN Simulator',
      type: 'can' as const,
      path: 'simulator',
    }];
  }

  async open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle> {
    if (!dev.path) {
      throw new Error('Device path is required');
    }

    if (dev.path === 'simulator') {
      return this.createSimulator({
        mode: 'scripted',
        script: {
          events: [],
          loop: true,
        },
      });
    }

    const channel = can.createRawChannel(dev.path, false);
    
    return new Promise((resolve, reject) => {
      channel.start();
      
      // Wait a bit for channel to be ready
      setTimeout(() => {
        try {
          resolve(new CANHandle(channel, dev.path!, options));
        } catch (err) {
          reject(err);
        }
      }, 100);
    });
  }

  supportsSimulation(): boolean {
    return true;
  }

  async createSimulator(config: SimulatorConfig): Promise<AdapterHandle> {
    return new CANSimulator(config);
  }
}

class CANHandle implements AdapterHandle {
  private stats: AdapterStats = {
    bytesRx: 0,
    bytesTx: 0,
    messagesRx: 0,
    messagesTx: 0,
    errors: 0,
    uptime: 0,
  };
  private startTime = Date.now();
  private readCallbacks: Set<(chunk: Uint8Array, meta?: RxMeta) => void> = new Set();
  private filters: CanFilter[] = [];

  constructor(
    private channel: any,
    private ifname: string,
    private options: AdapterOpenOptions
  ) {
    this.filters = options.canFilters || [];
    this.setupListeners();
    this.applyFilters();
  }

  private setupListeners(): void {
    this.channel.addListener('onMessage', (msg: CANMessage) => {
      const timestamp = process.hrtime.bigint();

      // Apply filters
      if (this.filters.length > 0) {
        const matches = this.filters.some(filter => {
          const idMatch = (msg.id & filter.mask) === (filter.id & filter.mask);
          const extMatch = filter.extended === undefined || filter.extended === msg.ext;
          return idMatch && extMatch;
        });
        
        if (!matches) return;
      }

      // Encode CAN frame: [ID(4)] [DLC(1)] [DATA(0-8)]
      const frame = new Uint8Array(5 + msg.data.length);
      frame[0] = (msg.id >> 24) & 0xFF;
      frame[1] = (msg.id >> 16) & 0xFF;
      frame[2] = (msg.id >> 8) & 0xFF;
      frame[3] = msg.id & 0xFF;
      frame[4] = msg.data.length;
      frame.set(msg.data, 5);

      this.stats.bytesRx += frame.length;
      this.stats.messagesRx++;

      const meta: RxMeta = {
        timestamp,
        direction: 'rx',
        length: frame.length,
        transportSpecific: {
          canId: msg.id,
          canExt: msg.ext,
          canRtr: msg.rtr,
          canDlc: msg.data.length,
        },
      };

      this.readCallbacks.forEach(cb => {
        try {
          cb(frame, meta);
        } catch (error) {
          console.error('Error in read callback:', error);
        }
      });
    });

    this.channel.addListener('onStopped', () => {
      console.log('CAN channel stopped');
    });
  }

  private applyFilters(): void {
    // SocketCAN filters would be applied here
    // This is platform-specific and requires native bindings
  }

  async write(frame: Uint8Array): Promise<void> {
    if (frame.length < 5) {
      throw new Error('Invalid CAN frame: too short');
    }

    const id = (frame[0] << 24) | (frame[1] << 16) | (frame[2] << 8) | frame[3];
    const dlc = frame[4];
    const data = Buffer.from(frame.slice(5, 5 + dlc));

    const msg: CANMessage = {
      id,
      ext: id > 0x7FF,
      rtr: false,
      data,
    };

    try {
      this.channel.send(msg);
      this.stats.bytesTx += frame.length;
      this.stats.messagesTx++;
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe {
    this.readCallbacks.add(cb);
    return () => {
      this.readCallbacks.delete(cb);
    };
  }

  async setOptions(opts: Partial<AdapterOpenOptions>): Promise<void> {
    if (opts.canFilters) {
      this.filters = opts.canFilters;
      this.applyFilters();
    }

    Object.assign(this.options, opts);
  }

  async close(): Promise<void> {
    this.channel.stop();
    this.readCallbacks.clear();
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-can/src/can-simulator.ts
import type { AdapterHandle, AdapterStats, RxMeta, SimulatorConfig, Unsubscribe } from '@commwatch/proto-core';

export class CANSimulator implements AdapterHandle {
  private stats: AdapterStats = {
    bytesRx: 0,
    bytesTx: 0,
    messagesRx: 0,
    messagesTx: 0,
    errors: 0,
    uptime: 0,
  };
  private startTime = Date.now();
  private readCallbacks: Set<(chunk: Uint8Array, meta?: RxMeta) => void> = new Set();
  private timer?: NodeJS.Timeout;
  private frameCounter = 0;

  constructor(private config: SimulatorConfig) {
    this.startSimulation();
  }

  private startSimulation(): void {
    // Generate realistic CAN traffic
    this.timer = setInterval(() => {
      // Simulate multiple CAN IDs
      this.generateFrame(0x100); // Engine RPM
      this.generateFrame(0x200); // Vehicle speed
      this.generateFrame(0x300); // Temperature
      
      if (this.frameCounter % 10 === 0) {
        this.generateFrame(0x7E0); // OBD request
      }
    }, 100);
  }

  private generateFrame(canId: number): void {
    const timestamp = process.hrtime.bigint();
    
    // Generate data based on CAN ID
    let data: number[];
    switch (canId) {
      case 0x100: // Engine RPM (2 bytes, RPM = value * 0.25)
        const rpm = 800 + Math.floor(Math.sin(this.frameCounter / 20) * 2000);
        data = [(rpm >> 8) & 0xFF, rpm & 0xFF, 0, 0, 0, 0, 0, 0];
        break;
      case 0x200: // Vehicle speed (1 byte, km/h)
        const speed = 60 + Math.floor(Math.sin(this.frameCounter / 30) * 20);
        data = [speed, 0, 0, 0, 0, 0, 0, 0];
        break;
      case 0x300: // Temperature (1 byte, °C + 40)
        const temp = 90 + Math.floor(Math.random() * 10);
        data = [temp + 40, 0, 0, 0, 0, 0, 0, 0];
        break;
      case 0x7E0: // OBD request
        data = [0x02, 0x01, 0x0C, 0, 0, 0, 0, 0]; // Request engine RPM
        break;
      default:
        data = Array(8).fill(0);
    }

    const dlc = 8;
    const frame = new Uint8Array(5 + dlc);
    frame[0] = (canId >> 24) & 0xFF;
    frame[1] = (canId >> 16) & 0xFF;
    frame[2] = (canId >> 8) & 0xFF;
    frame[3] = canId & 0xFF;
    frame[4] = dlc;
    frame.set(data, 5);

    this.stats.bytesRx += frame.length;
    this.stats.messagesRx++;

    const meta: RxMeta = {
      timestamp,
      direction: 'rx',
      length: frame.length,
      transportSpecific: {
        canId,
        canExt: canId > 0x7FF,
        canRtr: false,
        canDlc: dlc,
      },
    };

    this.readCallbacks.forEach(cb => {
      try {
        cb(frame, meta);
      } catch (error) {
        console.error('Error in read callback:', error);
      }
    });

    this.frameCounter++;
  }

  async write(frame: Uint8Array): Promise<void> {
    this.stats.bytesTx += frame.length;
    this.stats.messagesTx++;
    
    // In loopback mode, echo back
    if (this.config.mode === 'loopback') {
      setTimeout(() => {
        const timestamp = process.hrtime.bigint();
        const meta: RxMeta = {
          timestamp,
          direction: 'rx',
          length: frame.length,
        };
        this.readCallbacks.forEach(cb => cb(frame, meta));
      }, 10);
    }
  }

  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe {
    this.readCallbacks.add(cb);
    return () => {
      this.readCallbacks.delete(cb);
    };
  }

  async setOptions(): Promise<void> {
    // Simulator doesn't need to update options
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.readCallbacks.clear();
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-can/src/can-decoder.ts
import { ProtocolDecoder, DecodedFrame, FrameField, FrameError } from '@commwatch/proto-core';

export class CANDecoder implements ProtocolDecoder {
  id = 'can';
  name = 'CAN Bus Frame';

  decode(raw: Uint8Array): DecodedFrame | null {
    if (raw.length < 5) return null;

    const id = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
    const dlc = raw[4];
    const data = raw.slice(5, 5 + dlc);

    const fields: FrameField[] = [
      {
        name: 'id',
        value: `0x${id.toString(16).toUpperCase()}`,
        type: 'uint32',
        raw: raw.slice(0, 4),
        offset: 0,
      },
      {
        name: 'extended',
        value: id > 0x7FF,
        type: 'uint8',
        raw: raw.slice(0, 4),
        offset: 0,
      },
      {
        name: 'dlc',
        value: dlc,
        type: 'uint8',
        raw: raw.slice(4, 5),
        offset: 4,
      },
      {
        name: 'data',
        value: data,
        type: 'bytes',
        raw: data,
        offset: 5,
      },
    ];

    // Try to decode known CAN IDs
    const decodedData = this.decodeCANId(id, data);
    if (decodedData) {
      fields.push(...decodedData);
    }

    return {
      protocol: 'can',
      fields,
      metadata: { id, dlc, extended: id > 0x7FF },
    };
  }

  encode(fields: FrameField[]): Uint8Array {
    const idField = fields.find(f => f.name === 'id');
    const dlcField = fields.find(f => f.name === 'dlc');
    const dataField = fields.find(f => f.name === 'data');

    if (!idField || !dlcField || !dataField) {
      throw new Error('Missing required fields: id, dlc, data');
    }

    const idStr = idField.value as string;
    const id = parseInt(idStr.replace('0x', ''), 16);
    const dlc = dlcField.value as number;
    const data = dataField.value as Uint8Array;

    const frame = new Uint8Array(5 + dlc);
    frame[0] = (id >> 24) & 0xFF;
    frame[1] = (id >> 16) & 0xFF;
    frame[2] = (id >> 8) & 0xFF;
    frame[3] = id & 0xFF;
    frame[4] = dlc;
    frame.set(data.slice(0, dlc), 5);

    return frame;
  }

  validate(raw: Uint8Array): FrameError | null {
    if (raw.length < 5) {
      return {
        code: 'FRAME_TOO_SHORT',
        message: 'CAN frame too short',
        severity: 'error',
      };
    }

    const dlc = raw[4];
    if (dlc > 8) {
      return {
        code: 'INVALID_DLC',
        message: `Invalid DLC: ${dlc} (max 8)`,
        severity: 'error',
      };
    }

    if (raw.length !== 5 + dlc) {
      return {
        code: 'LENGTH_MISMATCH',
        message: `Frame length mismatch: expected ${5 + dlc}, got ${raw.length}`,
        severity: 'error',
      };
    }

    return null;
  }

  private decodeCANId(id: number, data: Uint8Array): FrameField[] | null {
    switch (id) {
      case 0x100: // Engine RPM
        if (data.length >= 2) {
          const rpm = ((data[0] << 8) | data[1]) * 0.25;
          return [{
            name: 'engine_rpm',
            value: rpm.toFixed(0),
            type: 'float',
            raw: data.slice(0, 2),
            offset: 0,
            unit: 'RPM',
          }];
        }
        break;
      case 0x200: // Vehicle speed
        if (data.length >= 1) {
          return [{
            name: 'vehicle_speed',
            value: data[0],
            type: 'uint8',
            raw: data.slice(0, 1),
            offset: 0,
            unit: 'km/h',
          }];
        }
        break;
      case 0x300: // Temperature
        if (data.length >= 1) {
          const temp = data[0] - 40;
          return [{
            name: 'coolant_temp',
            value: temp,
            type: 'int8',
            raw: data.slice(0, 1),
            offset: 0,
            unit: '°C',
          }];
        }
        break;
    }
    return null;
  }
}

// packages/transports-can/src/index.ts
export { CANAdapter } from './can-adapter';
export { CANSimulator } from './can-simulator';
export { CANDecoder } from './can-decoder';