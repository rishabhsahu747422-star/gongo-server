# Production Database Recovery & Backup Runbook

## Overview
The GONGO platform operates a single shared PostgreSQL database across Customer, Partner, and Admin domains. Because financial balances, immutable ledgers, and KYC records are authoritative in this database, strict backup, point-in-time recovery (PITR), and disaster recovery procedures are mandatory.

---

## 1. Backup Strategy

### Continuous Archiving & WAL Streaming
- **Engine**: PostgreSQL 16+ on managed cloud infrastructure (AWS RDS PostgreSQL or Aurora).
- **WAL Archiving**: Write-Ahead Logging (WAL) is continuously archived to dedicated, immutable S3 buckets with Object Lock enabled.
- **RPO (Recovery Point Objective)**: `< 5 minutes` via continuous WAL streaming.
- **RTO (Recovery Time Objective)**: `< 30 minutes` for automated failover / snapshot restoration.

### Snapshot Schedule
1. **Daily Automated Snapshots**: Full storage-level snapshot taken daily during off-peak hours (03:00 UTC).
2. **Pre-Migration Snapshots**: Manual point-in-time snapshot created before running any migration batch.
3. **Retention**:
   - Continuous WAL logs: 35 days.
   - Daily snapshots: 35 days.
   - Weekly snapshots: 12 weeks.
   - Monthly snapshots: 12 months.

---

## 2. Point-in-Time Recovery (PITR) Procedure

In the event of accidental data modification or corruption:

1. **Identify Target Timestamp**:
   - Inspect application logs, audit logs, and `outbox_events` timestamps to find the exact target point-in-time (`target_time`) prior to the corruption incident.
2. **Launch Restored Instance**:
   - Provision a new PostgreSQL instance restored to `target_time`.
   - Never overwrite the existing production cluster in-place without preserving current disks.
3. **Verify Restored State**:
   - Run the platform reconciliation audit:
     ```bash
     curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://partner-api.gongo.in/api/v1/admin/financials/reconciliation
     ```
   - Confirm that wallet balances match immutable ledger transaction totals:
     `available_balance = sum(CREDIT) - sum(DEBIT)`.
4. **Switch Application Endpoints**:
   - Update `DATABASE_URL` in secrets manager (e.g., AWS Secrets Manager).
   - Initiate graceful restart across all container instances.

---

## 3. Disaster Recovery & Restore Testing

- **Quarterly Drill**: Conduct simulated recovery drills once every quarter in a staging environment.
- **Verification Criteria**:
  - Restored database passes all 37 migrations without error.
  - Deterministic migration ordering is validated (`npm test tests/integration/database/migrations.test.js`).
  - Zero financial discrepancies reported by the reconciliation engine.

---

## 4. Migration Invariant Rules

1. **Forward-Only Schema Evolution**: Production deployments never run destructive `down` migrations. Deprecated columns must be phased out in multi-step releases.
2. **Safe Defaults**: All `ADD COLUMN` operations must provide safe defaults or be nullable to prevent full-table locks.
3. **Concurrent Indexing**: Production indexes on large tables must use `CREATE INDEX CONCURRENTLY` where appropriate.
