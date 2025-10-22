// packages/transports-eth/src/eth-adapter.ts
import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';
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

export class EthernetAdapter implements TransportAdapter {
  id = 'ethernet';
  name = 'Ethernet';
  type = 'ethernet' as const;

  async listDevices(): Promise<DeviceInfo[]> {
    const interfaces = os.networkInterfaces();
    const devices: DeviceInfo[] = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          devices.push({
            id: `eth:${name}:${addr.address}`,
            name: `${name} (${addr.address})`,
            type: 'ethernet' as const,
            path: name,
            metadata: { address: addr.address, mac: addr.mac },
          });
        }
      }
    }

    return devices;
  }

  async open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle> {
    const protocol = options.ethProtocol || 'udp';

    if (protocol === 'udp') {
      return new UDPHandle(options);
    } else if (protocol === 'tcp') {
      return new TCPHandle(options);
    }

    throw new Error(`Unsupported protocol: ${protocol}`);
  }

  supportsSimulation(): boolean {
    return true;
  }

  async createSimulator(config: SimulatorConfig): Promise<AdapterHandle> {
    return new UDPHandle({ ethProtocol: 'udp', ethPort: 5000 });
  }
}

class UDPHandle implements AdapterHandle {
  private socket: dgram.Socket;
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

  constructor(private options: AdapterOpenOptions) {
    this.socket = dgram.createSocket('udp4');
    this.setupListeners();

    if (options.ethPort) {
      this.socket.bind(options.ethPort);
    }

    // Join multicast groups if specified
    if (options.ethMulticast) {
      options.ethMulticast.forEach(group => {
        this.socket.addMembership(group);
      });
    }
  }

