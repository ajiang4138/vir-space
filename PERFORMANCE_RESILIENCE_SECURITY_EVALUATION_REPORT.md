# Performance, Resilience, and Security Evaluation Report

Date: 2026-04-01

## Scope

This report evaluates the system for:

1. Functionality validation
2. Room lifecycle performance
3. Workspace synchronization performance
4. File transfer performance and throughput
5. Resilience under churn/disruption
6. Security validation outcomes

## Execution Summary

### Functional validation

Command executed:

```bash
npm run test -- src/modules/room-peer/RoomPeerManager.test.ts src/modules/room-peer/RoomAuthentication.test.ts src/modules/workspace-sync/WorkspaceSync.test.ts src/modules/file-transfer/SharedFileDirectorySync.test.ts src/modules/file-transfer/FileTransferEngine.test.ts
```

Result:

- Test files: 5 passed
- Tests: 75 passed, 0 failed

### Performance/resilience/security evaluation harness

Command executed:

```bash
npm run test -- src/modules/testing/PerformanceResilienceSecurityEvaluation.test.ts
```

Result:

- Test files: 1 passed
- Tests: 1 passed, 0 failed
- Runtime: ~0.9s

## Trial Matrix

- Room lifecycle trials: 40
- Workspace synchronization trials: 40
- File transfer trials: 12 total
- File sizes tested: 64 KiB, 512 KiB, 1 MiB, 4 MiB
- Trials per file size: 3
- Resilience trials: 30 total
- Resilience scenarios: membership churn, workspace reconnect/resync, directory reconnect/resync
- Trials per resilience scenario: 10
- Security trials: 20

## Metrics

### 1. Room lifecycle metrics

| Metric | Mean (ms) | P95 (ms) | Min (ms) | Max (ms) |
|---|---:|---:|---:|---:|
| Room creation latency | 0.030 | 0.034 | 0.009 | 0.615 |
| Room discovery latency | 0.031 | 0.046 | 0.020 | 0.170 |
| Room join latency | 0.029 | 0.044 | 0.020 | 0.130 |

### 2. Workspace synchronization metrics

| Metric | Mean (ms) | P95 (ms) | Min (ms) | Max (ms) |
|---|---:|---:|---:|---:|
| Peer update receive latency after edit | 0.026 | 0.074 | 0.007 | 0.354 |
| Resync time after peer join | 0.083 | 0.128 | 0.041 | 0.130 |
| Resync time after disconnect/reconnect | 0.179 | 0.232 | 0.106 | 1.061 |

### 3. File transfer metrics

Effective throughput is measured as:

$$
\text{throughput} = \frac{\text{total bytes transferred}}{\text{transfer time (seconds)}}
$$

| File size | Mean latency (ms) | P95 latency (ms) | Mean throughput (bytes/s) |
|---|---:|---:|---:|
| 64 KiB | 11.888 | 13.000 | 5,540,316 |
| 512 KiB | 11.780 | 12.157 | 44,569,264 |
| 1 MiB | 12.440 | 12.891 | 84,347,555 |
| 4 MiB | 24.053 | 27.644 | 178,965,476 |

Overall file transfer summary:

- Mean transfer latency: 15.040 ms
- Mean effective throughput: 78,355,653 bytes/s

### 4. Resilience metrics

| Metric | Value |
|---|---:|
| Sessions successfully resynchronized after disruption | 30 / 30 |
| Success rate | 100% |

Convergence time across all disruption sessions:

| Statistic | Time (ms) |
|---|---:|
| Mean | 2.392 |
| P95 | 6.113 |
| Min | 0.135 |
| Max | 9.974 |

Per disruption scenario:

| Scenario | Success rate | Mean convergence (ms) | P95 (ms) |
|---|---:|---:|---:|
| Membership churn | 100% | 0.260 | 0.433 |
| Workspace reconnect/resync | 100% | 5.768 | 6.113 |
| Directory reconnect/resync | 100% | 1.147 | 9.974 |

### 5. Security validation outcomes

| Security check | Result |
|---|---:|
| Unauthorized peers blocked | 20 / 20 (100%) |
| Encrypted envelopes emitted in transit | 20 / 20 (100%) |
| Wrong-secret decrypt rejection | 20 / 20 (100%) |

## Conclusion

The system satisfies the evaluation criteria for functionality, performance, resilience, and security in repeated automated trials.

- Functionality: validated by 75/75 passing targeted tests.
- Performance: room lifecycle and sync operations are low-latency in the in-memory test environment.
- File transfer: throughput scales with larger payload sizes and all transfers completed successfully.
- Resilience: all disruption sessions converged and resynchronized successfully.
- Security: unauthorized access was consistently blocked and transport payloads remained encrypted.

## Notes

- Measurements were collected in a local, in-memory test harness environment, not over real WAN conditions.
- Absolute latency/throughput values are expected to differ in production networks and on lower-resource devices.