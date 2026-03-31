export interface EvaluationReport {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
}

export function summarizeEvaluation(report: EvaluationReport): string {
  return `${report.suite}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
}
