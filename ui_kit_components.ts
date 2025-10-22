// packages/ui-kit/src/components/Monitor.tsx
import React, { useEffect, useRef, useState } from 'react';
import type { ProtocolFrame } from '@commwatch/proto-core';

interface MonitorProps {
  frames: ProtocolFrame[];
  displayMode: 'hex' | 'ascii' | 'both';
  maxLines?: number;
}

export const Monitor: React.FC<MonitorProps> = ({ 
  frames, 
  displayMode, 
  maxLines = 1000 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [frames, autoScroll]);

  const formatHex = (data: Uint8Array): string => {
    return Array.from(data)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
  };

  const formatAscii = (data: Uint8Array): string => {
    return Array.from(data)
      .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
      .join('');
  };

  const formatTimestamp = (ts: bigint): string => {
    const ms = Number(ts) / 1_000_000;
    return new Date(ms).toISOString().substr(11, 12);
  };

  const displayedFrames = frames.slice(-maxLines);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-800">
        <div className="flex gap-2">
          <span className="text-sm text-gray-400">
            {frames.length} frames
          </span>
          {frames.length > maxLines && (
            <span className="text-sm text-yellow-400">
              (showing last {maxLines})
            </span>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          Auto-scroll
        </label>
      </div>
      
      <div
        ref={containerRef}
        className="flex-1 overflow-auto font-mono text-sm bg-gray-900 p-2"
      >
        {displayedFrames.map((frame, idx) => (
          <div
            key={frame.id}
            className={`py-1 px-2 ${
              frame.direction === 'tx' ? 'text-blue-400' : 'text-green-400'
            } ${frame.error ? 'bg-red-900/20' : ''}`}
          >
            <span className="text-gray-500 mr-2">
              {formatTimestamp(frame.timestamp)}
            </span>
            <span className="text-gray-400 mr-2">
              {frame.direction === 'tx' ? '→' : '←'}
            </span>
            <span className="mr-2">
              [{frame.raw.length}]
            </span>
            {(displayMode === 'hex' || displayMode === 'both') && (
              <span className="mr-4">{formatHex(frame.raw)}</span>
            )}
            {(displayMode === 'ascii' || displayMode === 'both') && (
              <span className="text-gray-500">{formatAscii(frame.raw)}</span>
            )}
            {frame.error && (
              <span className="ml-2 text-red-400">
                ⚠ {frame.error.message}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// packages/ui-kit/src/components/TxBuilder.tsx
import React, { useState } from 'react';

interface Preset {
  name: string;
  data: string;
}

interface TxBuilderProps {
  onSend: (data: Uint8Array) => void;
  presets?: Preset[];
}

export const TxBuilder: React.FC<TxBuilderProps> = ({ onSend, presets = [] }) => {
  const [hexInput, setHexInput] = useState('');
  const [periodicMs, setPeriodicMs] = useState(0);
  const [intervalId, setIntervalId] = useState<NodeJS.Timeout | null>(null);

  const parseHex = (hex: string): Uint8Array | null => {
    const cleaned = hex.replace(/\s/g, '');
    if (cleaned.length % 2 !== 0) return null;
    
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < cleaned.length; i += 2) {
      const byte = parseInt(cleaned.substr(i, 2), 16);
      if (isNaN(byte)) return null;
      bytes[i / 2] = byte;
    }
    return bytes;
  };

  const handleSend = () => {
    const data = parseHex(hexInput);
    if (data) {
      onSend(data);
    }
  };

  const handlePeriodic = () => {
    if (intervalId) {
      clearInterval(intervalId);
      setIntervalId(null);
    } else if (periodicMs > 0) {
      const id = setInterval(() => {
        const data = parseHex(hexInput);
        if (data) onSend(data);
      }, periodicMs);
      setIntervalId(id);
    }
  };

  const loadPreset = (preset: Preset) => {
    setHexInput(preset.data);
  };

  return (
    <div className="flex flex-col gap-4 p-4 bg-gray-800 rounded">
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Hex Data
        </label>
        <textarea
          value={hexInput}
          onChange={(e) => setHexInput(e.target.value)}
          placeholder="AA 01 00 02 12 34 5F A3 BB"
          className="w-full h-24 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white font-mono"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSend}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
        >
          Send
        </button>
        
        <input
          type="number"
          value={periodicMs}
          onChange={(e) => setPeriodicMs(parseInt(e.target.value) || 0)}
          placeholder="Interval (ms)"
          className="w-32 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
        />
        
        <button
          onClick={handlePeriodic}
          className={`px-4 py-2 rounded text-white ${
            intervalId ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
          }`}
        >
          {intervalId ? 'Stop' : 'Start Periodic'}
        </button>
      </div>

      {presets.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Presets
          </label>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset, idx) => (
              <button
                key={idx}
                onClick={() => loadPreset(preset)}
                className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm"
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// packages/ui-kit/src/components/DecoderView.tsx
import React from 'react';
import type { DecodedFrame, FrameField } from '@commwatch/proto-core';

interface DecoderViewProps {
  frame: DecodedFrame | null;
  raw: Uint8Array;
}

export const DecoderView: React.FC<DecoderViewProps> = ({ frame, raw }) => {
  const formatHex = (data: Uint8Array): string => {
    return Array.from(data)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  };

  const formatValue = (field: FrameField): string => {
    if (field.type === 'bytes') {
      return formatHex(field.value as Uint8Array);
    }
    return String(field.value);
  };

  if (!frame) {
    return (
      <div className="p-4 bg-gray-800 rounded">
        <p className="text-gray-400">No decoded data available</p>
        <div className="mt-2 font-mono text-sm text-gray-500">
          Raw: {formatHex(raw)}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 bg-gray-800 rounded">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">
          {frame.protocol.toUpperCase()} Frame
        </h3>
        {frame.checksum && (
          <div
            className={`px-3 py-1 rounded text-sm ${
              frame.checksum.valid
                ? 'bg-green-900/30 text-green-400'
                : 'bg-red-900/30 text-red-400'
            }`}
          >
            CRC: {frame.checksum.valid ? '✓' : '✗'}
            {!frame.checksum.valid && (
              <span className="ml-2 text-xs">
                (exp: 0x{frame.checksum.expected.toString(16)}, 
                got: 0x{frame.checksum.calculated.toString(16)})
              </span>
            )}
          </div>
        )}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700">
            <th className="text-left py-2 text-gray-400">Field</th>
            <th className="text-left py-2 text-gray-400">Value</th>
            <th className="text-left py-2 text-gray-400">Type</th>
            <th className="text-left py-2 text-gray-400">Unit</th>
          </tr>
        </thead>
        <tbody>
          {frame.fields.map((field, idx) => (
            <tr key={idx} className="border-b border-gray-700/50">
              <td className="py-2 text-white font-medium">{field.name}</td>
              <td className="py-2 text-gray-300 font-mono">
                {formatValue(field)}
              </td>
              <td className="py-2 text-gray-500">{field.type}</td>
              <td className="py-2 text-gray-500">{field.unit || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2">
        <div className="text-xs text-gray-500">Raw Bytes:</div>
        <div className="font-mono text-xs text-gray-400 mt-1">
          {formatHex(raw)}
        </div>
      </div>
    </div>
  );
};

// packages/ui-kit/src/components/DevicePicker.tsx
import React, { useEffect, useState } from 'react';
import type { DeviceInfo, TransportType } from '@commwatch/proto-core';

interface DevicePickerProps {
  devices: DeviceInfo[];
  selectedDevice: DeviceInfo | null;
  onSelect: (device: DeviceInfo | null) => void;
  onRefresh: () => void;
  isConnected: boolean;
}

export const DevicePicker: React.FC<DevicePickerProps> = ({
  devices,
  selectedDevice,
  onSelect,
  onRefresh,
  isConnected,
}) => {
  return (
    <div className="flex items-center gap-2 p-2 bg-gray-800 border-b border-gray-700">
      <label className="text-sm text-gray-400">Device:</label>
      <select
        value={selectedDevice?.id || ''}
        onChange={(e) => {
          const device = devices.find(d => d.id === e.target.value);
          onSelect(device || null);
        }}
        disabled={isConnected}
        className="px-3 py-1 bg-gray-900 border border-gray-700 rounded text-white disabled:opacity-50"
      >
        <option value="">Select device...</option>
        {devices.map(device => (
          <option key={device.id} value={device.id}>
            {device.name} ({device.type})
          </option>
        ))}
      </select>

      <button
        onClick={onRefresh}
        disabled={isConnected}
        className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm disabled:opacity-50"
      >
        Refresh
      </button>

      <div className="ml-auto flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-gray-600'}`} />
        <span className="text-sm text-gray-400">
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </div>
  );
};

// packages/ui-kit/src/components/StatsPanel.tsx
import React from 'react';
import type { AdapterStats } from '@commwatch/proto-core';

interface StatsPanelProps {
  stats: AdapterStats | null;
}

export const StatsPanel: React.FC<StatsPanelProps> = ({ stats }) => {
  if (!stats) return null;

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4 bg-gray-800 rounded">
      <div>
        <div className="text-xs text-gray-500">RX</div>
        <div className="text-lg font-semibold text-green-400">
          {stats.messagesRx}
        </div>
        <div className="text-xs text-gray-400">{formatBytes(stats.bytesRx)}</div>
      </div>

      <div>
        <div className="text-xs text-gray-500">TX</div>
        <div className="text-lg font-semibold text-blue-400">
          {stats.messagesTx}
        </div>
        <div className="text-xs text-gray-400">{formatBytes(stats.bytesTx)}</div>
      </div>

      <div>
        <div className="text-xs text-gray-500">Errors</div>
        <div className="text-lg font-semibold text-red-400">
          {stats.errors}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-500">Rate</div>
        <div className="text-lg font-semibold text-white">
          {stats.uptime > 0 
            ? `${Math.round((stats.messagesRx / stats.uptime) * 1000)} msg/s`
            : '0 msg/s'}
        </div>
      </div>

      <div>
        <div className="text-xs text-gray-500">Uptime</div>
        <div className="text-lg font-semibold text-white">
          {formatUptime(stats.uptime)}
        </div>
      </div>
    </div>
  );
};

// packages/ui-kit/src/components/FilterPanel.tsx
import React, { useState } from 'react';

export interface FilterRule {
  type: 'regex' | 'pattern' | 'field';
  value: string;
  action: 'show' | 'hide' | 'colorize';
  color?: string;
}

interface FilterPanelProps {
  filters: FilterRule[];
  onFiltersChange: (filters: FilterRule[]) => void;
}

export const FilterPanel: React.FC<FilterPanelProps> = ({ filters, onFiltersChange }) => {
  const [newFilter, setNewFilter] = useState<FilterRule>({
    type: 'regex',
    value: '',
    action: 'show',
  });

  const addFilter = () => {
    if (newFilter.value) {
      onFiltersChange([...filters, newFilter]);
      setNewFilter({ type: 'regex', value: '', action: 'show' });
    }
  };

  const removeFilter = (idx: number) => {
    onFiltersChange(filters.filter((_, i) => i !== idx));
  };

  return (
    <div className="flex flex-col gap-4 p-4 bg-gray-800 rounded">
      <h3 className="text-lg font-semibold text-white">Filters</h3>

      <div className="flex gap-2">
        <select
          value={newFilter.type}
          onChange={(e) => setNewFilter({ ...newFilter, type: e.target.value as any })}
          className="px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
        >
          <option value="regex">Regex</option>
          <option value="pattern">Pattern</option>
          <option value="field">Field</option>
        </select>

        <input
          type="text"
          value={newFilter.value}
          onChange={(e) => setNewFilter({ ...newFilter, value: e.target.value })}
          placeholder="Filter value..."
          className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
        />

        <select
          value={newFilter.action}
          onChange={(e) => setNewFilter({ ...newFilter, action: e.target.value as any })}
          className="px-3 py-2 bg-gray-900 border border-gray-700 rounded text-white"
        >
          <option value="show">Show</option>
          <option value="hide">Hide</option>
          <option value="colorize">Colorize</option>
        </select>

        <button
          onClick={addFilter}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
        >
          Add
        </button>
      </div>

      <div className="space-y-2">
        {filters.map((filter, idx) => (
          <div key={idx} className="flex items-center gap-2 p-2 bg-gray-900 rounded">
            <span className="text-gray-400 text-sm">{filter.type}:</span>
            <span className="text-white font-mono flex-1">{filter.value}</span>
            <span className="text-gray-500 text-sm">→ {filter.action}</span>
            <button
              onClick={() => removeFilter(idx)}
              className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// packages/ui-kit/src/index.ts
export { Monitor } from './components/Monitor';
export { TxBuilder } from './components/TxBuilder';
export { DecoderView } from './components/DecoderView';
export { DevicePicker } from './components/DevicePicker';
export { StatsPanel } from './components/StatsPanel';
export { FilterPanel } from './components/FilterPanel';
export type { FilterRule } from './components/FilterPanel';