  private setupListeners(): void {
    this.socket.on('message', (msg, rinfo) => {
      const timestamp = process.hrtime.bigint();
      const chunk = new Uint8Array(msg);

      this.stats.bytesRx += chunk.length;
      this.stats.messagesRx++;

      const meta: RxMeta = {
        timestamp,
        direction: 'rx',
        length: chunk.length,
        transportSpecific: {
          remoteAddress: rinfo.address,
          remotePort: rinfo.port,
        },
      };

      this.readCallbacks.forEach(cb => {
        try {
          cb(chunk, meta);
        } catch (error) {
          console.error('Error in read callback:', error);
        }
      });
    });

    this.socket.on('error', (err) => {
      this.stats.errors++;
      console.error('UDP error:', err);
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = this.options.ethHost || 'localhost';
      const port = this.options.ethPort || 5000;

      this.socket.send(Buffer.from(frame), port, host, (err) => {
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
    Object.assign(this.options, opts);
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.close(() => {
        this.readCallbacks.clear();
        resolve();
      });
    });
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

class TCPHandle implements AdapterHandle {
  private socket?: net.Socket;
  private server?: net.Server;
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

  constructor(private options: AdapterOpenOptions) {
    this.initConnection();
  }

  private async initConnection(): Promise<void> {
    if (this.options.ethHost) {
      // Client mode
      this.socket = new net.Socket();
      this.socket.connect(this.options.ethPort || 5000, this.options.ethHost);
      this.setupSocketListeners(this.socket);
    } else {
      // Server mode
      this.server = net.createServer((socket) => {
        this.socket = socket;
        this.setupSocketListeners(socket);
      });
      this.server.listen(this.options.ethPort || 5000);
    }
  }

  private setupSocketListeners(socket: net.Socket): void {
    socket.on('data', (data) => {
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

    socket.on('error', (err) => {
      this.stats.errors++;
      console.error('TCP error:', err);
    });
  }

  async write(frame: Uint8Array): Promise<void> {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    return new Promise((resolve, reject) => {
      this.socket!.write(Buffer.from(frame), (err) => {
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
    Object.assign(this.options, opts);
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.readCallbacks.clear();
          resolve();
        });
      });
    }
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-spi/src/spi-adapter.ts
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

export class SPIAdapter implements TransportAdapter {
  id = 'spi';
  name = 'SPI';
  type = 'spi' as const;

  async listDevices(): Promise<DeviceInfo[]> {
    // List USB-to-SPI bridges (FT232H, CH347A, etc.)
    return [
      {
        id: 'spi:simulator',
        name: 'SPI Simulator',
        type: 'spi' as const,
        path: 'simulator',
      },
    ];
  }

  async open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle> {
    return new SPISimulator(options);
  }

  supportsSimulation(): boolean {
    return true;
  }

  async createSimulator(config: SimulatorConfig): Promise<AdapterHandle> {
    return new SPISimulator({});
  }
}

class SPISimulator implements AdapterHandle {
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
  private memory: Uint8Array = new Uint8Array(256);

  constructor(private options: AdapterOpenOptions) {
    // Initialize simulated SPI device memory
    for (let i = 0; i < this.memory.length; i++) {
      this.memory[i] = i;
    }
  }

  async write(frame: Uint8Array): Promise<void> {
    this.stats.bytesTx += frame.length;
    this.stats.messagesTx++;

    // Simulate SPI transaction: write command, read response
    setTimeout(() => {
      const response = this.processTransaction(frame);
      const timestamp = process.hrtime.bigint();

      this.stats.bytesRx += response.length;
      this.stats.messagesRx++;

      const meta: RxMeta = {
        timestamp,
        direction: 'rx',
        length: response.length,
      };

      this.readCallbacks.forEach(cb => {
        try {
          cb(response, meta);
        } catch (error) {
          console.error('Error in read callback:', error);
        }
      });
    }, 5);
  }

  private processTransaction(tx: Uint8Array): Uint8Array {
    // Simple SPI memory read/write protocol
    if (tx.length === 0) return new Uint8Array(0);

    const cmd = tx[0];
    if (cmd === 0x03) {
      // Read command: [0x03, addr, dummy...] -> [dummy, dummy, data...]
      const addr = tx[1] || 0;
      const len = tx.length - 2;
      const response = new Uint8Array(len + 2);
      for (let i = 0; i < len; i++) {
        response[i + 2] = this.memory[(addr + i) % this.memory.length];
      }
      return response;
    } else if (cmd === 0x02) {
      // Write command: [0x02, addr, data...]
      const addr = tx[1] || 0;
      for (let i = 2; i < tx.length; i++) {
        this.memory[(addr + i - 2) % this.memory.length] = tx[i];
      }
      return new Uint8Array([0x00]); // Status OK
    }

    // Echo for unknown commands
    return tx;
  }

  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe {
    this.readCallbacks.add(cb);
    return () => {
      this.readCallbacks.delete(cb);
    };
  }

  async setOptions(): Promise<void> {}

  async close(): Promise<void> {
    this.readCallbacks.clear();
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}

// packages/transports-i2c/src/i2c-adapter.ts
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

export class I2CAdapter implements TransportAdapter {
  id = 'i2c';
  name = 'I²C';
  type = 'i2c' as const;

  async listDevices(): Promise<DeviceInfo[]> {
    return [
      {
        id: 'i2c:simulator',
        name: 'I²C Simulator',
        type: 'i2c' as const,
        path: 'simulator',
      },
    ];
  }

  async open(dev: DeviceInfo, options: AdapterOpenOptions): Promise<AdapterHandle> {
    return new I2CSimulator(options);
  }

  supportsSimulation(): boolean {
    return true;
  }

  async createSimulator(config: SimulatorConfig): Promise<AdapterHandle> {
    return new I2CSimulator({});
  }
}

class I2CSimulator implements AdapterHandle {
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
  private devices: Map<number, Uint8Array> = new Map();

  constructor(private options: AdapterOpenOptions) {
    // Simulate some I²C devices
    this.devices.set(0x50, new Uint8Array(256).fill(0xAA)); // EEPROM
    this.devices.set(0x68, new Uint8Array([0x12, 0x34, 0x56, 0x78])); // Sensor
  }

  async write(frame: Uint8Array): Promise<void> {
    this.stats.bytesTx += frame.length;
    this.stats.messagesTx++;

    // I²C frame: [addr, r/w, data...]
    if (frame.length < 2) return;

    const addr = frame[0] >> 1;
    const rw = frame[0] & 0x01;

    if (rw === 1) {
      // Read operation
      const device = this.devices.get(addr);
      if (device) {
        const len = frame[1] || 1;
        const response = device.slice(0, len);
        
        setTimeout(() => {
          const timestamp = process.hrtime.bigint();
          this.stats.bytesRx += response.length;
          this.stats.messagesRx++;

          const meta: RxMeta = {
            timestamp,
            direction: 'rx',
            length: response.length,
            transportSpecific: { i2cAddr: addr },
          };

          this.readCallbacks.forEach(cb => cb(response, meta));
        }, 2);
      }
    }
  }

  read(cb: (chunk: Uint8Array, meta?: RxMeta) => void): Unsubscribe {
    this.readCallbacks.add(cb);
    return () => {
      this.readCallbacks.delete(cb);
    };
  }

  async setOptions(): Promise<void> {}

  async close(): Promise<void> {
    this.readCallbacks.clear();
  }

  async getStats(): Promise<AdapterStats> {
    this.stats.uptime = Date.now() - this.startTime;
    return { ...this.stats };
  }
}