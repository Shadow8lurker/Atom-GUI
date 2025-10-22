// apps/desktop/src/main/index.ts
import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import { CommWatchBackend } from './backend';

let mainWindow: BrowserWindow | null = null;
let backend: CommWatchBackend | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  backend = new CommWatchBackend(mainWindow);
  setupIpcHandlers();
  createMenu();
}

function setupIpcHandlers() {
  ipcMain.handle('list-devices', async () => {
    return backend?.listDevices();
  });

  ipcMain.handle('connect', async (_, device, options) => {
    return backend?.connect(device, options);
  });

  ipcMain.handle('disconnect', async () => {
    return backend?.disconnect();
  });

  ipcMain.handle('send', async (_, data) => {
    return backend?.send(data);
  });

  ipcMain.handle('get-stats', async () => {
    return backend?.getStats();
  });

  ipcMain.handle('export-log', async (_, format, filepath) => {
    return backend?.exportLog(format, filepath);
  });
}

function createMenu() {
  const template: any = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Session',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu-open-session');
          },
        },
        {
          label: 'Save Session',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('menu-save-session');
          },
        },
        { type: 'separator' },
        {
          label: 'Export Log',
          submenu: [
            { label: 'CSV', click: () => exportLog('csv') },
            { label: 'JSON', click: () => exportLog('json') },
            { label: 'PCAP-NG', click: () => exportLog('pcapng') },
          ],
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Device',
      submenu: [
        {
          label: 'Connect',
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            mainWindow?.webContents.send('menu-connect');
          },
        },
        {
          label: 'Disconnect',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            mainWindow?.webContents.send('menu-disconnect');
          },
        },
        { type: 'separator' },
        {
          label: 'Refresh Devices',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            mainWindow?.webContents.send('menu-refresh-devices');
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function exportLog(format: string) {
  mainWindow?.webContents.send('menu-export-log', format);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// apps/desktop/src/main/backend.ts
import { BrowserWindow } from 'electron';
import type {
  DeviceInfo,
  AdapterHandle,
  AdapterOpenOptions,
  AdapterStats,
  ProtocolFrame,
} from '@commwatch/proto-core';
import { UARTAdapter } from '@commwatch/transports-uart';
import { CANAdapter } from '@commwatch/transports-can';
import { EthernetAdapter } from '@commwatch/transports-eth';
import { SPIAdapter } from '@commwatch/transports-spi';
import { I2CAdapter } from '@commwatch/transports-i2c';
import { EFuseDecoder } from '@commwatch/decoders';
import * as fs from 'fs/promises';

export class CommWatchBackend {
  private adapters: Map<string, any> = new Map();
  private currentHandle: AdapterHandle | null = null;
  private frames: ProtocolFrame[] = [];
  private decoder = new EFuseDecoder();
  private frameId = 0;

  constructor(private window: BrowserWindow) {
    this.adapters.set('uart', new UARTAdapter());
    this.adapters.set('can', new CANAdapter());
    this.adapters.set('ethernet', new EthernetAdapter());
    this.adapters.set('spi', new SPIAdapter());
    this.adapters.set('i2c', new I2CAdapter());
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const allDevices: DeviceInfo[] = [];
    
    for (const [type, adapter] of this.adapters) {
      try {
        const devices = await adapter.listDevices();
        allDevices.push(...devices);
      } catch (error) {
        console.error(`Failed to list ${type} devices:`, error);
      }
    }

    return allDevices;
  }

  async connect(device: DeviceInfo, options: AdapterOpenOptions): Promise<void> {
    const adapter = this.adapters.get(device.type);
    if (!adapter) {
      throw new Error(`Unknown adapter type: ${device.type}`);
    }

    this.currentHandle = await adapter.open(device, options);

    // Subscribe to incoming data
    this.currentHandle.read((chunk, meta) => {
      const frame: ProtocolFrame = {
        id: `frame-${this.frameId++}`,
        timestamp: meta?.timestamp || BigInt(Date.now() * 1_000_000),
        direction: meta?.direction || 'rx',
        raw: chunk,
      };

      // Try to decode
      try {
        const decoded = this.decoder.decode(chunk);
        if (decoded) {
          frame.decoded = decoded;
        }

        const error = this.decoder.validate(chunk);
        if (error) {
          frame.error = error;
        }
      } catch (err) {
        console.error('Decode error:', err);
      }

      this.frames.push(frame);

      // Send to renderer
      this.window.webContents.send('frame-received', frame);
    });
  }

  async disconnect(): Promise<void> {
    if (this.currentHandle) {
      await this.currentHandle.close();
      this.currentHandle = null;
    }
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.currentHandle) {
      throw new Error('Not connected');
    }

    await this.currentHandle.write(data);

    // Add to frames
    const frame: ProtocolFrame = {
      id: `frame-${this.frameId++}`,
      timestamp: BigInt(Date.now() * 1_000_000),
      direction: 'tx',
      raw: data,
    };

    this.frames.push(frame);
    this.window.webContents.send('frame-received', frame);
  }

  async getStats(): Promise<AdapterStats | null> {
    if (!this.currentHandle) {
      return null;
    }

    return this.currentHandle.getStats();
  }

  async exportLog(format: 'csv' | 'json' | 'pcapng', filepath: string): Promise<void> {
    switch (format) {
      case 'csv':
        await this.exportCsv(filepath);
        break;
      case 'json':
        await this.exportJson(filepath);
        break;
      case 'pcapng':
        await this.exportPcapng(filepath);
        break;
    }
  }

  private async exportCsv(filepath: string): Promise<void> {
    const lines = ['Timestamp,Direction,Length,Hex'];
    
    for (const frame of this.frames) {
      const ts = Number(frame.timestamp) / 1_000_000;
      const hex = Array.from(frame.raw).map(b => b.toString(16).padStart(2, '0')).join(' ');
      lines.push(`${ts},${frame.direction},${frame.raw.length},"${hex}"`);
    }

    await fs.writeFile(filepath, lines.join('\n'));
  }

  private async exportJson(filepath: string): Promise<void> {
    const data = {
      version: '1.0',
      frames: this.frames.map(f => ({
        id: f.id,
        timestamp: f.timestamp.toString(),
        direction: f.direction,
        raw: Array.from(f.raw),
        decoded: f.decoded,
        error: f.error,
      })),
    };

    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
  }

  private async exportPcapng(filepath: string): Promise<void> {
    // Simplified PCAP-NG export (real implementation would use proper library)
    console.log('PCAP-NG export not yet implemented');
  }
}

// apps/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  listDevices: () => ipcRenderer.invoke('list-devices'),
  connect: (device: any, options: any) => ipcRenderer.invoke('connect', device, options),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  send: (data: Uint8Array) => ipcRenderer.invoke('send', data),
  getStats: () => ipcRenderer.invoke('get-stats'),
  exportLog: (format: string, filepath: string) => ipcRenderer.invoke('export-log', format, filepath),
  
  onFrameReceived: (callback: (frame: any) => void) => {
    ipcRenderer.on('frame-received', (_, frame) => callback(frame));
  },
  
  onMenuAction: (action: string, callback: () => void) => {
    ipcRenderer.on(`menu-${action}`, callback);
  },
});

