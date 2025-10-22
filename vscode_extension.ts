// apps/vscode-ext/src/extension.ts
import * as vscode from 'vscode';
import { CommWatchPanel } from './panels/CommWatchPanel';
import { DeviceTreeProvider } from './providers/DeviceTreeProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('CommWatch extension activated');

  // Register tree view provider
  const deviceTreeProvider = new DeviceTreeProvider();
  vscode.window.registerTreeDataProvider('commwatchDevices', deviceTreeProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('commwatch.open', () => {
      CommWatchPanel.render(context.extensionUri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commwatch.sendPreset', async () => {
      const presets = ['ADC Read', 'Status Query', 'Config Write'];
      const selected = await vscode.window.showQuickPick(presets, {
        placeHolder: 'Select preset to send',
      });
      
      if (selected && CommWatchPanel.currentPanel) {
        CommWatchPanel.currentPanel.sendPreset(selected);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commwatch.startCapture', () => {
      if (CommWatchPanel.currentPanel) {
        CommWatchPanel.currentPanel.startCapture();
      } else {
        vscode.window.showWarningMessage('Please open CommWatch panel first');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('commwatch.refreshDevices', () => {
      deviceTreeProvider.refresh();
    })
  );
}

export function deactivate() {}

// apps/vscode-ext/src/panels/CommWatchPanel.ts
import * as vscode from 'vscode';
import { getWebviewContent } from '../webview/getWebviewContent';

export class CommWatchPanel {
  public static currentPanel: CommWatchPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;

    this._panel.webview.html = getWebviewContent(
      this._panel.webview,
      extensionUri
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'error':
            vscode.window.showErrorMessage(message.text);
            break;
          case 'info':
            vscode.window.showInformationMessage(message.text);
            break;
          case 'decode-error':
            // Add to problems panel
            this.addProblem(message.error);
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public static render(extensionUri: vscode.Uri) {
    if (CommWatchPanel.currentPanel) {
      CommWatchPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'commwatch',
        'Comm Watch',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(extensionUri, 'out'),
            vscode.Uri.joinPath(extensionUri, 'webview-ui/build'),
          ],
        }
      );

      CommWatchPanel.currentPanel = new CommWatchPanel(panel, extensionUri);
    }
  }

  public sendPreset(presetName: string) {
    this._panel.webview.postMessage({
      type: 'send-preset',
      preset: presetName,
    });
  }

  public startCapture() {
    this._panel.webview.postMessage({
      type: 'start-capture',
    });
  }

  private addProblem(error: any) {
    // Add diagnostic to problems panel
    const collection = vscode.languages.createDiagnosticCollection('commwatch');
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      error.message,
      vscode.DiagnosticSeverity.Error
    );
    collection.set(vscode.Uri.file('commwatch'), [diagnostic]);
  }

  public dispose() {
    CommWatchPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

// apps/vscode-ext/src/webview/getWebviewContent.ts
import * as vscode from 'vscode';

export function getWebviewContent(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'webview-ui', 'build', 'assets', 'index.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'webview-ui', 'build', 'assets', 'index.css')
  );

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" type="text/css" href="${styleUri}">
        <title>Comm Watch</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" src="${scriptUri}"></script>
      </body>
    </html>`;
}

// apps/vscode-ext/src/providers/DeviceTreeProvider.ts
import * as vscode from 'vscode';

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DeviceItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DeviceItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeviceItem): Thenable<DeviceItem[]> {
    if (!element) {
      // Root level - show categories
      return Promise.resolve([
        new DeviceItem('UART Devices', vscode.TreeItemCollapsibleState.Collapsed, 'uart'),
        new DeviceItem('CAN Devices', vscode.TreeItemCollapsibleState.Collapsed, 'can'),
        new DeviceItem('Ethernet', vscode.TreeItemCollapsibleState.Collapsed, 'ethernet'),
      ]);
    } else {
      // TODO: Fetch actual devices from adapters
      return Promise.resolve([
        new DeviceItem(`${element.label} 1`, vscode.TreeItemCollapsibleState.None, element.type!),
      ]);
    }
  }
}

class DeviceItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly type?: string
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
    this.contextValue = type;
  }
}

// apps/vscode-ext/webview-ui/src/App.tsx
import React, { useState, useEffect } from 'react';
import {
  Monitor,
  TxBuilder,
  DecoderView,
  DevicePicker,
  StatsPanel,
} from '@commwatch/ui-kit';
import type { ProtocolFrame, DeviceInfo, AdapterStats } from '@commwatch/proto-core';
import { CommWatchService } from './services/CommWatchService';

const vscode = (window as any).acquireVsCodeApi();

export const App: React.FC = () => {
  const [service] = useState(() => new CommWatchService());
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [frames, setFrames] = useState<ProtocolFrame[]>([]);
  const [stats, setStats] = useState<AdapterStats | null>(null);
  const [displayMode, setDisplayMode] = useState<'hex' | 'ascii' | 'both'>('hex');

  useEffect(() => {
    // Listen for messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'send-preset':
          handlePreset(message.preset);
          break;
        case 'start-capture':
          handleConnect();
          break;
      }
    });

    loadDevices();
  }, []);

  const loadDevices = async () => {
    const devs = await service.listDevices();
    setDevices(devs);
  };

  const handleConnect = async () => {
    if (!selectedDevice) return;

    try {
      await service.connect(selectedDevice, {
        baudRate: 115200,
      });
      
      setIsConnected(true);

      // Subscribe to frames
      service.on('frame', (frame) => {
        setFrames((prev) => [...prev, frame]);
      });

      // Update stats periodically
      const interval = setInterval(async () => {
        const s = await service.getStats();
        setStats(s);
      }, 1000);

      return () => clearInterval(interval);
    } catch (error) {
      vscode.postMessage({
        type: 'error',
        text: `Connection failed: ${error}`,
      });
    }
  };

  const handleDisconnect = async () => {
    await service.disconnect();
    setIsConnected(false);
  };

  const handleSend = async (data: Uint8Array) => {
    try {
      await service.send(data);
    } catch (error) {
      vscode.postMessage({
        type: 'error',
        text: `Send failed: ${error}`,
      });
    }
  };

  const handlePreset = (presetName: string) => {
    // Predefined presets
    const presets: Record<string, string> = {
      'ADC Read': 'AA 01 00 00 5F A3 BB',
      'Status Query': 'AA 02 00 00 C1 84 BB',
      'Config Write': 'AA 03 00 04 12 34 56 78 E2 F1 BB',
    };

    const hexData = presets[presetName];
    if (hexData) {
      const bytes = hexData.split(' ').map(h => parseInt(h, 16));
      handleSend(new Uint8Array(bytes));
    }
  };

  const selectedFrame = frames.length > 0 ? frames[frames.length - 1] : null;

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-white">
      <DevicePicker
        devices={devices}
        selectedDevice={selectedDevice}
        onSelect={setSelectedDevice}
        onRefresh={loadDevices}
        isConnected={isConnected}
      />

      <div className="flex items-center gap-4 p-2 bg-gray-800 border-b border-gray-700">
        <button
          onClick={isConnected ? handleDisconnect : handleConnect}
          disabled={!selectedDevice}
          className={`px-4 py-2 rounded text-white ${
            isConnected
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-green-600 hover:bg-green-700'
          } disabled:opacity-50`}
        >
          {isConnected ? 'Disconnect' : 'Connect'}
        </button>

        <div className="flex gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={displayMode === 'hex'}
              onChange={() => setDisplayMode('hex')}
            />
            Hex
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={displayMode === 'ascii'}
              onChange={() => setDisplayMode('ascii')}
            />
            ASCII
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              checked={displayMode === 'both'}
              onChange={() => setDisplayMode('both')}
            />
            Both
          </label>
        </div>
      </div>

      {stats && <StatsPanel stats={stats} />}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col">
          <Monitor frames={frames} displayMode={displayMode} />
        </div>
        
        <div className="w-96 flex flex-col gap-4 p-4 border-l border-gray-700 overflow-y-auto">
          <TxBuilder
            onSend={handleSend}
            presets={[
              { name: 'ADC Read', data: 'AA 01 00 00 5F A3 BB' },
              { name: 'Status Query', data: 'AA 02 00 00 C1 84 BB' },
            ]}
          />
          
          {selectedFrame && (
            <DecoderView
              frame={selectedFrame.decoded || null}
              raw={selectedFrame.raw}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// apps/vscode-ext/webview-ui/src/services/CommWatchService.ts
import type { DeviceInfo, ProtocolFrame, AdapterStats, AdapterOpenOptions } from '@commwatch/proto-core';

export class CommWatchService {
  private listeners: Map<string, Set<Function>> = new Map();
  private frameId = 0;
  private mockAdapter: any = null;
  private mockStats: AdapterStats = {
    bytesRx: 0,
    bytesTx: 0,
    messagesRx: 0,
    messagesTx: 0,
    errors: 0,
    uptime: 0,
  };
  private startTime = Date.now();

  async listDevices(): Promise<DeviceInfo[]> {
    // Mock devices for webview
    return [
      {
        id: 'uart:COM5',
        name: 'STM32 Nucleo (COM5)',
        type: 'uart',
        path: 'COM5',
      },
      {
        id: 'can:vcan0',
        name: 'Virtual CAN (vcan0)',
        type: 'can',
        path: 'vcan0',
      },
      {
        id: 'eth:udp',
        name: 'Ethernet UDP',
        type: 'ethernet',
        path: 'eth0',
      },
    ];
  }

  async connect(device: DeviceInfo, options: AdapterOpenOptions): Promise<void> {
    // Simulate connection
    this.mockAdapter = { device, options };
    this.startTime = Date.now();
    
    // Simulate incoming frames
    this.simulateTraffic();
  }

  async disconnect(): Promise<void> {
    this.mockAdapter = null;
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.mockAdapter) {
      throw new Error('Not connected');
    }

    this.mockStats.bytesTx += data.length;
    this.mockStats.messagesTx++;

    // Echo back in loopback mode
    setTimeout(() => {
      this.emitFrame({
        id: `frame-${this.frameId++}`,
        timestamp: BigInt(Date.now() * 1_000_000),
        direction: 'rx',
        raw: data,
      });
    }, 100);
  }

  async getStats(): Promise<AdapterStats> {
    this.mockStats.uptime = Date.now() - this.startTime;
    return { ...this.mockStats };
  }

  on(event: string, callback: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  private emit(event: string, data: any): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach(cb => cb(data));
    }
  }

  private emitFrame(frame: ProtocolFrame): void {
    this.emit('frame', frame);
  }

  private simulateTraffic(): void {
    if (!this.mockAdapter) return;

    const interval = setInterval(() => {
      if (!this.mockAdapter) {
        clearInterval(interval);
        return;
      }

      // Generate sample EFuse frame
      const adcValue = 2048 + Math.floor(Math.sin(Date.now() / 1000) * 500);
      const payload = new Uint8Array([
        (adcValue >> 8) & 0xFF,
        adcValue & 0xFF,
      ]);

      const type = 0x01;
      const length = 2;
      const crcData = new Uint8Array([type, 0x00, length, ...payload]);
      const crc = this.calculateCrc16(crcData);

      const frame = new Uint8Array([
        0xAA,
        type,
        0x00,
        length,
        ...payload,
        (crc >> 8) & 0xFF,
        crc & 0xFF,
        0xBB,
      ]);

      this.mockStats.bytesRx += frame.length;
      this.mockStats.messagesRx++;

      this.emitFrame({
        id: `frame-${this.frameId++}`,
        timestamp: BigInt(Date.now() * 1_000_000),
        direction: 'rx',
        raw: frame,
      });
    }, 500);
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
}

// apps/vscode-ext/package.json
{
  "name": "commwatch-vscode",
  "displayName": "CommWatch",
  "description": "Cross-platform communication watch window for UART, SPI, I²C, CAN, and Ethernet",
  "version": "0.1.0",
  "engines": {
    "vscode": "^1.80.0"
  },
  "categories": [
    "Other"
  ],
  "activationEvents": [
    "onCommand:commwatch.open"
  ],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "commwatch.open",
        "title": "CommWatch: Open",
        "category": "CommWatch"
      },
      {
        "command": "commwatch.sendPreset",
        "title": "CommWatch: Send Preset",
        "category": "CommWatch"
      },
      {
        "command": "commwatch.startCapture",
        "title": "CommWatch: Start Capture",
        "category": "CommWatch"
      },
      {
        "command": "commwatch.refreshDevices",
        "title": "CommWatch: Refresh Devices",
        "category": "CommWatch"
      }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "commwatch",
          "title": "CommWatch",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "commwatch": [
        {
          "id": "commwatchDevices",
          "name": "Devices"
        }
      ]
    },
    "menus": {
      "view/title": [
        {
          "command": "commwatch.refreshDevices",
          "when": "view == commwatchDevices",
          "group": "navigation"
        }
      ]
    }
  },
  "scripts": {
    "vscode:prepublish": "pnpm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "pretest": "pnpm run compile",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.80.0",
    "@types/node": "^18.x",
    "@vscode/vsce": "^2.19.0",
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "@commwatch/proto-core": "workspace:*",
    "@commwatch/ui-kit": "workspace:*"
  }
}