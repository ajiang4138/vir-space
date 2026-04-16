export interface MetricRecord {
  timestampMs: number;
  eventType: string;
  [key: string]: unknown;
}

export interface MetricsSessionInfo {
  runId: string;
  peerFileId: string;
  logDirPath: string;
  logFilePath: string;
}

class MetricsLogger {
  private session: MetricsSessionInfo | null = null;
  private pendingInit: Promise<MetricsSessionInfo> | null = null;

  getSession(): MetricsSessionInfo | null {
    return this.session;
  }

  async initSession(runId: string, peerFileId: string): Promise<MetricsSessionInfo> {
    if (this.session && this.session.runId === runId && this.session.peerFileId === peerFileId) {
      return this.session;
    }

    if (this.pendingInit) {
      return this.pendingInit;
    }

    this.pendingInit = window.electronApi.initMetricsSession(runId, peerFileId)
      .then((nextSession) => {
        this.session = nextSession;
        return nextSession;
      })
      .finally(() => {
        this.pendingInit = null;
      });

    return this.pendingInit;
  }

  async log(eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
    if (!this.session) {
      return;
    }

    const record: MetricRecord = {
      timestampMs: Date.now(),
      eventType,
      ...payload,
    };

    try {
      await window.electronApi.appendMetricsRecord(record);
    } catch (error) {
      console.error("metrics append failed", error);
    }
  }

  async openLogFolder(): Promise<void> {
    try {
      await window.electronApi.openMetricsFolder();
    } catch (error) {
      console.error("failed to open metrics folder", error);
    }
  }
}

export const metricsLogger = new MetricsLogger();