// apps/cli/src/index.ts
import { Command } from 'commander';
import { RecordCommand } from './commands/record';
import { ReplayCommand } from './commands/replay';
import { MonitorCommand } from './commands/monitor';

const program = new Command();

program
  .name('commwatch')
  .description('CLI tool for communication monitoring and replay')
  .version('0.1.0');

program
  .command('record')
  .description('Record communication session')
  .requiredOption('--proto <protocol>', 'Protocol (uart, spi, i2c, can, ethernet)')
  .requiredOption('--out <file>', 'Output file')
  .option('--port <port>', 'Serial port')
  .option('--baud <rate>', 'Baud rate', '115200')
  .option('--iface <interface>', 'Network interface or CAN interface')
  .option('--duration <seconds>', 'Recording duration', '60')
  .action(RecordCommand);

program
  .command('replay')
  .description('Replay recorded session')
  .requiredOption('--in <file>', 'Input file')
  .requiredOption('--proto <protocol>', 'Protocol')
  .option('--port <port>', 'Serial port')
  .option('--iface <interface>', 'Network interface or CAN interface')
  .option('--speed <multiplier>', 'Playback speed multiplier', '1.0')
  .action(ReplayCommand);

program
  .command('monitor')
  .description('Monitor live traffic')
  .requiredOption('--proto <protocol>', 'Protocol')
  .option('--port <port>', 'Serial port')
  .option('--baud <rate>', 'Baud rate', '115200')
  .option('--iface <interface>', 'Network interface')
  .option('--filter <pattern>', 'Filter pattern')
  .action(MonitorCommand);

program.parse();

