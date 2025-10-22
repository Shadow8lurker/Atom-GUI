// packages/transports-uart/src/uart-adapter.ts
import { SerialPort, SerialPortOpenOptions } from 'serialport';
import type {
  TransportAdapter,
  DeviceInfo,
  AdapterOpenOptions,
  AdapterHandle,
  AdapterStats,
  RxMeta,
  Unsubscribe,
  SimulatorConfig,
} from '@commwatch/proto-core';
import { UARTSimulator } from './uart-simulator';

export class UARTAdapter implements TransportAdapter {
  id = 'uart';
  name = 'UART Serial';
  type = 'uart' as const;

  async listDevices(): Promise<DeviceInfo[]> {
    const ports = await SerialPort.list();
    
    return ports.map(port => ({
      id: `uart:${port.path}`,
      name: port.friendlyName || port.path,
      type: 'uart' as const,
      path: port.path,
      vendorId: port.vendorId,
      productId: port.productId,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
    }));
  }

  async open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle> {
    if (!dev.path) {
      throw new Error('Device path is required');
    }

    const serialOptions: SerialPortOpenOptions<any> = {
      path: dev.path,
      baudRate: options.baudRate || 115200,
      dataBits: options.dataBits || 8,
      stopBits: options.stopBits || 1,
      parity: options.parity || 'none',
      autoOpen: false,
    };

    const port = new SerialPort(serialOptions);

    return new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(new UARTHandle(port, options));
        }
      });
    });
  }

  supportsSimulation(): boolean {
    return true;
  }

  async createSimulator(config: SimulatorConfig): Promise<AdapterHandle> {
    return new UARTSimulator(config);
  }
}

class UARTHandle implements AdapterHandle {
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

  constructor(
    private port: SerialPort,
    private options: AdapterOpenOptions
  ) {
    this.setupListeners();
  }

  private setupListeners(): void {
    this.port.on('data', (data: Buffer) => {
      const timestamp = process.hrtime.bigint();
      const chunk = new Uint8Array(data);
      
      this.stats.bytesRx += chunk.length;
      this.stats.messagesRx++;

      const meta: RxMeta = {
        timestamp,
        direction: 'rx',
        length: chunk.length,
      };

      this.readCallbacks.forEach(cb => {
        try {
          cb(chunk, meta);
        } catch (error) {
          console.error('Error in read callback:', error);
        }
      });
    });

    this.port.on('error', (err) => {
      this.stats.errors++;
      console.error('UART error:', err);
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(Buffer.from(frame), (err) => {
        if (err) {
          this.stats.errors++;
          reject(err);
        } else {
          this.stats.bytesTx += frame.length;
          this.stats.messagesTx++;
          resolve();
        }
      });
    });
  }

  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe {
    this.readCallbacks.add(cb);
    return () => {
      this.readCallbacks.delete(cb);
    };
  }

  async setOptions(opts: Partial<AdapterOpenOptions>): Promise<void> {
    // Update UART settings
    if (opts.baudRate !== undefined) {
      await this.port.update({ baudRate: opts.baudRate });
    }

    // Update flow control
    if (opts.flowControl) {
      const rts = opts.flowControl.includes('rts');
      const dtr = opts.flowControl.includes('dtr');
      await this.port.set({ rts, dtr });
    }

    Object.assign(this.options, opts);
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.readCallbacks.clear();
          resolve();
        }
      });
    });
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-uart/src/uart-simulator.ts
import type { AdapterHandle, AdapterStats, RxMeta, SimulatorConfig, Unsubscribe } from '@commwatch/proto-core';

export class UARTSimulator implements AdapterHandle {
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
  private scriptTimer?: NodeJS.Timeout;
  private loopbackBuffer: Uint8Array[] = [];

  constructor(private config: SimulatorConfig) {
    this.startSimulation();
  }

  private startSimulation(): void {
    if (this.config.mode === 'loopback') {
      // Loopback mode: echo everything back
      return;
    }

    if (this.config.mode === 'scripted' && this.config.script) {
      this.runScript();
    }

    if (this.config.mode === 'burst' && this.config.burstInterval) {
      this.startBurstMode();
    }
  }

  private runScript(): void {
    if (!this.config.script) return;

    const events = this.config.script.events;
    let index = 0;

    const executeNext = () => {
      if (index >= events.length) {
        if (this.config.script?.loop) {
          index = 0;
        } else {
          return;
        }
      }

      const event = events[index++];
      
      this.scriptTimer = setTimeout(() => {
        switch (event.action) {
          case 'send':
          case 'receive':
            if (event.data) {
              this.simulateReceive(event.data);
            }
            break;
          case 'error':
            this.stats.errors++;
            break;
        }
        executeNext();
      }, event.delay);
    };

    executeNext();
  }

  private startBurstMode(): void {
    if (!this.config.burstInterval || !this.config.burstSize) return;

    const sendBurst = () => {
      for (let i = 0; i < this.config.burstSize!; i++) {
        // Generate sample EFuse frame
        const frame = this.generateSampleFrame(i);
        this.simulateReceive(frame);
      }
    };

    this.scriptTimer = setInterval(sendBurst, this.config.burstInterval);
  }

  private generateSampleFrame(sequence: number): Uint8Array {
    // Generate EFuse ADC frame: [0xAA] [0x01] [0x00 0x02] [MSB LSB] [CRC16] [0xBB]
    const adcValue = 2048 + Math.floor(Math.sin(sequence / 10) * 500);
    const payload = new Uint8Array([
      (adcValue >> 8) & 0xFF,
      adcValue & 0xFF,
    ]);

    // Calculate CRC
    const type = 0x01;
    const length = 2;
    const crcData = new Uint8Array([type, 0x00, length, ...payload]);
    const crc = this.calculateCrc16(crcData);

    return new Uint8Array([
      0xAA,
      type,
      0x00,
      length,
      ...payload,
      (crc >> 8) & 0xFF,
      crc & 0xFF,
      0xBB,
    ]);
  }

  private calculateCrc16(data: Uint8Array): number {
    let crc = 0xFFFF;
    for (const byte of data) {
      crc ^= byte << 8;
      for (let i = 0; i < 8; i++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ 0x1021;
        } else {
          crc = crc << 1;
        }
      }
    }
    return crc & 0xFFFF;
  }

  private simulateReceive(data: Uint8Array): void {
    const timestamp = process.hrtime.bigint();
    
    // Simulate errors if configured
    if (this.config.errorRate && Math.random() < this.config.errorRate) {
      this.stats.errors++;
      return;
    }

    this.stats.bytesRx += data.length;
    this.stats.messagesRx++;

    const meta: RxMeta = {
      timestamp,
      direction: 'rx',
      length: data.length,
    };

    this.readCallbacks.forEach(cb => {
      try {
        cb(data, meta);
      } catch (error) {
        console.error('Error in read callback:', error);
      }
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    this.stats.bytesTx += frame.length;
    this.stats.messagesTx++;

    if (this.config.mode === 'loopback') {
      // Echo back after small delay
      setTimeout(() => {
        this.simulateReceive(frame);
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
    if (this.scriptTimer) {
      clearInterval(this.scriptTimer);
      clearTimeout(this.scriptTimer);
    }
    this.readCallbacks.clear();
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-uart/src/index.ts
export { UARTAdapter } from './uart-adapter';
export { UARTSimulator } from './uart-simulator';