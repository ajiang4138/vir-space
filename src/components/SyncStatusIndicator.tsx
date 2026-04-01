/**
 * SyncStatusIndicator.tsx
 *
 * React component for displaying synchronization status
 * - Shows real-time sync state
 * - Displays pending operation count
 * - Shows convergence status
 * - Provides visual feedback for sync issues
 */

import type React from 'react';

export interface SyncStatusIndicatorProps {
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error' | 'reconnecting' | 'recovering';
  pendingOperations: number;
  isConverged: boolean;
  localOperationCount?: number;
  remoteOperationCount?: number;
  lastSyncTime?: string;
}

export function SyncStatusIndicator({
  syncStatus,
  pendingOperations,
  isConverged,
  localOperationCount = 0,
  remoteOperationCount = 0,
  lastSyncTime,
}: SyncStatusIndicatorProps): React.ReactElement {
  const getStatusColor = (): string => {
    if (!isConverged) return '#EF4444';
    switch (syncStatus) {
      case 'synced':
        return '#10B981';
      case 'syncing':
        return '#F59E0B';
      case 'pending':
        return '#F97316';
      case 'error':
        return '#EF4444';
      case 'reconnecting':
        return '#F59E0B';
      case 'recovering':
        return '#0EA5E9';
      default:
        return '#6B7280';
    }
  };

  const getStatusText = (): string => {
    if (!isConverged) return 'Diverged';
    if (pendingOperations > 0) return `Pending (${pendingOperations})`;
    switch (syncStatus) {
      case 'synced':
        return 'Synced';
      case 'syncing':
        return 'Syncing...';
      case 'pending':
        return 'Pending...';
      case 'error':
        return 'Error';
      case 'reconnecting':
        return 'Reconnecting...';
      case 'recovering':
        return 'Recovering...';
      default:
        return 'Unknown';
    }
  };

  const getStatusIcon = (): string => {
    if (!isConverged) return '⚠️';
    switch (syncStatus) {
      case 'synced':
        return '✓';
      case 'syncing':
        return '⟳';
      case 'pending':
        return '◯';
      case 'error':
        return '✕';
      case 'reconnecting':
        return '↺';
      case 'recovering':
        return '⇄';
      default:
        return '?';
    }
  };

  return (
    <div className="flex items-center gap-3 bg-white rounded-lg px-4 py-2.5 shadow-sm border border-slate-200">
      {/* Status indicator dot with icon */}
      <div className="relative">
        <div
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: getStatusColor() }}
        />
        {syncStatus === 'syncing' && (
          <div
            className="absolute inset-0 rounded-full animate-pulse"
            style={{ backgroundColor: getStatusColor(), opacity: 0.3 }}
          />
        )}
      </div>

      {/* Status text */}
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-slate-900">
          {getStatusIcon()} {getStatusText()}
        </span>
        {pendingOperations > 0 && (
          <span className="text-xs text-slate-600">
            {pendingOperations} operation{pendingOperations !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Detailed metrics */}
      {(localOperationCount > 0 || remoteOperationCount > 0) && (
        <div className="text-xs text-slate-600 ml-2 pl-2 border-l border-slate-300">
          <span>↑ {localOperationCount}</span>
          {' • '}
          <span>↓ {remoteOperationCount}</span>
        </div>
      )}

      {/* Last sync time */}
      {lastSyncTime && (
        <div className="text-xs text-slate-500 ml-auto">
          {new Date(lastSyncTime).toLocaleTimeString()}
        </div>
      )}

      {/* Tooltip on hover */}
      <div className="hidden group-hover:block absolute top-full mt-2 bg-slate-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-50">
        {!isConverged
          ? 'Workspace state has diverged. Synchronizing...'
          : `Database is ${syncStatus}. ${pendingOperations} operations pending.`}
      </div>
    </div>
  );
}

/**
 * Compact version for status bars
 */
export function SyncStatusBadge({
  syncStatus,
  isConverged,
}: {
  syncStatus: 'synced' | 'syncing' | 'pending' | 'error' | 'reconnecting' | 'recovering';
  isConverged: boolean;
}): React.ReactElement {
  const getBgColor = (): string => {
    if (!isConverged) return 'bg-red-100 text-red-700 border-red-300';
    switch (syncStatus) {
      case 'synced':
        return 'bg-green-100 text-green-700 border-green-300';
      case 'syncing':
        return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'pending':
        return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'error':
        return 'bg-red-100 text-red-700 border-red-300';
      case 'reconnecting':
        return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'recovering':
        return 'bg-sky-100 text-sky-700 border-sky-300';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  const getText = (): string => {
    if (!isConverged) return 'Diverged';
    switch (syncStatus) {
      case 'synced':
        return 'Synced';
      case 'syncing':
        return 'Syncing';
      case 'pending':
        return 'Pending';
      case 'error':
        return 'Error';
      case 'reconnecting':
        return 'Reconnecting';
      case 'recovering':
        return 'Recovering';
      default:
        return 'Unknown';
    }
  };

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getBgColor()}`}>
      {getText()}
    </span>
  );
}