// apps/cli/src/commands/record.ts
import * as fs from 'fs/promises';
import { UARTAdapter } from '@commwatch/transports-uart';
import { CANAdapter } from '@commwatch/transports-can';
import { EthernetAdapter } from '@commwatch/transports-eth';
import type { ProtocolFrame } from '@commwatch/proto-core';

export async function RecordCommand(options: any) {
  console.log(`Recording ${options.proto} to ${options.out}...`);

  let adapter: any;
  switch (options.proto) {
    case 'uart':
      adapter = new UARTAdapter();
      break;
    case 'can':
      adapter = new CANAdapter();
      break;
    case 'ethernet':
      adapter = new EthernetAdapter();
      break;
    default:
      console.error(`Unknown protocol: ${options.proto}`);
      process.exit(1);
  }

  const devices = await adapter.listDevices();
  const device = options.port
    ? devices.find((d: any) => d.path === options.port)
    : devices[0];

  if (!device) {
    console.error('No device found');
    process.exit(1);
  }

  const handle = await adapter.open(device, {
    baudRate: parseInt(options.baud),
  });

  const frames: any[] = [];
  let frameId = 0;

  handle.read((chunk: Uint8Array, meta: any) => {
    const frame: ProtocolFrame = {
      id: `frame-${frameId++}`,
      timestamp: meta?.timestamp || BigInt(Date.now() * 1_000_000),
      direction: meta?.direction || 'rx',
      raw: chunk,
    };

    frames.push({
      ...frame,
      timestamp: frame.timestamp.toString(),
      raw: Array.from(frame.raw),
    });

    process.stdout.write('.');
  });

  const duration = parseInt(options.duration) * 1000;
  await new Promise(resolve => setTimeout(resolve, duration));

  await handle.close();

  await fs.writeFile(options.out, JSON.stringify({ version: '1.0', frames }, null, 2));
  console.log(`\nRecorded ${frames.length} frames to ${options.out}`);
}

// apps/cli/src/commands/replay.ts
import * as fs from 'fs/promises';
import { UARTAdapter } from '@commwatch/transports-uart';
import { CANAdapter } from '@commwatch/transports-can';

export async function ReplayCommand(options: any) {
  console.log(`Replaying ${options.in} via ${options.proto}...`);

  const data = JSON.parse(await fs.readFile(options.in, 'utf8'));
  const frames = data.frames;

  let adapter: any;
  switch (options.proto) {
    case 'uart':
      adapter = new UARTAdapter();
      break;
    case 'can':
      adapter = new CANAdapter();
      break;
    default:
      console.error(`Unknown protocol: ${options.proto}`);
      process.exit(1);
  }

  const devices = await adapter.listDevices();
  const device = options.port
    ? devices.find((d: any) => d.path === options.port)
    : devices[0];

  if (!device) {
    console.error('No device found');
    process.exit(1);
  }

  const handle = await adapter.open(device, {});

  const speed = parseFloat(options.speed);
  let lastTs = 0;

  for (const frame of frames) {
    if (frame.direction === 'tx') {
      const ts = parseInt(frame.timestamp);
      if (lastTs > 0) {
        const delay = ((ts - lastTs) / 1_000_000) / speed;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      lastTs = ts;

      const data = new Uint8Array(frame.raw);
      await handle.write(data);
      console.log(`Sent frame ${frame.id}`);
    }
  }

  await handle.close();
  console.log('Replay complete');
}

// apps/cli/src/commands/monitor.ts
import { UARTAdapter } from '@commwatch/transports-uart';
import { EFuseDecoder } from '@commwatch/decoders';

export async function MonitorCommand(options: any) {
  console.log(`Monitoring ${options.proto}...`);

  const adapter = new UARTAdapter();
  const devices = await adapter.listDevices();
  const device = options.port
    ? devices.find(d => d.path === options.port)
    : devices[0];

  if (!device) {
    console.error('No device found');
    process.exit(1);
  }

  const handle = await adapter.open(device, {
    baudRate: parseInt(options.baud),
  });

  const decoder = new EFuseDecoder();

  handle.read((chunk, meta) => {
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ts = new Date().toISOString();
    
    console.log(`[${ts}] ${meta?.direction === 'tx' ? '→' : '←'} ${hex}`);

    const decoded = decoder.decode(chunk);
    if (decoded) {
      console.log('  Decoded:', JSON.stringify(decoded, null, 2));
    }
  });

  // Keep running
  await new Promise(() => {});
}